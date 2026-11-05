/**
 * Handler de la demande de rédaction (overlay → service worker).
 *
 * Le content script n'a délibérément **aucune** clé API et **aucun** accès au keystore : il
 * partage son contexte JavaScript avec x.com. Toute la rédaction se fait donc ici.
 *
 * ## Ordre des vérifications, et pourquoi
 *
 *   1. consentement       — l'onboarding n'est pas fini, rien ne doit tourner (MH-12)
 *   2. coffre déverrouillé — sans clé, inutile d'aller plus loin
 *   3. topic-guard         — gratuit, et c'est un interdit produit, pas une contrainte de coût
 *   4. auteur exclu        — également gratuit
 *   5. rédaction           — le budget est vérifié par le client, avant tout appel réseau
 *
 * La **cadence n'est pas vérifiée** : l'utilisateur a cliqué un bouton, il attend une
 * réponse. Faire attendre quatre minutes une action explicitement demandée serait appliquer
 * un garde-fou à contretemps — la cadence protège du rythme automatique, pas de l'intention
 * humaine. Les plafonds ne le sont pas non plus : rien n'est publié à cette étape.
 */
import { db } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { classifyTopic } from '@/governor/topic-guard'
import { NichePackFileSchema, type NichePack } from '@/niches/pack.schema'
import { bundledPack, FALLBACK_PACK_ID } from '@/niches/loader'
import { runQuickReply } from '@/swarm/agents/quick-reply'
import { runDraftChain, describeChainFailure } from '@/swarm/chain/draft-chain'
import { X_REPLY_LIMIT } from '@/swarm/schemas/quick-reply.io'
import { describeLlmError } from '@/llm/errors'
import type {
  DraftVariantWire,
  ExtractedPostForReply,
  ReplyGenerationResponse,
} from '@/messaging/contract'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import type { VoiceProfileRecord } from '@/db/schema'
import { restoreKeystore, buildLlmClient } from './services'
import { createLogger } from '@/shared/logger'
import { systemClock, type Clock } from '@/shared/time'

const log = createLogger('background:draft')
/** Horloge injectable (MH-17), comme les autres handlers du service worker. */
export interface DraftDeps {
  clock: Clock
}

const defaultDeps: DraftDeps = { clock: systemClock }

/**
 * Charge le pack actif, avec repli sur le pack livré.
 *
 * Un pack en base illisible ne doit pas rendre le produit muet : on retombe sur `generic`,
 * volontairement restrictif. Se taire est le bon comportement par défaut quand la
 * configuration est cassée — parler de tout serait pire.
 */
async function loadActivePack(clock: Clock): Promise<NichePack> {
  const config = await new ConfigRepo(db(), clock).get()
  const record = await db().nichePacks.get(config.activeNichePackId)

  if (record) {
    const parsed = NichePackFileSchema.safeParse(JSON.parse(record.json))
    if (parsed.success) return parsed.data.pack
    log.warn('pack en base illisible, repli sur generic', {
      id: config.activeNichePackId,
    })
  }

  const bundled = bundledPack(config.activeNichePackId) ?? bundledPack(FALLBACK_PACK_ID)
  if (!bundled) throw new Error('aucun pack disponible, même le pack de repli')
  return bundled
}

async function loadVoiceProfile(): Promise<VoiceProfileRecord | null> {
  return (await db().voiceProfile.get('current')) ?? null
}

export async function handleDraftRequest(
  payload: {
    post: ExtractedPostForReply
    hint?: string | undefined
  },
  deps: DraftDeps = defaultDeps,
): Promise<ReplyGenerationResponse> {
  const { clock } = deps

  /* ── 1. Consentement (MH-12) ───────────────────────────────────────────── */
  const configRepo = new ConfigRepo(db(), clock)
  if (!(await configRepo.hasConsented())) {
    return {
      ok: false,
      error: 'onboarding incomplet — ouvre le side panel pour accepter les conditions',
      code: 'NO_CONSENT',
    }
  }
  const config = await configRepo.get()

  /* ── 2. Coffre ─────────────────────────────────────────────────────────── */
  const keystore = await restoreKeystore(clock)
  if (!(await keystore.isInitialized())) {
    return {
      ok: false,
      error: 'aucune clé API configurée — onglet Config',
      code: 'NO_KEY',
    }
  }
  if (!keystore.isUnlocked) {
    return {
      ok: false,
      error: 'coffre verrouillé — déverrouille-le dans le side panel',
      code: 'LOCKED',
    }
  }

  const pack = await loadActivePack(clock)

  /* ── 3. Topic-guard (MH-02) ────────────────────────────────────────────── */
  // Cliquer n'autorise pas à répondre sur un sujet interdit.
  const verdict = classifyTopic(payload.post.text, pack.additionalBlockedTopics)
  if (verdict.blocked) {
    return {
      ok: true,
      decision: 'decline',
      reasoning: `Sujet écarté par le garde-fou : ${verdict.reasons.join(' · ')}`,
      costEur: 0,
      mode: config.draftMode,
    }
  }

  /* ── 4. Auteur exclu par le pack ───────────────────────────────────────── */
  if (
    pack.blocklist.some(
      (h) =>
        h.replace(/^@/, '').toLowerCase() === payload.post.authorHandle.toLowerCase(),
    )
  ) {
    return {
      ok: true,
      decision: 'decline',
      reasoning: `@${payload.post.authorHandle} est sur la blocklist du pack.`,
      costEur: 0,
      mode: config.draftMode,
    }
  }

  /* ── 5. Rédaction ──────────────────────────────────────────────────────── */
  const client = await buildLlmClient(keystore, clock)
  const post = payload.post as ExtractedPost
  const profile = await loadVoiceProfile()

  return config.draftMode === 'quick-reply'
    ? runReferencePath(client, post, pack, payload.hint, clock)
    : runChainPath(
        client,
        post,
        pack,
        profile,
        config.criticVetoThreshold,
        payload.hint,
        clock,
      )
}

/* ────────────────────────── Chemin de production ─────────────────────────── */

async function runChainPath(
  client: Awaited<ReturnType<typeof buildLlmClient>>,
  post: ExtractedPost,
  pack: NichePack,
  profile: VoiceProfileRecord | null,
  vetoThreshold: number,
  hint: string | undefined,
  clock: Clock,
): Promise<ReplyGenerationResponse> {
  const started = clock.now()
  const result = await runDraftChain(
    {
      post,
      pack,
      profile,
      vetoThreshold,
      ...(hint !== undefined ? { userHint: hint } : {}),
    },
    { client },
  )

  if (!result.ok) {
    const failure = result.error

    // Un veto et une absence d'angle sont des **résultats**, pas des pannes : l'overlay les
    // présente comme tels, et leur coût réel est remonté (MH-05).
    if (failure.kind === 'vetoed' || failure.kind === 'no-angle') {
      log.info('rédaction sans issue', {
        kind: failure.kind,
        costEur: failure.totalCostEur,
      })
      return {
        ok: true,
        decision: 'decline',
        reasoning: describeChainFailure(failure),
        costEur: failure.totalCostEur,
        mode: 'chain',
      }
    }

    const described =
      failure.failure.kind === 'llm'
        ? describeLlmError(failure.failure.error)
        : failure.failure.reason
    log.warn('chaîne en échec', { stage: failure.stage, described })
    return {
      ok: false,
      error: `${failure.stage} : ${described}`,
      code: failure.failure.kind === 'llm' ? failure.failure.error.kind : 'AGENT',
    }
  }

  const chain = result.value
  const scoreByIndex = new Map(chain.critic.scores.map((s) => [s.index, s]))

  const variants: DraftVariantWire[] = chain.variants.map((variant, index) => {
    const score = scoreByIndex.get(index)
    return {
      text: variant.text,
      angle: variant.angle,
      intent: variant.intent,
      voiceDistance: chain.voiceDistances[index] ?? 0.5,
      // On signale le dépassement, on ne tronque pas : couper au caractère 280 amputerait
      // la phrase, et c'est à l'utilisateur d'arbitrer.
      overLimit: variant.text.length > X_REPLY_LIMIT,
      criticScores: score
        ? {
            voiceAuthenticity: score.voiceAuthenticity,
            valueAdded: score.valueAdded,
            reputationRisk: score.reputationRisk,
            redundancy: score.redundancy,
            attentionCost: score.attentionCost,
            overall: score.overall,
            note: score.note,
          }
        : null,
    }
  })

  log.info('brouillons rédigés', {
    postId: post.postId,
    variants: variants.length,
    angleDiversity: chain.angleDiversity,
    selected: chain.critic.selectedIndex,
    costEur: chain.totalCostEur,
  })

  return {
    ok: true,
    decision: 'reply',
    variants,
    selectedIndex: chain.critic.selectedIndex ?? 0,
    sharedContext: chain.sharedContext,
    costEur: chain.totalCostEur,
    latencyMs: clock.now() - started,
    promptVersionHash: chain.promptVersionHash,
    mode: 'chain',
    voiceConfidence: profile?.confidence ?? null,
  }
}

/* ─────────────────────── Chemin de référence (Phase 1) ───────────────────── */

/**
 * Génération one-shot, conservée comme **référence de comparaison**.
 *
 * C'est ce que fait la concurrence. La garder derrière un réglage est la seule façon de
 * mesurer ce que la chaîne WRITER → CRITIC apporte réellement : la supprimer rendrait
 * « le swarm fait mieux » invérifiable, et c'est la thèse du produit.
 */
async function runReferencePath(
  client: Awaited<ReturnType<typeof buildLlmClient>>,
  post: ExtractedPost,
  pack: NichePack,
  hint: string | undefined,
  clock: Clock,
): Promise<ReplyGenerationResponse> {
  const started = clock.now()
  const result = await runQuickReply(client, {
    post,
    pack,
    ...(hint !== undefined ? { userHint: hint } : {}),
  })

  if (!result.ok) {
    if (result.error.kind === 'declined') {
      return {
        ok: true,
        decision: 'decline',
        reasoning: result.error.reason,
        costEur: 0,
        mode: 'quick-reply',
      }
    }
    return {
      ok: false,
      error: describeLlmError(result.error.error),
      code: result.error.error.kind,
    }
  }

  return {
    ok: true,
    decision: 'reply',
    variants: [
      {
        text: result.value.text,
        angle: result.value.angle,
        intent: result.value.reasoning,
        // Pas de profil de voix sur ce chemin : la distance est inconnue, pas nulle.
        voiceDistance: 0.5,
        overLimit: result.value.overLimit,
        // Pas de CRITIC sur ce chemin. C'est exactement ce qui le distingue.
        criticScores: null,
      },
    ],
    selectedIndex: 0,
    sharedContext: result.value.reasoning,
    costEur: result.value.costEur,
    latencyMs: clock.now() - started,
    promptVersionHash: result.value.promptVersionHash,
    mode: 'quick-reply',
    voiceConfidence: null,
  }
}
