/**
 * MÉMOIRE RELATIONNELLE — CRM social local, différenciateur n°3.
 *
 * « On ne se répète jamais, on monte en intimité progressivement. » Deux exigences distinctes,
 * et la seconde est celle que les produits concurrents n'ont pas : la familiarité doit **se
 * gagner**, pas se déclarer.
 *
 * ## Ce que `warmth` mesure, et ce qui la fait bouger
 *
 * Une échelle 0–5 de familiarité, dont la progression est **asymétrique** :
 *
 *  - Elle monte lentement, et **seulement sur réciprocité** — une réponse de leur part, un
 *    like, un repost. Répondre dix fois à quelqu'un qui ne répond jamais ne crée aucune
 *    intimité, ça crée du harcèlement.
 *  - Elle descend sur l'indifférence et avec le temps. Une relation sans interaction depuis
 *    trois mois n'est plus une relation.
 *
 * Sans cette asymétrie, `warmth` mesurerait notre insistance et non leur réceptivité — et le
 * scoring d'affinité récompenserait précisément le comportement à éviter.
 */
import type { Relationship } from '@/db/schema'
import { DAY, type Clock } from '@/shared/time'

export const MAX_WARMTH = 5
export const MIN_WARMTH = 0

/** Au-delà, la relation refroidit d'un cran. */
export const WARMTH_DECAY_AFTER_MS = 30 * DAY

/** Au-delà, la relation est considérée éteinte. */
export const RELATIONSHIP_STALE_AFTER_MS = 120 * DAY

export type InteractionKind =
  /** On a répondu. Ne fait PAS monter la familiarité à lui seul. */
  | 'we-replied'
  /** Ils ont répondu à notre réponse — le signal de réciprocité le plus fort. */
  | 'they-replied'
  /** Ils ont aimé notre réponse. */
  | 'they-liked'
  /** Ils ont reposté notre réponse. */
  | 'they-reposted'
  /** Ils se sont abonnés après notre réponse. */
  | 'they-followed'
  /** Notre réponse est restée sans réaction. */
  | 'ignored'

/**
 * Gain de familiarité par type d'interaction.
 *
 * `we-replied` vaut **zéro** : c'est le point central du module. Une familiarité qui monte
 * parce qu'on parle beaucoup mesurerait notre insistance, pas la relation.
 */
const WARMTH_DELTA: Record<InteractionKind, number> = {
  'we-replied': 0,
  'they-replied': 0.8,
  'they-liked': 0.25,
  'they-reposted': 0.5,
  'they-followed': 1.5,
  ignored: -0.15,
}

export interface RecordInteractionInput {
  handle: string
  kind: InteractionKind
  /** Sujets abordés par nous dans cette interaction. */
  ourTopics?: readonly string[]
  /** Sujets que le compte aborde, observés. */
  theirTopics?: readonly string[]
  note?: string
}

export function emptyRelationship(handle: string, nowMs: number): Relationship {
  return {
    handle: handle.replace(/^@/, '').toLowerCase(),
    firstSeenMs: nowMs,
    lastInteractionMs: null,
    interactionCount: 0,
    theirTopics: [],
    ourTopics: [],
    warmth: 0,
    notes: '',
    ignoredCount: 0,
  }
}

/**
 * Applique une interaction.
 *
 * Fonction pure : elle prend l'état et renvoie le suivant. Ce qui la rend testable sur des
 * séquences longues — et c'est exactement ce qu'il faut tester, puisque la propriété qui
 * compte n'est pas un pas mais une trajectoire.
 */
export function applyInteraction(
  current: Relationship,
  input: RecordInteractionInput,
  clock: Clock,
): Relationship {
  const now = clock.now()

  // Refroidissement d'abord : une interaction après trois mois d'absence ne doit pas repartir
  // du niveau d'intimité d'il y a trois mois.
  const decayed = applyDecay(current, clock)

  const delta = WARMTH_DELTA[input.kind]
  const warmth = clampWarmth(decayed.warmth + delta)

  return {
    ...decayed,
    lastInteractionMs: now,
    // Seules nos actions comptent comme « interaction » : leurs réactions sont des signaux,
    // pas des tours de parole.
    interactionCount: decayed.interactionCount + (input.kind === 'we-replied' ? 1 : 0),
    warmth,
    ignoredCount: input.kind === 'ignored' ? decayed.ignoredCount + 1 : decayed.ignoredCount,
    ourTopics: mergeTopics(decayed.ourTopics, input.ourTopics),
    theirTopics: mergeTopics(decayed.theirTopics, input.theirTopics),
    notes: input.note ? appendNote(decayed.notes, input.note) : decayed.notes,
  }
}

/**
 * Refroidissement temporel.
 *
 * Un cran par période d'inactivité, pas une décroissance continue : `warmth` est lue comme un
 * niveau discret (« on se connaît un peu »), et une valeur qui glisse en permanence rendrait
 * la lecture instable sans rien apporter.
 */
export function applyDecay(relationship: Relationship, clock: Clock): Relationship {
  if (relationship.lastInteractionMs === null) return relationship
  const elapsed = clock.now() - relationship.lastInteractionMs
  if (elapsed < WARMTH_DECAY_AFTER_MS) return relationship

  const steps = Math.floor(elapsed / WARMTH_DECAY_AFTER_MS)
  return { ...relationship, warmth: clampWarmth(relationship.warmth - steps) }
}

function clampWarmth(value: number): number {
  return Math.max(MIN_WARMTH, Math.min(MAX_WARMTH, Math.round(value * 100) / 100))
}

function mergeTopics(existing: readonly string[], added?: readonly string[]): string[] {
  if (!added || added.length === 0) return [...existing]
  // 20 sujets maximum : au-delà, la liste devient un nuage de mots inutilisable dans un prompt.
  return [...new Set([...existing, ...added.map((t) => t.toLowerCase())])].slice(-20)
}

function appendNote(existing: string, note: string): string {
  const combined = existing ? `${existing}\n${note}` : note
  // 1 000 caractères : les notes vont dans le prompt du STRATEGIST, et une note qui grossit
  // sans borne finirait par coûter plus que la réponse qu'elle informe.
  return combined.length > 1_000 ? combined.slice(-1_000) : combined
}

/* ──────────────────────────── Lecture pour les agents ────────────────────── */

export type FamiliarityLevel = 'inconnu' | 'croisé' | 'connu' | 'familier' | 'proche'

export function familiarityLevel(relationship: Relationship | null): FamiliarityLevel {
  if (!relationship || relationship.lastInteractionMs === null) return 'inconnu'
  if (relationship.warmth >= 4) return 'proche'
  if (relationship.warmth >= 2.5) return 'familier'
  if (relationship.warmth >= 1) return 'connu'
  return 'croisé'
}

/**
 * Registre à adopter selon la familiarité.
 *
 * C'est la traduction du différenciateur n°3 en consigne exploitable. Le ton d'une première
 * réponse n'est pas celui de la dixième, et un produit qui tutoie d'emblée un inconnu se
 * grille.
 */
export function toneGuidance(level: FamiliarityLevel): string {
  switch (level) {
    case 'inconnu':
      return 'Premier contact. Reste sobre et utile : pas de familiarité, pas de private joke, pas de tutoiement présumé.'
    case 'croisé':
      return 'Vous vous êtes croisés sans plus. Reste au registre neutre.'
    case 'connu':
      return 'Vous avez déjà échangé. Tu peux faire référence à un sujet commun, sans supposer de complicité.'
    case 'familier':
      return 'Échanges réguliers et réciproques. Le ton peut être direct et un clin d’œil est acceptable.'
    case 'proche':
      return 'Relation établie. Tu peux être bref, allusif, et sauter les préambules.'
  }
}

export interface RelationshipBrief {
  handle: string
  level: FamiliarityLevel
  warmth: number
  interactionCount: number
  ignoredCount: number
  theirTopics: string[]
  ourTopics: string[]
  notes: string
  tone: string
  /** Vrai si la relation est éteinte : à traiter comme un inconnu. */
  stale: boolean
  /** Avertissement quand notre insistance dépasse leur réceptivité. */
  warning: string | null
}

/**
 * Brief destiné au prompt du STRATEGIST.
 *
 * L'avertissement est la partie utile : un compte à qui on a répondu six fois sans jamais
 * obtenir de réaction n'est pas une relation à approfondir, c'est un signal d'arrêt. Le taire
 * laisserait le produit insister, ce qui est exactement le comportement que le CRM social
 * existe pour empêcher.
 */
export function buildRelationshipBrief(
  relationship: Relationship | null,
  clock: Clock,
): RelationshipBrief | null {
  if (!relationship) return null

  const decayed = applyDecay(relationship, clock)
  const level = familiarityLevel(decayed)
  const stale =
    decayed.lastInteractionMs !== null &&
    clock.now() - decayed.lastInteractionMs > RELATIONSHIP_STALE_AFTER_MS

  return {
    handle: decayed.handle,
    level: stale ? 'inconnu' : level,
    warmth: decayed.warmth,
    interactionCount: decayed.interactionCount,
    ignoredCount: decayed.ignoredCount,
    theirTopics: decayed.theirTopics,
    ourTopics: decayed.ourTopics,
    notes: decayed.notes,
    tone: toneGuidance(stale ? 'inconnu' : level),
    stale,
    warning: buildWarning(decayed),
  }
}

function buildWarning(relationship: Relationship): string | null {
  if (relationship.ignoredCount >= 3 && relationship.warmth < 1) {
    return `${relationship.ignoredCount} réponses sans réaction. Ce compte n’est pas réceptif : ne pas insister.`
  }
  if (relationship.interactionCount >= 5 && relationship.warmth < 1) {
    // Le cas exact que l'asymétrie de `warmth` existe pour rendre visible.
    return `${relationship.interactionCount} réponses de notre part pour une familiarité de ${relationship.warmth.toFixed(1)}. On parle plus qu’on n’est écouté.`
  }
  return null
}
