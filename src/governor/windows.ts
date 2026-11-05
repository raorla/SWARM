/**
 * Fenêtres horaires et jours off — SPEC §2.1.
 *
 * Le jour off est déterminé par une fonction de hachage du jour, pas par un tirage à
 * chaque appel : un tirage par appel donnerait un « jour off » qui clignote au fil de la
 * journée. Un jour off doit être un fait stable sur 24 h, et reproductible en test.
 */
import { localDayKey, localDayOfWeek, localMinutesOfDay, type Clock } from '@/shared/time'
import type { Denial, WindowConfig } from './types'

/** Hash déterministe d'une chaîne vers [0, 1) — FNV-1a 32 bits. */
function hashUnit(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h / 4_294_967_296
}

export class WindowGuard {
  constructor(private readonly clock: Clock) {}

  /**
   * `seed` désigne l'installation : deux utilisateurs n'ont pas leurs jours off les
   * mêmes jours. Fixe par installation, donc stable et testable.
   */
  isDayOff(config: WindowConfig, seed: string): boolean {
    if (config.dayOffProbability <= 0) return false
    return hashUnit(`${seed}:${localDayKey(this.clock)}`) < config.dayOffProbability
  }

  check(config: WindowConfig, seed: string): Denial | null {
    const dow = localDayOfWeek(this.clock)
    if (!config.activeDays.includes(dow)) {
      return {
        reason: 'outside-window',
        detail: `jour ${dow} inactif`,
        retryAtMs: this.nextWindowMs(config),
      }
    }
    if (this.isDayOff(config, seed)) {
      return {
        reason: 'day-off',
        detail: 'jour de pause tiré pour aujourd’hui',
        retryAtMs: this.nextMidnightMs(),
      }
    }
    const minute = localMinutesOfDay(this.clock)
    if (minute < config.startMinute || minute >= config.endMinute) {
      return {
        reason: 'outside-window',
        detail: `${fmt(minute)} hors de ${fmt(config.startMinute)}–${fmt(config.endMinute)}`,
        retryAtMs: this.nextWindowMs(config),
      }
    }
    return null
  }

  private nextMidnightMs(): number {
    const offset = this.clock.timezoneOffsetMinutes() * 60_000
    const local = new Date(this.clock.now() - offset)
    local.setUTCHours(24, 0, 0, 0)
    return local.getTime() + offset
  }

  /** Prochaine ouverture de fenêtre : aujourd'hui si elle n'a pas commencé, sinon demain. */
  private nextWindowMs(config: WindowConfig): number {
    const offset = this.clock.timezoneOffsetMinutes() * 60_000
    const minute = localMinutesOfDay(this.clock)
    const local = new Date(this.clock.now() - offset)
    if (minute < config.startMinute) {
      local.setUTCHours(0, config.startMinute, 0, 0)
    } else {
      local.setUTCHours(24, config.startMinute, 0, 0)
    }
    return local.getTime() + offset
  }
}

function fmt(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
