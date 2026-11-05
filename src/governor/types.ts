/**
 * Types du governor — SPEC §2.
 *
 * L'invariant central du produit : aucune action sur X ne peut avoir lieu sans un
 * `StagePermit`, et seul le governor peut en construire un. C'est appliqué par le
 * typage via une marque privée (« branded type ») : un objet littéral ne satisfait pas
 * le type, donc contourner le governor ne compile pas.
 */

declare const PERMIT_BRAND: unique symbol

export type ActionType =
  'reply' | 'post' | 'thread' | 'like' | 'bookmark' | 'follow' | 'dm'

/** Autorisation d'agir, émise par le governor. Non constructible ailleurs. */
export interface StagePermit {
  readonly [PERMIT_BRAND]: true
  readonly token: string
  readonly actionType: ActionType
  readonly idempotencyKey: string
  readonly issuedAtMs: number
  /** Instant avant lequel l'action ne doit pas être exécutée (cadence humaine). */
  readonly notBeforeMs: number
  readonly expiresAtMs: number
}

export type DenialReason =
  | 'killswitch'
  | 'simulation'
  | 'cap-reached'
  | 'outside-window'
  | 'day-off'
  | 'cadence'
  | 'budget-exhausted'
  | 'blocked-topic'
  | 'blocked-author'
  | 'action-not-supported'
  | 'duplicate'

export interface Denial {
  readonly reason: DenialReason
  /** Détail lisible, destiné au journal d'audit et à l'onglet Swarm. */
  readonly detail: string
  /** Instant à partir duquel une nouvelle tentative a une chance d'aboutir. */
  readonly retryAtMs?: number
}

export interface DailyCaps {
  reply: number
  post: number
  thread: number
  like: number
  bookmark: number
  follow: number
  dm: number
}

/** Plafonds par défaut — SPEC §2.1. `dm` reste à 0 et n'est pas relevable. */
export const DEFAULT_CAPS: DailyCaps = {
  reply: 12,
  post: 3,
  thread: 1,
  like: 30,
  bookmark: 20,
  follow: 0,
  dm: 0,
}

export interface CadenceConfig {
  /** Délai minimum entre deux actions, en minutes. */
  minMinutes: number
  /** Délai maximum, borne dure du tirage log-normal. */
  maxMinutes: number
}

export const DEFAULT_CADENCE: CadenceConfig = { minMinutes: 4, maxMinutes: 18 }

export interface WindowConfig {
  /** Minutes depuis minuit local. 540 = 09:00. */
  startMinute: number
  /** 1380 = 23:00. */
  endMinute: number
  /** Jours de la semaine actifs, 0 = dimanche. */
  activeDays: readonly number[]
  /** Probabilité qu'un jour donné soit un jour off (déterminée par jour, pas par appel). */
  dayOffProbability: number
}

export const DEFAULT_WINDOW: WindowConfig = {
  startMinute: 9 * 60,
  endMinute: 23 * 60,
  activeDays: [0, 1, 2, 3, 4, 5, 6],
  dayOffProbability: 1 / 7,
}
