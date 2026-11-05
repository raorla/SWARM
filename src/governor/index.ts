/**
 * GOVERNOR — l'unique porte vers une action sur X. SPEC §2.
 *
 * Invariant du produit : rien n'agit sur X sans un `StagePermit`, et seul ce module peut
 * en construire un (type marqué, cf. `types.ts`). Si vous devez contourner ce module,
 * c'est le design qui est faux, pas le governor.
 *
 * L'ordre des vérifications n'est pas arbitraire : on évalue du moins coûteux et du plus
 * absolu vers le plus coûteux et le plus contingent. Le kill switch d'abord, la cadence
 * ensuite. Ainsi un swarm arrêté ne consomme ni tirage aléatoire ni lecture de budget,
 * et le journal d'audit porte la *première* raison de refus — celle qui compte.
 */
import { CadenceGuard, type CadenceStore } from './cadence'
import { memoryCadenceStore } from './cadence'
import { CapsGuard, memoryCapStore, type CapStore } from './caps'
import { KillSwitch, memoryKillSwitchStore, type KillSwitchStore } from './killswitch'
import { WindowGuard } from './windows'
import { topicDenial } from './topic-guard'
import { AuditLog, memoryAuditStore, type AuditStore } from './audit'
import {
  DEFAULT_CADENCE,
  DEFAULT_CAPS,
  DEFAULT_WINDOW,
  type ActionType,
  type CadenceConfig,
  type DailyCaps,
  type Denial,
  type StagePermit,
  type WindowConfig,
} from './types'
import { AUTOPILOT_IMPLEMENTED, type RunMode } from '@/shared/env'
import { cryptoRng, type Rng } from '@/shared/rng'
import { MINUTE, systemClock, type Clock } from '@/shared/time'
import { err, ok, type Result } from '@/shared/result'
import { createLogger } from '@/shared/logger'

export * from './types'
export { classifyTopic, UNIVERSAL_BLOCKED, normalizeForMatching } from './topic-guard'
export { AuditLog, memoryAuditStore, hashEntry } from './audit'
export type { AuditEntry, AuditEventType, AuditStore } from './audit'
export { KillSwitch, memoryKillSwitchStore, chromeKillSwitchStore } from './killswitch'
export { memoryCapStore, chromeCapStore, CapsGuard } from './caps'
export { memoryCadenceStore, chromeCadenceStore, CadenceGuard } from './cadence'

const log = createLogger('governor')

/** Durée de validité d'un permis. Court : un permis périmé doit être redemandé, parce
 *  que la situation (budget, plafond, fenêtre) a pu changer entre-temps. */
export const PERMIT_TTL_MS = 10 * MINUTE

export interface GovernorConfig {
  mode: RunMode
  caps: DailyCaps
  cadence: CadenceConfig
  window: WindowConfig
  /** Graine d'installation, fixe : détermine quels jours sont des jours off. */
  installSeed: string
}

export const DEFAULT_GOVERNOR_CONFIG: Omit<GovernorConfig, 'mode' | 'installSeed'> = {
  caps: DEFAULT_CAPS,
  cadence: DEFAULT_CADENCE,
  window: DEFAULT_WINDOW,
}

export interface PermitRequest {
  actionType: ActionType
  idempotencyKey: string
  /** Texte du post visé — soumis au topic-guard. */
  targetText?: string
  /** Handle de l'auteur visé — comparé à la blocklist du pack. */
  targetHandle?: string
  /** Sujets bloqués additionnels du pack actif. */
  packBlockedTopics?: readonly string[]
  /** Blocklist de comptes du pack actif. */
  packBlocklist?: readonly string[]
  /** Agent demandeur, pour le journal d'audit. */
  actor: string
}

/** Dépendances injectées — c'est ce qui rend le module testable sur horloge simulée. */
export interface GovernorDeps {
  capStore: CapStore
  cadenceStore: CadenceStore
  killSwitchStore: KillSwitchStore
  auditStore: AuditStore
  clock?: Clock
  rng?: Rng
  /** Consulté avant d'accorder un permis. Renvoie `null` si le budget est disponible. */
  budgetCheck?: () => Promise<Denial | null>
  /** Vrai si cette clé d'idempotence a déjà produit une action (MH-07). */
  isDuplicate?: (idempotencyKey: string) => Promise<boolean>
}

/**
 * Actions que le code sait réellement exécuter aujourd'hui.
 *
 * `post`/`thread` arrivent en Phase 8, `follow`/`dm` n'arriveront pas — voir SPEC §2.2.
 * Déclarer la liste ici plutôt que de faire confiance à la config évite qu'une config
 * corrompue ou un futur bug d'UI ouvre un chemin d'exécution qui n'a jamais été pensé.
 */
const SUPPORTED_ACTIONS: readonly ActionType[] = ['reply', 'like', 'bookmark']

export class Governor {
  private readonly clock: Clock
  private readonly rng: Rng
  private readonly caps: CapsGuard
  private readonly cadence: CadenceGuard
  private readonly windows: WindowGuard
  readonly killSwitch: KillSwitch
  readonly audit: AuditLog

  constructor(
    private readonly config: GovernorConfig,
    private readonly deps: GovernorDeps,
  ) {
    this.clock = deps.clock ?? systemClock
    this.rng = deps.rng ?? cryptoRng
    this.caps = new CapsGuard(deps.capStore, this.clock)
    this.cadence = new CadenceGuard(deps.cadenceStore, this.clock, this.rng)
    this.windows = new WindowGuard(this.clock)
    this.killSwitch = new KillSwitch(deps.killSwitchStore, this.clock)
    this.audit = new AuditLog(deps.auditStore, this.clock)
  }

  /**
   * Unique chemin vers une action. Renvoie un permis ou un refus motivé — jamais une
   * exception : un refus est un résultat normal du système, pas une panne.
   */
  async requestPermit(req: PermitRequest): Promise<Result<StagePermit, Denial>> {
    const denial = await this.evaluate(req)
    if (denial) {
      await this.audit.record({
        type: 'permit.denied',
        actor: req.actor,
        actionType: req.actionType,
        idempotencyKey: req.idempotencyKey,
        denialReason: denial.reason,
        detail: denial.detail,
      })
      return err(denial)
    }

    const now = this.clock.now()
    const permit = {
      token: await this.mintToken(req.idempotencyKey, now),
      actionType: req.actionType,
      idempotencyKey: req.idempotencyKey,
      issuedAtMs: now,
      notBeforeMs: now,
      expiresAtMs: now + PERMIT_TTL_MS,
    } as StagePermit

    await this.audit.record({
      type: 'permit.granted',
      actor: req.actor,
      actionType: req.actionType,
      idempotencyKey: req.idempotencyKey,
    })
    return ok(permit)
  }

  /** Toutes les vérifications, dans l'ordre. Extrait pour être testable seul. */
  private async evaluate(req: PermitRequest): Promise<Denial | null> {
    // 1. Kill switch — absolu, et le moins coûteux à vérifier.
    if (await this.killSwitch.isEngaged()) {
      const state = await this.killSwitch.state()
      return {
        reason: 'killswitch',
        detail: state.reason ?? 'swarm arrêté manuellement',
      }
    }

    // 2. Mode. La simulation refuse tout, par conception (MH-15).
    if (this.config.mode === 'simulation') {
      return { reason: 'simulation', detail: 'mode simulation : aucune action réelle' }
    }
    if (this.config.mode === 'autopilot' && !AUTOPILOT_IMPLEMENTED) {
      // Le mode existe dans le type ; le code d'exécution n'existe pas (SPEC §4.6).
      return {
        reason: 'action-not-supported',
        detail: 'l’autopilote n’est pas implémenté (Phase 8)',
      }
    }

    // 3. Action réellement exécutable par le code présent.
    if (!SUPPORTED_ACTIONS.includes(req.actionType)) {
      return {
        reason: 'action-not-supported',
        detail: `${req.actionType} n’est pas implémenté par conception (SPEC §2.2)`,
      }
    }

    // 4. Doublon — avant toute dépense, et avant toute action visible (MH-07).
    if (this.deps.isDuplicate && (await this.deps.isDuplicate(req.idempotencyKey))) {
      return {
        reason: 'duplicate',
        detail: `action déjà effectuée pour ${req.idempotencyKey}`,
      }
    }

    // 5. Auteur exclu.
    if (req.targetHandle && req.packBlocklist?.length) {
      const h = req.targetHandle.replace(/^@/, '').toLowerCase()
      if (req.packBlocklist.some((b) => b.replace(/^@/, '').toLowerCase() === h)) {
        return {
          reason: 'blocked-author',
          detail: `@${req.targetHandle} est sur la blocklist`,
        }
      }
    }

    // 6. Sujet sensible — noyau universel + couche pack (MH-02).
    if (req.targetText) {
      const topic = topicDenial(req.targetText, req.packBlockedTopics ?? [])
      if (topic) return topic
    }

    // 7. Fenêtre horaire et jours off.
    const windowDenial = this.windows.check(this.config.window, this.config.installSeed)
    if (windowDenial) return windowDenial

    // 8. Plafond quotidien.
    const capDenial = await this.caps.check(this.config.caps, req.actionType)
    if (capDenial) return capDenial

    // 9. Budget. Placé après les plafonds : un plafond atteint est gratuit à constater,
    //    et éviter une lecture de budget inutile garde le triage bon marché.
    if (this.deps.budgetCheck) {
      const budgetDenial = await this.deps.budgetCheck()
      if (budgetDenial) return budgetDenial
    }

    // 10. Cadence — en dernier, parce que c'est la seule vérification qui consomme un
    //     tirage aléatoire et le mémorise.
    const cadenceDenial = await this.cadence.check(this.config.cadence)
    if (cadenceDenial) return cadenceDenial

    return null
  }

  /**
   * À appeler **après** que l'action a réellement eu lieu, pas à l'émission du permis.
   * Sinon un permis accordé puis non utilisé (utilisateur qui ignore un brouillon)
   * consommerait un quota, et le plafond deviendrait plus restrictif que promis.
   */
  async commit(permit: StagePermit): Promise<void> {
    await this.caps.increment(permit.actionType)
    await this.cadence.record()
    await this.audit.record({
      type: 'action.staged',
      actor: 'publisher',
      actionType: permit.actionType,
      idempotencyKey: permit.idempotencyKey,
    })
  }

  /** Le permis est-il encore valide au moment de l'exécution ? */
  isPermitValid(permit: StagePermit): boolean {
    const now = this.clock.now()
    return now >= permit.notBeforeMs && now < permit.expiresAtMs
  }

  async engageKillSwitch(
    reason: string,
    flushQueue?: () => Promise<void>,
  ): Promise<void> {
    await this.killSwitch.engage(reason, flushQueue)
    // La dette de cadence est effacée : au redémarrage, l'utilisateur ne doit pas
    // attendre un délai hérité d'avant l'arrêt.
    await this.cadence.reset()
    await this.audit.record({
      type: 'killswitch.engaged',
      actor: 'user',
      detail: reason,
    })
    log.warn('swarm arrêté', { reason })
  }

  async releaseKillSwitch(): Promise<void> {
    await this.killSwitch.release()
    await this.audit.record({ type: 'killswitch.released', actor: 'user' })
  }

  async snapshot(): Promise<{
    mode: RunMode
    killSwitchEngaged: boolean
    caps: Record<string, { used: number; cap: number }>
    nextActionAtMs: number
    isDayOff: boolean
  }> {
    return {
      mode: this.config.mode,
      killSwitchEngaged: await this.killSwitch.isEngaged(),
      caps: await this.caps.snapshot(this.config.caps),
      nextActionAtMs: await this.cadence.readyAtMs(this.config.cadence),
      isDayOff: this.windows.isDayOff(this.config.window, this.config.installSeed),
    }
  }

  /**
   * Jeton du permis : HMAC-like sur (clé, instant, graine d'installation).
   * Ce n'est pas une garantie cryptographique contre un attaquant local — dans une
   * extension, tout est lisible. C'est un détecteur d'incohérence : un content script
   * qui recevrait un jeton fabriqué ou périmé le rejette au lieu d'agir.
   */
  private async mintToken(idempotencyKey: string, atMs: number): Promise<string> {
    const material = `${this.config.installSeed}|${idempotencyKey}|${atMs}`
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(material),
    )
    return [...new Uint8Array(digest)]
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
}

/** Construit un governor entièrement en mémoire — tests et mode simulation. */
export function createInMemoryGovernor(
  overrides: Partial<GovernorConfig> = {},
  deps: Partial<GovernorDeps> = {},
): Governor {
  return new Governor(
    {
      mode: 'copilot',
      installSeed: 'test-seed',
      ...DEFAULT_GOVERNOR_CONFIG,
      ...overrides,
    },
    {
      capStore: memoryCapStore(),
      cadenceStore: memoryCadenceStore(),
      killSwitchStore: memoryKillSwitchStore(),
      auditStore: memoryAuditStore(),
      ...deps,
    },
  )
}
