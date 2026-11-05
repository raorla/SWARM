/**
 * Horloge injectable — FEEDBACK MH-17.
 *
 * Le governor décide de délais log-normaux, de fenêtres horaires, de pauses nocturnes
 * et de réveils à J+1/J+7. Sans horloge substituable, aucune de ces règles n'est
 * testable : on livrerait le module le plus critique du produit sur la foi d'une
 * relecture. Un lint interdit `Date.now()` ailleurs dans `src/`.
 */

export type Millis = number

export interface Clock {
  now(): Millis
  date(): Date
  /** Décalage minutes de l'heure locale par rapport à UTC (négatif à l'est de Greenwich). */
  timezoneOffsetMinutes(): number
}

export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
  timezoneOffsetMinutes: () => new Date().getTimezoneOffset(),
}

/** Horloge de test : avance uniquement quand on le lui demande. */
export class FakeClock implements Clock {
  private t: Millis
  private tzOffset: number

  constructor(startIso = '2026-01-01T12:00:00.000Z', tzOffsetMinutes = 0) {
    this.t = new Date(startIso).getTime()
    this.tzOffset = tzOffsetMinutes
  }

  now(): Millis {
    return this.t
  }
  date(): Date {
    return new Date(this.t)
  }
  timezoneOffsetMinutes(): number {
    return this.tzOffset
  }

  /**
   * Avance l'horloge.
   *
   * Arrondi volontaire : `Date.now()` ne renvoie jamais de fraction, et une horloge de test
   * qui en produirait masquerait exactement les bugs qu'on cherche — un `observedAtMs`
   * fractionnaire échoue sa validation `int` très loin de l'endroit qui l'a produit.
   */
  advance(ms: Millis): this {
    this.t += Math.round(ms)
    return this
  }
  advanceMinutes(m: number): this {
    return this.advance(m * MINUTE)
  }
  advanceHours(h: number): this {
    return this.advance(h * HOUR)
  }
  advanceDays(d: number): this {
    return this.advance(d * DAY)
  }
  set(iso: string): this {
    this.t = new Date(iso).getTime()
    return this
  }
}

export const SECOND = 1_000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Clé de jour local `YYYY-MM-DD` — sert de partition aux compteurs journaliers. */
export function localDayKey(clock: Clock): string {
  const d = clock.date()
  const local = new Date(d.getTime() - clock.timezoneOffsetMinutes() * MINUTE)
  return local.toISOString().slice(0, 10)
}

/** Minutes écoulées depuis minuit local — base des fenêtres horaires. */
export function localMinutesOfDay(clock: Clock): number {
  const d = clock.date()
  const local = new Date(d.getTime() - clock.timezoneOffsetMinutes() * MINUTE)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

/** 0 = dimanche … 6 = samedi, en heure locale. */
export function localDayOfWeek(clock: Clock): number {
  const d = clock.date()
  const local = new Date(d.getTime() - clock.timezoneOffsetMinutes() * MINUTE)
  return local.getUTCDay()
}
