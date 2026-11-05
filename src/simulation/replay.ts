/**
 * SIMULATION / BACKTEST — différenciateur n°6.
 *
 * « Rejouer le swarm sur 30 jours de timeline archivée sans rien publier, pour tuner la config
 * avant de la lâcher en réel. »
 *
 * ## La propriété sans laquelle rien de tout ça ne sert
 *
 * **La reproductibilité.** Comparer deux configurations n'a de sens que si la même
 * configuration donne exactement le même résultat. Sans ça, un écart entre deux runs peut venir
 * de la config ou du hasard, et on ne peut pas savoir lequel — ce qui rend le backtest pire
 * qu'inutile, puisqu'il produit des conclusions.
 *
 * Trois sources de non-déterminisme, neutralisées :
 *
 *  1. **L'horloge** — `FakeClock` avance sur l'archive, pas sur le temps réel. C'est ce que
 *     `shared/time.ts` existe pour permettre (MH-17).
 *  2. **L'aléa** — `SeededRng` à graine fixe. La cadence log-normale du governor devient
 *     rejouable.
 *  3. **Le modèle** — un LLM n'est jamais déterministe. Le backtest ne l'appelle donc pas : il
 *     rejoue des **verdicts archivés**. On mesure ce que la configuration fait des mêmes
 *     jugements, pas ce qu'un modèle aurait dit.
 *
 * Ce dernier point est une limite réelle, et il faut la dire : le backtest compare des
 * **politiques de sélection**, pas des qualités de rédaction. Il répond à « ce seuil aurait-il
 * retenu ce post ? », pas à « la réponse aurait-elle été meilleure ? ».
 */
import { scoreOpportunity } from '@/scoring/ev'
import { classifyTopic } from '@/governor/topic-guard'
import { expiresAtMs } from '@/scoring/freshness'
import { isSaturated } from '@/scoring/saturation'
import type { NichePack } from '@/niches/pack.schema'
import { FakeClock, type Clock } from '@/shared/time'
import { SeededRng, logNormalDelay } from '@/shared/rng'
import type { DailyCaps } from '@/governor/types'

/* ─────────────────────────────── Archive ─────────────────────────────────── */

/**
 * Post archivé.
 *
 * Volontairement plat et sérialisable : une archive doit survivre à un export, à un changement
 * de version du produit, et à une relecture humaine.
 */
export interface ArchivedPost {
  postId: string
  authorHandle: string
  authorFollowers: number | null
  text: string
  lang: string | null
  postedAtMs: number
  observedAtMs: number
  replyCount: number | null
  likeCount: number | null
  repostCount: number | null
  hasMedia: boolean
  isReply: boolean
  surface: 'timeline' | 'search' | 'watchlist' | 'notifications' | 'bookmarks'
  /**
   * Verdict de pertinence **archivé**, produit par un QUALIFIER réel au moment de la collecte.
   *
   * C'est ce qui rend le rejeu déterministe : sans lui, il faudrait rappeler le modèle, et deux
   * runs de la même config donneraient des résultats différents.
   */
  archivedRelevance: number
  archivedAngle: string | null
}

export interface ArchiveMeta {
  formatVersion: 1
  recordedFromMs: number
  recordedToMs: number
  postCount: number
  /** Pack actif lors de la collecte — un verdict n'est comparable qu'à pack égal. */
  nichePackId: string
  nichePackVersion: string
}

export interface Archive {
  meta: ArchiveMeta
  posts: ArchivedPost[]
}

/* ────────────────────────── Configuration rejouée ────────────────────────── */

export interface ReplayConfig {
  label: string
  pack: NichePack
  caps: DailyCaps
  /** Graine de l'aléa. Deux runs à graine égale doivent être identiques. */
  seed: number
  cadence: { minMinutes: number; maxMinutes: number }
  /** Fenêtre horaire active, en minutes depuis minuit local. */
  window: { startMinute: number; endMinute: number }
}

export interface ReplayOutcome {
  postId: string
  /** Ce que la configuration a décidé, et pourquoi. */
  decision: 'queued' | 'rejected-guard' | 'rejected-threshold' | 'rejected-stale' | 'rejected-saturated' | 'skipped-cap' | 'skipped-window' | 'skipped-cadence'
  evScore: number
  reason: string
  /** Instant simulé de la décision. */
  atMs: number
}

export interface ReplayReport {
  label: string
  seed: number
  postsReplayed: number
  outcomes: ReplayOutcome[]
  counts: Record<ReplayOutcome['decision'], number>
  /** Opportunités qui auraient atteint la file. */
  queued: number
  /** Score EV moyen des opportunités retenues. */
  avgQueuedEv: number
  /** Jours simulés couverts par l'archive. */
  simulatedDays: number
  /** Réponses par jour, moyennées — à comparer au plafond configuré. */
  repliesPerDay: number
}

const EMPTY_COUNTS: Record<ReplayOutcome['decision'], number> = {
  queued: 0,
  'rejected-guard': 0,
  'rejected-threshold': 0,
  'rejected-stale': 0,
  'rejected-saturated': 0,
  'skipped-cap': 0,
  'skipped-window': 0,
  'skipped-cadence': 0,
}

/**
 * Rejoue une archive sous une configuration donnée.
 *
 * **Rien n'est publié, rien n'est appelé, rien n'est écrit en base.** La fonction est pure au
 * sens qui compte ici : mêmes entrées, même sortie. C'est ce qui permet de comparer deux
 * configurations sans se demander si l'écart vient du hasard.
 */
export function replayArchive(archive: Archive, config: ReplayConfig): ReplayReport {
  const outcomes: ReplayOutcome[] = []
  const counts = { ...EMPTY_COUNTS }

  // Horloge simulée : elle avance sur l'archive, pas sur le temps réel.
  const posts = [...archive.posts].sort((a, b) => a.observedAtMs - b.observedAtMs)
  if (posts.length === 0) {
    return {
      label: config.label,
      seed: config.seed,
      postsReplayed: 0,
      outcomes,
      counts,
      queued: 0,
      avgQueuedEv: 0,
      simulatedDays: 0,
      repliesPerDay: 0,
    }
  }

  const clock = new FakeClock(new Date(posts[0]!.observedAtMs).toISOString())
  const rng = new SeededRng(config.seed)

  // État du governor simulé.
  let repliesToday = 0
  let currentDayKey = dayKeyOf(posts[0]!.observedAtMs)
  let lastActionAtMs: number | null = null
  let nextDelayMs: number | null = null

  const record = (
    post: ArchivedPost,
    decision: ReplayOutcome['decision'],
    evScore: number,
    reason: string,
  ): void => {
    outcomes.push({ postId: post.postId, decision, evScore, reason, atMs: post.observedAtMs })
    counts[decision] += 1
  }

  for (const post of posts) {
    clock.set(new Date(post.observedAtMs).toISOString())

    // Rotation de jour : les plafonds sont journaliers.
    const dayKey = dayKeyOf(post.observedAtMs)
    if (dayKey !== currentDayKey) {
      currentDayKey = dayKey
      repliesToday = 0
    }

    /* ── Filtres gratuits, dans le même ordre que la production ──────────── */

    if (classifyTopic(post.text, config.pack.additionalBlockedTopics).blocked) {
      record(post, 'rejected-guard', 0, 'sujet écarté par le garde-fou')
      continue
    }
    if (expiresAtMs(post.postedAtMs, config.pack.thresholds.maxAgeMinutes) <= post.observedAtMs) {
      record(post, 'rejected-stale', 0, 'périmé au seuil du pack')
      continue
    }
    if (
      isSaturated(
        { replyCount: post.replyCount, likeCount: post.likeCount },
        config.pack.thresholds.maxReplyCount,
      )
    ) {
      record(post, 'rejected-saturated', 0, 'conversation saturée')
      continue
    }

    /* ── Scoring ─────────────────────────────────────────────────────────── */

    const breakdown = scoreOpportunity({
      reach: {
        authorFollowers: post.authorFollowers,
        likeCount: post.likeCount,
        repostCount: post.repostCount,
        replyCount: post.replyCount,
      },
      // Verdict archivé : c'est ce qui rend le rejeu déterministe.
      nicheRelevance: post.archivedRelevance,
      freshness: { postedAtMs: post.postedAtMs, nowMs: post.observedAtMs },
      saturation: { replyCount: post.replyCount, likeCount: post.likeCount },
      affinity: {
        // Le backtest ne rejoue pas la mémoire relationnelle : elle dépend de ce que le
        // produit a effectivement publié, donc du run — et l'inclure rendrait le rejeu
        // dépendant de son propre résultat.
        warmth: null,
        interactionCount: 0,
        ignoredCount: 0,
        onWatchlist: config.pack.watchlist.some(
          (h) => h.replace(/^@/, '').toLowerCase() === post.authorHandle.toLowerCase(),
        ),
        lastInteractionMs: null,
        nowMs: post.observedAtMs,
      },
      pack: config.pack,
    })

    if (breakdown.ev < config.pack.thresholds.minEvScore) {
      record(
        post,
        'rejected-threshold',
        breakdown.ev,
        `EV ${(breakdown.ev * 100).toFixed(0)} % sous le seuil ${(config.pack.thresholds.minEvScore * 100).toFixed(0)} %`,
      )
      continue
    }

    /* ── Governor simulé ─────────────────────────────────────────────────── */

    const minuteOfDay = minuteOfDayOf(post.observedAtMs, clock)
    if (minuteOfDay < config.window.startMinute || minuteOfDay >= config.window.endMinute) {
      record(post, 'skipped-window', breakdown.ev, 'hors fenêtre active')
      continue
    }

    if (repliesToday >= config.caps.reply) {
      record(post, 'skipped-cap', breakdown.ev, `plafond de ${config.caps.reply} réponses atteint`)
      continue
    }

    if (lastActionAtMs !== null) {
      nextDelayMs ??= logNormalDelay(
        rng,
        config.cadence.minMinutes * 60_000,
        config.cadence.maxMinutes * 60_000,
      )
      if (post.observedAtMs - lastActionAtMs < nextDelayMs) {
        record(post, 'skipped-cadence', breakdown.ev, 'cadence : trop tôt')
        continue
      }
    }

    record(post, 'queued', breakdown.ev, 'retenu')
    repliesToday += 1
    lastActionAtMs = post.observedAtMs
    // Le délai est retiré après chaque action, comme en production.
    nextDelayMs = null
  }

  const queuedOutcomes = outcomes.filter((o) => o.decision === 'queued')
  const spanMs = posts[posts.length - 1]!.observedAtMs - posts[0]!.observedAtMs
  const simulatedDays = Math.max(1, spanMs / 86_400_000)

  return {
    label: config.label,
    seed: config.seed,
    postsReplayed: posts.length,
    outcomes,
    counts,
    queued: queuedOutcomes.length,
    avgQueuedEv:
      queuedOutcomes.length === 0
        ? 0
        : queuedOutcomes.reduce((sum, o) => sum + o.evScore, 0) / queuedOutcomes.length,
    simulatedDays,
    repliesPerDay: queuedOutcomes.length / simulatedDays,
  }
}

function dayKeyOf(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10)
}

function minuteOfDayOf(atMs: number, clock: Clock): number {
  const local = new Date(atMs - clock.timezoneOffsetMinutes() * 60_000)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}
