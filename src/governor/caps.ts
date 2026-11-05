/**
 * Plafonds quotidiens — SPEC §2.1.
 *
 * Les compteurs sont partitionnés par jour local (`localDayKey`) : un plafond calé sur
 * UTC se réinitialiserait au milieu de la soirée d'un utilisateur européen, ce qui
 * doublerait de fait le plafond du soir.
 */
import type { ActionType, DailyCaps, Denial } from './types'
import { localDayKey, type Clock } from '@/shared/time'

export type CapCounters = Record<string, Partial<Record<ActionType, number>>>

export interface CapStore {
  read(): Promise<CapCounters>
  write(counters: CapCounters): Promise<void>
}

/** Store en mémoire — utilisé par les tests et le mode simulation. */
export function memoryCapStore(initial: CapCounters = {}): CapStore {
  let state: CapCounters = structuredClone(initial)
  return {
    read: async () => structuredClone(state),
    write: async (c) => {
      state = structuredClone(c)
    },
  }
}

/** Store adossé à `chrome.storage.local` — survit à la mort du service worker. */
export function chromeCapStore(key = 'swarm:caps'): CapStore {
  return {
    read: async () => {
      const got = await chrome.storage.local.get(key)
      return (got[key] as CapCounters | undefined) ?? {}
    },
    write: async (counters) => {
      await chrome.storage.local.set({ [key]: counters })
    },
  }
}

/**
 * Le DM est plafonné à 0 et ce n'est pas un réglage : SPEC §2.2 interdit l'envoi
 * automatique de DM, et le code d'envoi n'existe pas. On le vérifie ici pour que
 * l'intention soit appliquée même si une config corrompue disait le contraire.
 */
const NON_RAISABLE: readonly ActionType[] = ['dm']

export class CapsGuard {
  constructor(
    private readonly store: CapStore,
    private readonly clock: Clock,
  ) {}

  private effectiveCap(caps: DailyCaps, action: ActionType): number {
    if (NON_RAISABLE.includes(action)) return 0
    return Math.max(0, caps[action] ?? 0)
  }

  async used(action: ActionType): Promise<number> {
    const counters = await this.store.read()
    return counters[localDayKey(this.clock)]?.[action] ?? 0
  }

  async check(caps: DailyCaps, action: ActionType): Promise<Denial | null> {
    const cap = this.effectiveCap(caps, action)
    if (cap === 0) {
      return {
        reason: 'cap-reached',
        detail: NON_RAISABLE.includes(action)
          ? `${action} est désactivé par conception (SPEC §2.2)`
          : `plafond de ${action} réglé à 0`,
      }
    }
    const used = await this.used(action)
    if (used >= cap) {
      return {
        reason: 'cap-reached',
        detail: `${action} : ${used}/${cap} atteint aujourd’hui`,
        retryAtMs: this.nextMidnightMs(),
      }
    }
    return null
  }

  /** Incrémente le compteur du jour. Appelé après une action réellement effectuée. */
  async increment(action: ActionType, by = 1): Promise<void> {
    const counters = await this.store.read()
    const day = localDayKey(this.clock)
    const forDay = counters[day] ?? {}
    forDay[action] = (forDay[action] ?? 0) + by
    counters[day] = forDay
    // On ne garde que 30 jours : au-delà c'est de l'historique, et l'historique est en
    // base (table `actions`), pas dans un compteur de garde-fou.
    const keep = Object.keys(counters).sort().slice(-30)
    await this.store.write(Object.fromEntries(keep.map((k) => [k, counters[k]!])))
  }

  async snapshot(
    caps: DailyCaps,
  ): Promise<Record<string, { used: number; cap: number }>> {
    const counters = await this.store.read()
    const forDay = counters[localDayKey(this.clock)] ?? {}
    const out: Record<string, { used: number; cap: number }> = {}
    for (const action of Object.keys(caps) as ActionType[]) {
      out[action] = { used: forDay[action] ?? 0, cap: this.effectiveCap(caps, action) }
    }
    return out
  }

  private nextMidnightMs(): number {
    const d = this.clock.date()
    const local = new Date(d.getTime() - this.clock.timezoneOffsetMinutes() * 60_000)
    local.setUTCHours(24, 0, 0, 0)
    return local.getTime() + this.clock.timezoneOffsetMinutes() * 60_000
  }
}
