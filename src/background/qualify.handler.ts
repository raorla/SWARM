/**
 * Handler du triage — SCOUT → QUALIFIER → file d'opportunités.
 *
 * Le scout envoie des lots de posts observés ; ce handler les trie et remplit la file. C'est
 * le premier chemin du produit qui dépense du budget **sans que l'utilisateur ait cliqué**,
 * donc celui où l'économie doit être la plus stricte.
 *
 * ## Ce qui est filtré AVANT toute dépense
 *
 * Dans cet ordre, et chaque étape est gratuite :
 *
 *  1. **Posts déjà connus** — repayer un triage déjà fait est du gaspillage pur, et le scout
 *     revoit les mêmes posts à chaque passage dans le viewport.
 *  2. **Posts de l'utilisateur** — on ne se répond pas à soi-même.
 *  3. **Sujets interdits** (MH-02) — gratuit, déterministe, et c'est un interdit produit.
 *  4. **Auteurs sur blocklist**.
 *  5. **Posts périmés ou saturés** — les seuils du pack, mesurés par le code.
 *
 * Ce qui reste part au modèle. Sur une timeline réelle, ce filtre écarte la majorité du lot
 * pour zéro euro.
 */
import { db } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { OpportunityRepo, toStoredBreakdown } from '@/db/repositories/opportunity.repo'
import { classifyTopic } from '@/governor/topic-guard'
import { NichePackFileSchema, type NichePack } from '@/niches/pack.schema'
import { bundledPack, FALLBACK_PACK_ID } from '@/niches/loader'
import { qualifyAll } from '@/swarm/agents/qualifier'
import { scoreOpportunity } from '@/scoring/ev'
import { isSaturated } from '@/scoring/saturation'
import { expiresAtMs } from '@/scoring/freshness'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import type { PostSnapshot } from '@/messaging/contract'
import type { Opportunity } from '@/db/schema'
import { restoreKeystore, buildLlmClient } from './services'
import { systemClock, type Clock } from '@/shared/time'
import { createLogger } from '@/shared/logger'

const log = createLogger('background:qualify')

/**
 * Dépendances injectables.
 *
 * L'horloge en fait partie, et ce n'est pas de la coquetterie : tout le triage dépend du
 * temps — fraîcheur, expiration, période de refroidissement d'affinité. Un handler qui fige
 * `systemClock` est un handler qu'on ne peut pas tester sur ces règles, et c'est exactement
 * ce que MH-17 veut éviter. Le défaut reste l'horloge système, donc rien ne change en
 * production.
 */
export interface QualifyDeps {
  clock: Clock
}

const defaultDeps: QualifyDeps = { clock: systemClock }

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

export interface QualifyResult {
  received: number
  /** Écartés gratuitement, avant tout appel au modèle. */
  filteredFree: number
  /** Envoyés au modèle. */
  sentToModel: number
  /** Retenus dans la file. */
  queued: number
  /** Rejetés par le modèle pour non-pertinence. */
  rejectedByModel: number
  costEur: number
  batches: number
  reasons: Record<string, number>
}

/** Convertit un instantané de messagerie en post extrait. */
function toExtracted(snapshot: PostSnapshot): ExtractedPost {
  return {
    postId: snapshot.postId,
    authorHandle: snapshot.authorHandle,
    authorDisplayName: null,
    text: snapshot.text,
    lang: snapshot.lang,
    postedAtMs: snapshot.createdAtMs,
    replyCount: snapshot.replyCount,
    likeCount: snapshot.likeCount,
    repostCount: snapshot.repostCount,
    hasMedia: snapshot.hasMedia,
    hasQuote: false,
    isReply: snapshot.isReply,
    isOwnPost: false,
    surface: snapshot.surface,
    observedAtMs: snapshot.observedAtMs,
    permalink: `/${snapshot.authorHandle}/status/${snapshot.postId}`,
  }
}

export async function handleObservedPosts(
  payload: { posts: readonly PostSnapshot[] },
  deps: QualifyDeps = defaultDeps,
): Promise<QualifyResult> {
  const clock = deps.clock
  const reasons: Record<string, number> = {}
  const bump = (reason: string): void => {
    reasons[reason] = (reasons[reason] ?? 0) + 1
  }

  const empty: QualifyResult = {
    received: payload.posts.length,
    filteredFree: 0,
    sentToModel: 0,
    queued: 0,
    rejectedByModel: 0,
    costEur: 0,
    batches: 0,
    reasons,
  }

  if (payload.posts.length === 0) return empty

  const configRepo = new ConfigRepo(db(), clock)
  if (!(await configRepo.hasConsented())) {
    bump('onboarding-incomplet')
    return { ...empty, filteredFree: payload.posts.length, reasons }
  }

  const config = await configRepo.get()
  const pack = await loadActivePack(clock)
  const repo = new OpportunityRepo(db(), clock)
  const now = clock.now()

  /* ── 1. Filtres gratuits ─────────────────────────────────────────────────── */

  const known = await repo.knownPostIds(payload.posts.map((p) => p.postId))
  const ownHandle = config.ownHandle?.replace(/^@/, '').toLowerCase() ?? null
  const blocklist = new Set(pack.blocklist.map((h) => h.replace(/^@/, '').toLowerCase()))
  const languages = new Set(pack.languages.map((l) => l.toLowerCase()))

  const candidates: ExtractedPost[] = []

  for (const snapshot of payload.posts) {
    if (known.has(snapshot.postId)) {
      bump('deja-vu')
      continue
    }
    const handle = snapshot.authorHandle.toLowerCase()
    if (ownHandle !== null && handle === ownHandle) {
      bump('post-propre')
      continue
    }
    if (blocklist.has(handle)) {
      bump('auteur-exclu')
      continue
    }
    // La langue est indicative : X l'omet souvent. On n'écarte que si elle est connue ET
    // hors des langues gérées — écarter sur une absence rejetterait la moitié du fil.
    if (snapshot.lang !== null && !languages.has(snapshot.lang.toLowerCase())) {
      bump('langue-non-geree')
      continue
    }
    if (expiresAtMs(snapshot.createdAtMs, pack.thresholds.maxAgeMinutes) <= now) {
      bump('perime')
      continue
    }
    if (
      isSaturated(
        { replyCount: snapshot.replyCount, likeCount: snapshot.likeCount },
        pack.thresholds.maxReplyCount,
      )
    ) {
      bump('sature')
      continue
    }
    if (classifyTopic(snapshot.text, pack.additionalBlockedTopics).blocked) {
      bump('sujet-interdit')
      continue
    }
    if (snapshot.text.trim().length < 15 && !snapshot.hasMedia) {
      // Un post de trois mots sans média n'offre aucune prise. Le faire juger par un modèle
      // coûte autant qu'un post riche pour un verdict certain.
      bump('trop-court')
      continue
    }
    candidates.push(toExtracted(snapshot))
  }

  const filteredFree = payload.posts.length - candidates.length

  if (candidates.length === 0) {
    log.debug('lot entièrement filtré gratuitement', {
      received: payload.posts.length,
      reasons,
    })
    return { ...empty, filteredFree, reasons }
  }

  /* ── 2. Coffre. Sans clé, on s'arrête ici sans prétendre avoir trié. ─────── */

  const keystore = await restoreKeystore(clock)
  if (!(await keystore.isInitialized()) || !keystore.isUnlocked) {
    bump('coffre-verrouille')
    return { ...empty, filteredFree, reasons }
  }

  /* ── 3. Triage par le modèle ─────────────────────────────────────────────── */

  const client = await buildLlmClient(keystore)
  const triage = await qualifyAll(candidates, pack, { client })

  /* ── 4. Scoring et mise en file ──────────────────────────────────────────── */

  const toStore: Omit<Opportunity, 'id'>[] = []
  let rejectedByModel = 0

  for (const qualified of triage.qualified) {
    const post = qualified.post

    const breakdown = scoreOpportunity({
      reach: {
        authorFollowers: null,
        likeCount: post.likeCount,
        repostCount: post.repostCount,
        replyCount: post.replyCount,
      },
      nicheRelevance: qualified.relevance,
      freshness: { postedAtMs: post.postedAtMs, nowMs: now },
      saturation: { replyCount: post.replyCount, likeCount: post.likeCount },
      affinity: await affinityFor(post.authorHandle, pack, now),
      pack,
    })

    const belowThreshold = breakdown.ev < pack.thresholds.minEvScore
    if (belowThreshold) rejectedByModel += 1

    toStore.push({
      postId: post.postId,
      authorHandle: post.authorHandle,
      authorFollowers: null,
      text: post.text,
      lang: post.lang,
      metrics: {
        replies: post.replyCount ?? 0,
        likes: post.likeCount ?? 0,
        reposts: post.repostCount ?? 0,
      },
      postedAtMs: post.postedAtMs,
      observedAtMs: post.observedAtMs,
      surface: post.surface,
      evScore: breakdown.ev,
      scoreBreakdown: toStoredBreakdown(breakdown),
      status: belowThreshold ? 'rejected-qualifier' : 'qualified',
      // Le motif est conservé même sur un rejet : c'est ce qui permet de régler les seuils
      // au lieu de deviner pourquoi la file est vide.
      rejectionReason: belowThreshold
        ? `EV ${(breakdown.ev * 100).toFixed(0)} % sous le seuil ${(pack.thresholds.minEvScore * 100).toFixed(0)} %${qualified.note ? ` (${qualified.note})` : ''}`
        : null,
      nichePackId: pack.id,
      nichePackVersion: pack.version,
      createdAtMs: now,
    })
  }

  const { inserted } = await repo.upsertMany(toStore)
  const queued = toStore.filter((o) => o.status === 'qualified').length

  log.info('triage et mise en file', {
    received: payload.posts.length,
    filteredFree,
    sentToModel: candidates.length,
    queued,
    rejectedByModel,
    inserted,
    costEur: triage.totalCostEur,
  })

  return {
    received: payload.posts.length,
    filteredFree,
    sentToModel: candidates.length,
    queued,
    rejectedByModel,
    costEur: triage.totalCostEur,
    batches: triage.batches,
    reasons,
  }
}

/**
 * Affinité auteur depuis la mémoire relationnelle.
 *
 * La table `relationships` n'est peuplée qu'en Phase 6. En attendant, un compte inconnu vaut
 * une valeur neutre — ni pénalisé, ni favorisé — sauf s'il est sur la watchlist du pack, qui
 * est une information disponible dès maintenant.
 */
async function affinityFor(
  handle: string,
  pack: NichePack,
  nowMs: number,
): Promise<Parameters<typeof scoreOpportunity>[0]['affinity']> {
  const normalized = handle.replace(/^@/, '').toLowerCase()
  const onWatchlist = pack.watchlist.some(
    (h) => h.replace(/^@/, '').toLowerCase() === normalized,
  )
  const relationship = await db().relationships.get(normalized)

  return {
    warmth: relationship?.warmth ?? null,
    interactionCount: relationship?.interactionCount ?? 0,
    ignoredCount: relationship?.ignoredCount ?? 0,
    onWatchlist,
    lastInteractionMs: relationship?.lastInteractionMs ?? null,
    nowMs,
  }
}
