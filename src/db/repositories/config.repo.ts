/**
 * Accès à la configuration. Seul point d'écriture de la table `config`.
 */
import type { SwarmDb } from '../index'
import type { ConfigRecord } from '../schema'
import { DEFAULT_CAPS, DEFAULT_CADENCE, DEFAULT_WINDOW } from '@/governor/types'
import { DEFAULT_BUDGET } from '@/llm/budget'
import { DEFAULT_VETO_THRESHOLD } from '@/swarm/schemas/critic.io'
import { DEFAULT_RUN_MODE } from '@/shared/env'
import { FALLBACK_PACK_ID } from '@/niches/loader'
import { cryptoRng } from '@/shared/rng'
import type { Clock } from '@/shared/time'

/**
 * La graine d'installation détermine quels jours sont des jours off. Elle doit être
 * stable à vie et différente d'un utilisateur à l'autre — sinon tous les utilisateurs
 * de SWARM feraient une pause les mêmes jours, ce qui serait un signal détectable.
 */
function newInstallSeed(): string {
  // `padStart` n'est pas cosmétique : sans lui, `toString(16)` perd les zéros de tête et
  // la graine a une longueur variable — ce qui casse toute comparaison de format et rend
  // les collisions plus probables qu'annoncé.
  return Array.from({ length: 4 }, () =>
    Math.floor(cryptoRng.next() * 0x1_0000_0000)
      .toString(16)
      .padStart(8, '0'),
  ).join('')
}

export function defaultConfig(clock: Clock): ConfigRecord {
  void clock
  return {
    id: 'current',
    activeNichePackId: FALLBACK_PACK_ID,
    mode: DEFAULT_RUN_MODE,
    installSeed: newInstallSeed(),
    caps: { ...DEFAULT_CAPS },
    cadence: { ...DEFAULT_CADENCE },
    window: { ...DEFAULT_WINDOW, activeDays: [...DEFAULT_WINDOW.activeDays] },
    budget: { ...DEFAULT_BUDGET },
    locale: 'fr',
    consentAcceptedAtMs: null,
    retentionDays: 30,
    ownHandle: null,
    // Par défaut la chaîne complète : c'est le produit. La référence one-shot est un
    // réglage de comparaison, pas un mode de repli.
    draftMode: 'chain',
    criticVetoThreshold: DEFAULT_VETO_THRESHOLD,
  }
}

export class ConfigRepo {
  constructor(
    private readonly database: SwarmDb,
    private readonly clock: Clock,
  ) {}

  /** Crée la config par défaut au premier appel. Jamais `undefined` en retour. */
  async get(): Promise<ConfigRecord> {
    const existing = await this.database.config.get('current')
    if (existing) return existing
    const fresh = defaultConfig(this.clock)
    await this.database.config.put(fresh)
    return fresh
  }

  async update(
    patch: Partial<Omit<ConfigRecord, 'id' | 'installSeed'>>,
  ): Promise<ConfigRecord> {
    const current = await this.get()
    // `installSeed` est exclu du type de patch, mais on le retire aussi à l'exécution :
    // le typage ne protège pas d'un objet venu d'un `JSON.parse` (import de config,
    // restauration de sauvegarde). Modifier la graine changerait les jours off d'une
    // installation existante, ce qui n'a aucun sens légitime.
    const { installSeed: _ignored, id: _id, ...safe } = patch as Partial<ConfigRecord>
    const next: ConfigRecord = { ...current, ...safe }
    await this.database.config.put(next)
    return next
  }

  async acceptConsent(): Promise<void> {
    await this.update({ consentAcceptedAtMs: this.clock.now() })
  }

  async hasConsented(): Promise<boolean> {
    return (await this.get()).consentAcceptedAtMs !== null
  }
}
