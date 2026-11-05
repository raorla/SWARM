/**
 * Kill switch — FEEDBACK MH-03.
 *
 * Persisté, pas en mémoire. Un service worker MV3 est tué sans préavis ; un kill switch
 * en RAM se relève tout seul au réveil suivant, c'est-à-dire qu'il ne fonctionne pas —
 * et précisément dans le cas où on en a besoin.
 *
 * L'état est absorbant : seul un `release()` explicite en sort. Aucun délai, aucune
 * expiration, aucune reprise automatique.
 */
import { createLogger } from '@/shared/logger'
import type { Clock } from '@/shared/time'

const log = createLogger('governor:killswitch')
const KEY = 'swarm:killswitch'

export interface KillSwitchState {
  engaged: boolean
  engagedAtMs: number | null
  reason: string | null
}

const RELEASED: KillSwitchState = { engaged: false, engagedAtMs: null, reason: null }

export interface KillSwitchStore {
  read(): Promise<KillSwitchState>
  write(state: KillSwitchState): Promise<void>
}

export function memoryKillSwitchStore(
  initial: KillSwitchState = RELEASED,
): KillSwitchStore {
  let state = { ...initial }
  return {
    read: async () => ({ ...state }),
    write: async (s) => {
      state = { ...s }
    },
  }
}

export function chromeKillSwitchStore(key = KEY): KillSwitchStore {
  return {
    read: async () => {
      const got = await chrome.storage.local.get(key)
      return (got[key] as KillSwitchState | undefined) ?? RELEASED
    },
    write: async (state) => {
      await chrome.storage.local.set({ [key]: state })
    },
  }
}

export class KillSwitch {
  constructor(
    private readonly store: KillSwitchStore,
    private readonly clock: Clock,
  ) {}

  async isEngaged(): Promise<boolean> {
    return (await this.store.read()).engaged
  }

  async state(): Promise<KillSwitchState> {
    return this.store.read()
  }

  /**
   * `onEngage` reçoit le vidage de la file. Il est appelé *après* la persistance de
   * l'état : si le service worker meurt pendant le vidage, l'état arrêté est déjà en
   * base et rien ne redémarre. L'ordre inverse laisserait une fenêtre où la file est
   * vidée mais le swarm se croit actif.
   */
  async engage(reason: string, onEngage?: () => Promise<void>): Promise<void> {
    await this.store.write({ engaged: true, engagedAtMs: this.clock.now(), reason })
    log.warn('kill switch activé', { reason })
    if (onEngage) {
      try {
        await onEngage()
      } catch (e) {
        // On ne remonte pas : l'arrêt a réussi, le nettoyage a échoué. Le nettoyage se
        // rattrape au prochain démarrage, l'arrêt ne se rattrape pas.
        log.error('vidage de la file en échec après arrêt', { error: e })
      }
    }
  }

  async release(): Promise<void> {
    await this.store.write(RELEASED)
    log.info('kill switch relâché')
  }
}
