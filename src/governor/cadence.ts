/**
 * Cadence — SPEC §2.1.
 *
 * En mode Copilote (le seul livré avant la Phase 8), la cadence ne protège pas d'un
 * bannissement : c'est l'utilisateur qui publie. Elle régule sa **charge d'attention** —
 * elle empêche 12 brouillons d'arriver en trois minutes, ce qui les ferait tous traiter
 * en survol. Le rôle change en Autopilote, la mécanique non.
 */
import { logNormalDelay, type Rng } from '@/shared/rng'
import { MINUTE, type Clock } from '@/shared/time'
import type { CadenceConfig, Denial } from './types'

export interface CadenceState {
  /** Instant de la dernière action autorisée, tous types confondus. */
  lastActionAtMs: number | null
  /** Délai tiré pour la prochaine action. Tiré une fois, pas à chaque vérification. */
  nextDelayMs: number | null
}

export interface CadenceStore {
  read(): Promise<CadenceState>
  write(state: CadenceState): Promise<void>
}

export function memoryCadenceStore(
  initial: CadenceState = { lastActionAtMs: null, nextDelayMs: null },
): CadenceStore {
  let state = { ...initial }
  return {
    read: async () => ({ ...state }),
    write: async (s) => {
      state = { ...s }
    },
  }
}

export function chromeCadenceStore(key = 'swarm:cadence'): CadenceStore {
  return {
    read: async () => {
      const got = await chrome.storage.local.get(key)
      return (
        (got[key] as CadenceState | undefined) ?? {
          lastActionAtMs: null,
          nextDelayMs: null,
        }
      )
    },
    write: async (state) => {
      await chrome.storage.local.set({ [key]: state })
    },
  }
}

export class CadenceGuard {
  constructor(
    private readonly store: CadenceStore,
    private readonly clock: Clock,
    private readonly rng: Rng,
  ) {}

  /**
   * Le délai est tiré **une seule fois** puis mémorisé, au lieu d'être retiré à chaque
   * vérification. Retirer à chaque appel produirait un biais : à force de vérifier, on
   * finirait toujours par tomber sur un tirage court, ce qui vide la contrainte de son
   * sens tout en donnant l'apparence de la respecter.
   */
  async check(config: CadenceConfig): Promise<Denial | null> {
    const state = await this.store.read()
    if (state.lastActionAtMs === null) return null

    const minMs = Math.max(0, config.minMinutes) * MINUTE
    const maxMs = Math.max(minMs, config.maxMinutes * MINUTE)

    let delay = state.nextDelayMs
    if (delay === null) {
      delay = logNormalDelay(this.rng, minMs, maxMs)
      await this.store.write({ ...state, nextDelayMs: delay })
    }

    const readyAt = state.lastActionAtMs + delay
    const now = this.clock.now()
    if (now < readyAt) {
      const waitMin = Math.ceil((readyAt - now) / MINUTE)
      return {
        reason: 'cadence',
        detail: `prochaine action dans ~${waitMin} min`,
        retryAtMs: readyAt,
      }
    }
    return null
  }

  /** À appeler après une action autorisée : réarme le délai suivant. */
  async record(): Promise<void> {
    await this.store.write({ lastActionAtMs: this.clock.now(), nextDelayMs: null })
  }

  /** Instant au plus tôt de la prochaine action, pour l'UI. Ne consomme pas de tirage. */
  async readyAtMs(config: CadenceConfig): Promise<number> {
    const state = await this.store.read()
    if (state.lastActionAtMs === null) return this.clock.now()
    const fallback = Math.max(0, config.minMinutes) * MINUTE
    return state.lastActionAtMs + (state.nextDelayMs ?? fallback)
  }

  /** Vidé par le kill switch : au redémarrage on ne doit pas hériter d'une dette de délai. */
  async reset(): Promise<void> {
    await this.store.write({ lastActionAtMs: null, nextDelayMs: null })
  }
}
