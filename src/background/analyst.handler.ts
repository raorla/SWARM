/**
 * ANALYST — la boucle d'apprentissage, côté service worker (Phase 5, différenciateur n°2).
 *
 * `src/analytics/` sait mesurer, attribuer et agréger. Ce module est ce qui **déclenche** ces
 * calculs et ce qui les branche à la base : sans lui, la Phase 5 était du code juste que rien
 * n'appelait — la panne la plus discrète possible, puisque tous les tests passent.
 *
 * ## Pourquoi la mesure est passive
 *
 * Mesurer un post publié demande de relire ses métriques sur X. Le chemin évident serait
 * d'ouvrir `x.com/<handle>/status/<id>` dans un onglet à J+1, de lire, et de fermer. On ne le
 * fait pas :
 *
 *  - naviguer sans qu'on ait rien demandé est exactement le comportement d'automatisation que
 *    le produit refuse (SPEC §4.6). Un onglet qui s'ouvre seul est aussi le signal le plus
 *    visible côté X ;
 *  - ça ne marcherait de toute façon qu'avec le navigateur ouvert et la session active, donc
 *    sans garantie de ponctualité.
 *
 * La mesure se fait donc **sur relevé d'opportunité** : quand l'utilisateur passe sur son
 * propre fil ou son profil, le scout collecte ses posts avec leurs métriques (table
 * `ownPosts`), et ce module rapproche ces relevés des mesures dues. Conséquence assumée et
 * affichée : la couverture est partielle. `measurementCoverage` la chiffre au lieu de la
 * cacher, parce qu'un taux d'apprentissage calculé sur une couverture inconnue ne veut rien
 * dire.
 *
 * ## Fenêtre de tolérance
 *
 * Un relevé fait à J+4 ne mesure pas J+1 : l'engagement continue de monter. Comparer une
 * action mesurée à J+1 avec une autre « mesurée à J+1 » qui l'a été à J+4 fabriquerait un
 * pattern à partir d'un écart de calendrier. On accepte donc un relevé seulement dans une
 * fenêtre autour de l'échéance, et on compte les mesures manquées.
 */
import { db, type SwarmDb } from '@/db'
import type { Action, Outcome, OwnPost, Pattern } from '@/db/schema'
import { systemClock, type Clock, DAY } from '@/shared/time'
import { createLogger } from '@/shared/logger'
import {
  MEASUREMENT_OFFSETS,
  selectDueMeasurements,
  toOutcome,
  type MeasurementOffset,
  type MeasurementTarget,
} from '@/analytics/measure'
import {
  aggregatePatterns,
  digestPatterns,
  type PatternDigest,
} from '@/analytics/aggregate'
import { describeDigest, digestFingerprint } from '@/analytics/inject'

const log = createLogger('background:analyst')

export interface AnalystDeps {
  database: SwarmDb
  clock: Clock
}

export const defaultAnalystDeps = (): AnalystDeps => ({ database: db(), clock: systemClock })

/**
 * Tolérance de relevé, par échéance.
 *
 * Large sur J+7, serrée sur J+1 : à un jour l'engagement bouge encore vite, à sept il a
 * pratiquement fini de monter. Les valeurs sont volontairement asymétriques pour cette
 * raison, et non par commodité.
 */
export const MEASUREMENT_TOLERANCE_MS: Record<MeasurementOffset, number> = {
  1: 2 * DAY,
  7: 5 * DAY,
}

export interface MeasurementRun {
  /** Mesures écrites pendant ce passage. */
  recorded: number
  /** Mesures dues dont aucun relevé n'est disponible : l'utilisateur n'a pas vu son post. */
  awaitingSighting: number
  /** Mesures dues dont le seul relevé est trop tardif pour être honnête. */
  missed: number
  /** Total des mesures dues examinées. */
  due: number
}

/**
 * Écrit les mesures dues pour lesquelles un relevé exploitable existe.
 *
 * Idempotent : `selectDueMeasurements` exclut les couples (action, décalage) déjà mesurés, et
 * un second passage sans nouveau relevé n'écrit rien. C'est nécessaire, parce que l'alarme
 * peut se déclencher plusieurs fois pour la même échéance.
 */
export async function runDueMeasurements(
  deps: AnalystDeps = defaultAnalystDeps(),
): Promise<MeasurementRun> {
  const { database, clock } = deps
  const actions = await database.actions.where('outcome').equals('published').toArray()
  const existing = await database.outcomes.toArray()
  const targets = selectDueMeasurements(actions, existing, clock)

  const run: MeasurementRun = {
    recorded: 0,
    awaitingSighting: 0,
    missed: 0,
    due: targets.length,
  }
  if (targets.length === 0) return run

  // Un seul balayage de la table, indexé par postId : les relevés sont peu nombreux, mais
  // une requête par cible ferait N allers-retours IndexedDB pour rien.
  const sightings = await database.ownPosts.toArray()
  const byPostId = new Map<string, OwnPost[]>()
  for (const post of sightings) {
    byPostId.set(post.postId, [...(byPostId.get(post.postId) ?? []), post])
  }

  for (const target of targets) {
    const xPostId = target.action.xPostId
    if (xPostId === null) {
      // Publication constatée mais identifiant non lu : rien à rapprocher.
      run.awaitingSighting += 1
      continue
    }

    const sighting = pickSighting(byPostId.get(xPostId) ?? [], target)
    if (sighting.kind === 'none') {
      run.awaitingSighting += 1
      continue
    }
    if (sighting.kind === 'too-late') {
      run.missed += 1
      continue
    }

    await database.outcomes.add(
      toOutcome(
        target,
        {
          // `null` et non zéro : X masque régulièrement les impressions, et un zéro faux
          // ferait baisser une moyenne au lieu d'être exclu du calcul.
          impressions: null,
          likes: sighting.post.likeCount ?? 0,
          replies: sighting.post.replyCount ?? 0,
          reposts: sighting.post.repostCount ?? 0,
          profileClicks: null,
          // Aucun relevé d'abonnés n'est collecté pour l'instant : l'attribution reste donc
          // à zéro, et `attributionCaveat()` le dit dans l'UI. Mettre une estimation ici
          // serait un chiffre inventé qui pèserait 20× dans le score d'engagement.
        },
        0,
        clock,
      ) as Outcome,
    )
    run.recorded += 1
  }

  log.info('mesures traitées', { ...run })
  return run
}

type SightingChoice =
  | { kind: 'usable'; post: OwnPost }
  | { kind: 'too-late' }
  | { kind: 'none' }

/**
 * Choisit le relevé le plus proche de l'échéance, dans la tolérance.
 *
 * Un relevé antérieur à l'échéance est refusé : mesurer J+7 avec un relevé de J+2 sous-estime
 * l'engagement, ce qui est le même défaut que la mesure tardive, dans l'autre sens.
 */
export function pickSighting(
  candidates: readonly OwnPost[],
  target: MeasurementTarget,
): SightingChoice {
  if (candidates.length === 0) return { kind: 'none' }
  const tolerance = MEASUREMENT_TOLERANCE_MS[target.offset]

  let best: OwnPost | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let sawLate = false

  for (const post of candidates) {
    const delta = post.collectedAtMs - target.dueAtMs
    if (delta < 0) continue
    if (delta > tolerance) {
      sawLate = true
      continue
    }
    if (delta < bestDistance) {
      bestDistance = delta
      best = post
    }
  }

  if (best !== null) return { kind: 'usable', post: best }
  return sawLate ? { kind: 'too-late' } : { kind: 'none' }
}

/* ─────────────────────────── Agrégation en patterns ───────────────────────── */

export interface PatternRefresh {
  digest: PatternDigest
  /** Empreinte avant/après : c'est elle qui prouve que les prompts ont changé (DoD §5). */
  fingerprintBefore: string
  fingerprintAfter: string
  changed: boolean
  usableSample: number
  skipped: Record<string, number>
}

/**
 * Recalcule la table `patterns` depuis les mesures, et dit si le digest a bougé.
 *
 * La table est **remplacée**, pas complétée : un pattern dont l'échantillon a été purgé par
 * la rétention doit disparaître, sinon il continuerait à piloter les prompts sur des données
 * qui n'existent plus.
 */
export async function refreshPatterns(
  deps: AnalystDeps = defaultAnalystDeps(),
): Promise<PatternRefresh> {
  const { database, clock } = deps

  const before = await readDigest(deps)

  const actions = await database.actions.where('outcome').equals('published').toArray()
  const outcomes = await database.outcomes.toArray()
  const byActionId = new Map<number, Outcome[]>()
  for (const outcome of outcomes) {
    byActionId.set(outcome.actionId, [...(byActionId.get(outcome.actionId) ?? []), outcome])
  }

  const observations = actions
    .filter((a): a is Action & { id: number } => a.id !== undefined)
    .map((action) => ({ action, outcomes: byActionId.get(action.id) ?? [] }))

  const angleByActionId = await readAngles(deps, observations.map((o) => o.action))
  const result = aggregatePatterns(observations, clock, angleByActionId)

  await database.transaction('rw', database.patterns, async () => {
    await database.patterns.clear()
    if (result.patterns.length > 0) {
      await database.patterns.bulkAdd(result.patterns as Pattern[])
    }
  })

  const digest = digestPatterns(
    result.patterns as Pattern[],
    result.globalAverage,
    result.usableSample,
  )
  const fingerprintBefore = digestFingerprint(before)
  const fingerprintAfter = digestFingerprint(digest)

  log.info('patterns recalculés', {
    patterns: result.patterns.length,
    usableSample: result.usableSample,
    changed: fingerprintBefore !== fingerprintAfter,
  })

  return {
    digest,
    fingerprintBefore,
    fingerprintAfter,
    changed: fingerprintBefore !== fingerprintAfter,
    usableSample: result.usableSample,
    skipped: result.skipped,
  }
}

/**
 * Angle de chaque action, lu depuis la variante retenue de son brouillon.
 *
 * L'angle est la dimension la plus intéressante de l'apprentissage — c'est la seule que le
 * WRITER contrôle directement — et elle n'est pas stockée sur l'action. On la reconstruit
 * plutôt que de dupliquer le champ : une copie diverge, un brouillon non trouvé se déduit à
 * l'absence, et `aggregatePatterns` sait ignorer une action sans angle.
 */
async function readAngles(
  deps: AnalystDeps,
  actions: readonly Action[],
): Promise<Map<number, string>> {
  const draftIds = actions
    .map((a) => a.draftId)
    .filter((id): id is number => id !== null)
  if (draftIds.length === 0) return new Map()

  const drafts = await deps.database.drafts.bulkGet(draftIds)
  const angleByDraftId = new Map<number, string>()
  for (const draft of drafts) {
    if (!draft || draft.id === undefined) continue
    const index = draft.selectedIndex
    const variant = index === null ? undefined : draft.variants[index]
    if (variant) angleByDraftId.set(draft.id, variant.angle)
  }

  const out = new Map<number, string>()
  for (const action of actions) {
    if (action.id === undefined || action.draftId === null) continue
    const angle = angleByDraftId.get(action.draftId)
    if (angle !== undefined) out.set(action.id, angle)
  }
  return out
}

/** Digest courant, lu depuis la table — c'est ce que les prompts consomment. */
export async function readDigest(
  deps: AnalystDeps = defaultAnalystDeps(),
): Promise<PatternDigest> {
  const patterns = await deps.database.patterns.toArray()
  if (patterns.length === 0) {
    return { top: [], flop: [], globalAverage: 0, insufficient: true, sampleSize: 0 }
  }
  const totalSample = patterns.reduce((sum, p) => sum + p.sampleSize, 0)
  const globalAverage =
    totalSample === 0
      ? 0
      : patterns.reduce((sum, p) => sum + p.avgEngagement * p.sampleSize, 0) / totalSample
  return digestPatterns(patterns, globalAverage, totalSample)
}

/* ──────────────────────────── Instantané pour l'UI ────────────────────────── */

export interface AnalyticsSnapshot {
  /** Résumé en une phrase, affichable tel quel. */
  summary: string
  digest: PatternDigest
  /** Actions publiées, et combien ont au moins une mesure. */
  published: number
  measured: number
  /** Part des actions publiées effectivement mesurées, dans [0, 1]. */
  measurementCoverage: number
  /** Mesures dues sans relevé : la conséquence chiffrée de la mesure passive. */
  awaitingSighting: number
  abandonRate: { rate: number; sample: number }
  /** Coût cumulé et coût par réponse publiée — la colonne de droite du raisonnement EV. */
  totalCostEur: number
  costPerPublishedEur: number
  /** Vetos du CRITIC rapportés aux brouillons produits. */
  vetoRate: { rate: number; sample: number }
}

export async function analyticsSnapshot(
  deps: AnalystDeps = defaultAnalystDeps(),
): Promise<AnalyticsSnapshot> {
  const { database, clock } = deps
  const actions = await database.actions.toArray()
  const outcomes = await database.outcomes.toArray()
  const digest = await readDigest(deps)

  const published = actions.filter((a) => a.outcome === 'published')
  const measuredIds = new Set(outcomes.map((o) => o.actionId))
  const measured = published.filter((a) => a.id !== undefined && measuredIds.has(a.id)).length

  const staged = actions.filter((a) => a.outcome !== 'pending').length
  const abandoned = actions.filter((a) => a.outcome === 'abandoned').length

  const totalCostEur = actions.reduce((sum, a) => sum + a.totalCostEur, 0)

  // Les mesures dues sont recalculées ici plutôt que mémorisées : une valeur en base
  // vieillirait entre deux réveils du service worker, et afficherait un chiffre faux.
  const dueNow = selectDueMeasurements(published, outcomes, clock)
  const awaitingSighting = dueNow.length - countSightable(dueNow, await database.ownPosts.toArray())

  return {
    summary: describeDigest(digest),
    digest,
    published: published.length,
    measured,
    measurementCoverage: published.length === 0 ? 0 : measured / published.length,
    awaitingSighting,
    abandonRate: {
      rate: staged === 0 ? 0 : abandoned / staged,
      sample: staged,
    },
    totalCostEur,
    costPerPublishedEur: published.length === 0 ? 0 : totalCostEur / published.length,
    vetoRate: await vetoRate(deps),
  }
}

function countSightable(
  targets: readonly MeasurementTarget[],
  sightings: readonly OwnPost[],
): number {
  const byPostId = new Map<string, OwnPost[]>()
  for (const post of sightings) {
    byPostId.set(post.postId, [...(byPostId.get(post.postId) ?? []), post])
  }
  return targets.filter((target) => {
    const id = target.action.xPostId
    if (id === null) return false
    return pickSighting(byPostId.get(id) ?? [], target).kind === 'usable'
  }).length
}

/**
 * Taux de veto du CRITIC.
 *
 * Affiché parce qu'un taux extrême, dans un sens comme dans l'autre, dit que le seuil est
 * mal calibré — pas que les réponses sont bonnes ou mauvaises. Un CRITIC qui ne refuse
 * jamais ne sert à rien ; un CRITIC qui refuse tout empêche le produit de fonctionner.
 */
async function vetoRate(deps: AnalystDeps): Promise<{ rate: number; sample: number }> {
  const drafts = await deps.database.drafts.toArray()
  if (drafts.length === 0) return { rate: 0, sample: 0 }
  const vetoed = drafts.filter((d) => d.selectedIndex === null).length
  return { rate: vetoed / drafts.length, sample: drafts.length }
}

/** Passage complet, appelé par l'alarme : mesurer puis réagréger. */
export async function runAnalystCycle(
  deps: AnalystDeps = defaultAnalystDeps(),
): Promise<{ measurement: MeasurementRun; patterns: PatternRefresh }> {
  const measurement = await runDueMeasurements(deps)
  // Réagréger même sans nouvelle mesure : la rétention peut avoir purgé des actions, et le
  // digest doit alors cesser d'affirmer ce qu'il affirmait.
  const patterns = await refreshPatterns(deps)
  return { measurement, patterns }
}

export { MEASUREMENT_OFFSETS }
