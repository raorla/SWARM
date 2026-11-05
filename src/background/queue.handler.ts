/**
 * Handlers de la file d'opportunités, pour l'onglet Flux.
 *
 * La file est lue, pas construite ici : `qualify.handler.ts` la remplit. Ce module sert
 * l'affichage et les trois actions de l'utilisateur — rédiger, rejeter, passer.
 *
 * ## Pourquoi la rédaction depuis la file est un chemin distinct de l'overlay
 *
 * L'overlay répond à un clic sur un post précis : l'utilisateur a déjà choisi. La file,
 * elle, propose. Conséquence pratique : le rang EV de l'opportunité est connu, et il pilote
 * l'escalade de modèle du WRITER (SPEC §3.2 — Opus sur le top-10). L'overlay n'a pas cette
 * information et n'escalade jamais.
 */
import { db } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { OpportunityRepo, type QueueEntry } from '@/db/repositories/opportunity.repo'
import { NichePackFileSchema, type NichePack } from '@/niches/pack.schema'
import { bundledPack, FALLBACK_PACK_ID } from '@/niches/loader'
import { runDraftChain, describeChainFailure } from '@/swarm/chain/draft-chain'
import { explainScore, type ExplainedScore } from '@/scoring/explain'
import { computeEv } from '@/scoring/ev'
import { X_REPLY_LIMIT } from '@/swarm/schemas/quick-reply.io'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import type { DraftVariantWire } from '@/messaging/contract'
import type { VoiceProfileRecord } from '@/db/schema'
import { restoreKeystore, buildLlmClient } from './services'
import { BudgetMeter, chromeBudgetStore } from '@/llm/budget'
import { ageMinutes } from '@/scoring/freshness'
import { systemClock, type Clock } from '@/shared/time'
import { createLogger } from '@/shared/logger'

const log = createLogger('background:queue')

/** Voir `qualify.handler.ts` : l'horloge est injectable pour que la file soit testable. */
export interface QueueDeps {
  clock: Clock
}

const defaultDeps: QueueDeps = { clock: systemClock }

async function loadActivePack(clock: Clock): Promise<NichePack> {
  const config = await new ConfigRepo(db(), clock).get()
  const record = await db().nichePacks.get(config.activeNichePackId)
  if (record) {
    const parsed = NichePackFileSchema.safeParse(JSON.parse(record.json))
    if (parsed.success) return parsed.data.pack
  }
  const fallback = bundledPack(config.activeNichePackId) ?? bundledPack(FALLBACK_PACK_ID)
  if (!fallback) throw new Error('aucun pack disponible')
  return fallback
}

/* ─────────────────────────────── Lecture de file ─────────────────────────── */

export interface QueueCard {
  id: number
  postId: string
  authorHandle: string
  text: string
  permalink: string
  ageMinutes: number
  metrics: { replies: number; likes: number; reposts: number }
  evScore: number
  /** Décomposé du score, prêt à afficher (SPEC §6 : « cliquable, explicable »). */
  explanation: ExplainedScore | null
  nichePackId: string
}

export async function listQueue(
  payload: { limit?: number | undefined },
  deps: QueueDeps = defaultDeps,
): Promise<{
  cards: QueueCard[]
  /** Opportunités périmées lors de cette lecture — l'UI peut le signaler. */
  expiredNow: number
}> {
  const clock = deps.clock
  const pack = await loadActivePack(clock)
  const repo = new OpportunityRepo(db(), clock)

  // On purge à la lecture : une file qui ne se vide pas devient un cimetière, et voir des
  // posts de la veille en tête est pire que voir une file vide.
  const { expired } = await repo.expireStale(pack.thresholds.maxAgeMinutes)

  const entries = await repo.queue(payload.limit ?? 30, pack.thresholds.maxAgeMinutes)
  const now = clock.now()

  return {
    cards: entries.map((entry) => toCard(entry, pack, now)),
    expiredNow: expired,
  }
}

function toCard(entry: QueueEntry, pack: NichePack, nowMs: number): QueueCard {
  // On recompose le décomposé depuis les facteurs stockés plutôt que de les recalculer :
  // recalculer donnerait un score différent de celui qui a servi au classement (la fraîcheur
  // a bougé depuis), et l'utilisateur verrait un décomposé qui ne justifie pas le rang.
  const explanation =
    entry.scoreBreakdown === null
      ? null
      : explainScore(
          computeEv(
            {
              reach: entry.scoreBreakdown.reach,
              nicheRelevance: entry.scoreBreakdown.nicheRelevance,
              freshness: entry.scoreBreakdown.freshness,
              saturationInverse: entry.scoreBreakdown.saturation,
              authorAffinity: entry.scoreBreakdown.authorAffinity,
            },
            pack.evWeights,
          ),
        )

  return {
    id: entry.id,
    postId: entry.postId,
    authorHandle: entry.authorHandle,
    text: entry.text,
    permalink: `https://x.com/${entry.authorHandle}/status/${entry.postId}`,
    ageMinutes: ageMinutes({ postedAtMs: entry.postedAtMs, nowMs }),
    metrics: entry.metrics,
    evScore: entry.evScore,
    explanation,
    nichePackId: entry.nichePackId,
  }
}

export async function queueStats(
  deps: QueueDeps = defaultDeps,
): Promise<
  Awaited<ReturnType<OpportunityRepo['stats']>> & { budgetRemainingEur: number }
> {
  const clock = deps.clock
  const pack = await loadActivePack(clock)
  const repo = new OpportunityRepo(db(), clock)
  const stats = await repo.stats(pack.thresholds.maxAgeMinutes)

  const config = await new ConfigRepo(db(), clock).get()
  // Import statique : `services.ts`, importé juste au-dessus, tire déjà ce module. Le rendre
  // dynamique ne déplaçait aucun code dans un autre chunk — Rollup le signalait.
  const budget = await new BudgetMeter(
    chromeBudgetStore(),
    clock,
    config.budget,
  ).snapshot()

  return { ...stats, budgetRemainingEur: budget.remainingEur }
}

/* ──────────────────────────── Rédaction depuis la file ───────────────────── */

export type DraftFromQueueResponse =
  | {
      ok: true
      decision: 'reply'
      opportunityId: number
      variants: DraftVariantWire[]
      selectedIndex: number
      sharedContext: string
      costEur: number
      promptVersionHash: string
      /** Rang EV dans la file — a piloté l'escalade de modèle. */
      evRank: number
      escalated: boolean
    }
  | {
      ok: true
      decision: 'decline'
      opportunityId: number
      reasoning: string
      costEur: number
    }
  | { ok: false; error: string; code?: string }

/** Au-delà de ce rang, pas d'escalade vers le modèle fort (SPEC §3.2). */
const ESCALATION_TOP_N = 10

export async function draftFromQueue(
  payload: { opportunityId: number; hint?: string | undefined },
  deps: QueueDeps = defaultDeps,
): Promise<DraftFromQueueResponse> {
  const clock = deps.clock
  const configRepo = new ConfigRepo(db(), clock)
  if (!(await configRepo.hasConsented())) {
    return { ok: false, error: 'onboarding incomplet', code: 'NO_CONSENT' }
  }

  const keystore = await restoreKeystore(clock)
  if (!(await keystore.isInitialized())) {
    return { ok: false, error: 'aucune clé API configurée', code: 'NO_KEY' }
  }
  if (!keystore.isUnlocked) {
    return { ok: false, error: 'coffre verrouillé', code: 'LOCKED' }
  }

  const repo = new OpportunityRepo(db(), clock)
  const entry = await repo.get(payload.opportunityId)
  if (!entry) {
    return { ok: false, error: 'opportunité introuvable', code: 'NOT_FOUND' }
  }

  const pack = await loadActivePack(clock)
  const config = await configRepo.get()

  // Rang EV dans la file courante : c'est lui qui décide de l'escalade de modèle. Le
  // recalculer ici plutôt que de le stocker évite qu'un rang périmé fasse escalader une
  // opportunité qui a chuté dans le classement depuis.
  const queue = await repo.queue(100, pack.thresholds.maxAgeMinutes)
  const evRank = queue.findIndex((row) => row.id === entry.id) + 1
  const escalated = evRank > 0 && evRank <= ESCALATION_TOP_N

  const profile: VoiceProfileRecord | null =
    (await db().voiceProfile.get('current')) ?? null
  const client = await buildLlmClient(keystore)

  const post: ExtractedPost = {
    postId: entry.postId,
    authorHandle: entry.authorHandle,
    authorDisplayName: null,
    text: entry.text,
    lang: entry.lang,
    postedAtMs: entry.postedAtMs,
    replyCount: entry.metrics.replies,
    likeCount: entry.metrics.likes,
    repostCount: entry.metrics.reposts,
    hasMedia: false,
    hasQuote: false,
    isReply: false,
    isOwnPost: false,
    surface: 'timeline',
    observedAtMs: entry.observedAtMs,
    permalink: `/${entry.authorHandle}/status/${entry.postId}`,
  }

  const result = await runDraftChain(
    {
      post,
      pack,
      profile,
      vetoThreshold: config.criticVetoThreshold,
      ...(payload.hint !== undefined ? { userHint: payload.hint } : {}),
    },
    { client, ...(escalated ? { routeContext: { evRank } } : {}) },
  )

  if (!result.ok) {
    const failure = result.error

    if (failure.kind === 'vetoed' || failure.kind === 'no-angle') {
      // Le CRITIC a tranché : l'opportunité sort de la file avec son motif. Elle n'y
      // reviendra pas — un état terminal, sans quoi elle serait requalifiée et repayée.
      await repo.setStatus(
        entry.id,
        failure.kind === 'vetoed' ? 'rejected-critic' : 'rejected-qualifier',
        describeChainFailure(failure),
      )
      log.info('opportunité écartée depuis la file', {
        opportunityId: entry.id,
        kind: failure.kind,
        costEur: failure.totalCostEur,
      })
      return {
        ok: true,
        decision: 'decline',
        opportunityId: entry.id,
        reasoning: describeChainFailure(failure),
        costEur: failure.totalCostEur,
      }
    }

    return {
      ok: false,
      error: `${failure.stage} : ${describeChainFailure(failure)}`,
      code: 'AGENT',
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

  await db().drafts.add({
    opportunityId: entry.id,
    variants: chain.variants.map((variant, index) => ({
      text: variant.text,
      angle: variant.angle,
      ...(scoreByIndex.get(index)
        ? {
            criticScores: {
              voiceAuthenticity: scoreByIndex.get(index)!.voiceAuthenticity,
              valueAdded: scoreByIndex.get(index)!.valueAdded,
              reputationRisk: scoreByIndex.get(index)!.reputationRisk,
              redundancy: scoreByIndex.get(index)!.redundancy,
              attentionCost: scoreByIndex.get(index)!.attentionCost,
              overall: scoreByIndex.get(index)!.overall,
            },
            criticNotes: scoreByIndex.get(index)!.note,
          }
        : {}),
    })),
    selectedIndex: chain.critic.selectedIndex,
    criticPassed: true,
    criticRejectionReason: null,
    promptVersions: Object.fromEntries(
      chain.trail.map((step) => [step.role, step.promptVersionHash]),
    ),
    createdAtMs: clock.now(),
  })

  await repo.setStatus(entry.id, 'drafted')

  return {
    ok: true,
    decision: 'reply',
    opportunityId: entry.id,
    variants,
    selectedIndex: chain.critic.selectedIndex ?? 0,
    sharedContext: chain.sharedContext,
    costEur: chain.totalCostEur,
    promptVersionHash: chain.promptVersionHash,
    evRank,
    escalated,
  }
}

/**
 * Rejet manuel depuis le Flux.
 *
 * Enregistré avec le motif « rejet humain » distinct du veto du CRITIC : le désaccord entre
 * l'utilisateur et le CRITIC est un signal d'apprentissage gratuit (MH-09), et le confondre
 * avec un veto le rendrait invisible.
 */
export async function rejectOpportunity(
  payload: { opportunityId: number; reason?: string | undefined },
  deps: QueueDeps = defaultDeps,
): Promise<{ ok: true; opportunityId: number } | { ok: false; error: string }> {
  const repo = new OpportunityRepo(db(), deps.clock)
  const entry = await repo.get(payload.opportunityId)
  if (!entry) return { ok: false, error: 'opportunité introuvable' }

  await repo.setStatus(
    entry.id,
    'rejected-qualifier',
    `rejet humain${payload.reason ? ` : ${payload.reason}` : ''}`,
  )
  return { ok: true, opportunityId: entry.id }
}
