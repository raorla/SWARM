/**
 * Compteur de budget — SPEC §3.2 et §3.3, FEEDBACK MH-05.
 *
 * Deux propriétés qui distinguent ce compteur d'un simple total :
 *
 *  1. **Il lit l'usage rapporté par le provider, jamais une estimation de longueur.**
 *     Les modèles récents ont la réflexion adaptative active par défaut et la facturent
 *     en tokens de sortie. Estimer depuis le texte visible ferait mentir le compteur
 *     d'un facteur inconnu — et un plafond de dépense qui ment n'est pas un plafond.
 *
 *  2. **Il est segmenté.** 25 % du budget quotidien sont réservés à CRITIC et ANALYST.
 *     Avec une enveloppe unique, une journée de triage vorace épuise le budget avant la
 *     relecture, et le système publie sans contrôle qualité — précisément le mode de
 *     défaillance que le CRITIC existe pour empêcher, réintroduit par la comptabilité.
 */
import type { AgentRole, TokenUsage } from './types'
import type { Denial } from '@/governor/types'
import { localDayKey, type Clock } from '@/shared/time'

/** Rôles couverts par la réserve qualité. */
const RESERVED_ROLES: readonly AgentRole[] = ['critic', 'analyst']

export interface BudgetConfig {
  dailyEur: number
  /** Fraction sanctuarisée pour les rôles de contrôle, dans [0, 0.9]. */
  reserveFraction: number
}

export const DEFAULT_BUDGET: BudgetConfig = { dailyEur: 1, reserveFraction: 0.25 }

export interface DaySpend {
  /** Dépense par rôle, en euros. */
  byRole: Partial<Record<AgentRole, number>>
  /** Tokens cumulés, pour le diagnostic et l'onglet Analytics. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Vrai si au moins un appel a été facturé à un tarif inconnu (prix non synchronisé). */
  hasEstimatedPrices: boolean
}

const emptyDay = (): DaySpend => ({
  byRole: {},
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  hasEstimatedPrices: false,
})

export interface BudgetStore {
  read(): Promise<Record<string, DaySpend>>
  write(state: Record<string, DaySpend>): Promise<void>
}

export function memoryBudgetStore(initial: Record<string, DaySpend> = {}): BudgetStore {
  let state = structuredClone(initial)
  return {
    read: async () => structuredClone(state),
    write: async (s) => {
      state = structuredClone(s)
    },
  }
}

export function chromeBudgetStore(key = 'swarm:budget'): BudgetStore {
  return {
    read: async () => {
      const got = await chrome.storage.local.get(key)
      return (got[key] as Record<string, DaySpend> | undefined) ?? {}
    },
    write: async (state) => {
      await chrome.storage.local.set({ [key]: state })
    },
  }
}

export interface BudgetSnapshot {
  dayKey: string
  spentEur: number
  budgetEur: number
  remainingEur: number
  /** Reste disponible pour les rôles non réservés (triage, stratégie, rédaction). */
  remainingGeneralEur: number
  reserveEur: number
  byRole: Partial<Record<AgentRole, number>>
  hasEstimatedPrices: boolean
}

export class BudgetMeter {
  constructor(
    private readonly store: BudgetStore,
    private readonly clock: Clock,
    private config: BudgetConfig = DEFAULT_BUDGET,
  ) {}

  setConfig(config: BudgetConfig): void {
    this.config = config
  }

  private async day(): Promise<DaySpend> {
    const state = await this.store.read()
    return state[localDayKey(this.clock)] ?? emptyDay()
  }

  private static total(day: DaySpend): number {
    return Object.values(day.byRole).reduce((a, b) => a + (b ?? 0), 0)
  }

  /**
   * Un rôle réservé peut puiser dans tout le budget ; un rôle général s'arrête à la
   * frontière de la réserve. C'est asymétrique exprès : la réserve protège le contrôle
   * qualité, pas l'inverse.
   */
  async availableFor(role: AgentRole): Promise<number> {
    const day = await this.day()
    const spent = BudgetMeter.total(day)
    const ceiling = RESERVED_ROLES.includes(role)
      ? this.config.dailyEur
      : this.config.dailyEur * (1 - this.config.reserveFraction)
    return Math.max(0, ceiling - spent)
  }

  /**
   * À appeler **avant** un appel, avec le coût maximal estimé de cet appel.
   * On refuse en amont plutôt que de constater le dépassement après : un plafond qu'on
   * ne peut constater qu'a posteriori n'est pas un plafond.
   */
  async check(role: AgentRole, estimatedCostEur: number): Promise<Denial | null> {
    const available = await this.availableFor(role)
    if (estimatedCostEur > available) {
      const isReserved = RESERVED_ROLES.includes(role)
      return {
        reason: 'budget-exhausted',
        detail: isReserved
          ? `budget épuisé : ${available.toFixed(4)} € disponibles pour ${role}`
          : `enveloppe générale épuisée (${available.toFixed(4)} € restants, réserve qualité préservée)`,
        retryAtMs: this.nextMidnightMs(),
      }
    }
    return null
  }

  /** Enregistre la dépense réelle après un appel. `usage` vient du provider. */
  async record(
    role: AgentRole,
    costEur: number,
    usage: TokenUsage,
    priceKnown = true,
  ): Promise<void> {
    const state = await this.store.read()
    const key = localDayKey(this.clock)
    const day = state[key] ?? emptyDay()
    day.byRole[role] = (day.byRole[role] ?? 0) + costEur
    day.tokens.input += usage.inputTokens
    day.tokens.output += usage.outputTokens
    day.tokens.cacheRead += usage.cacheReadTokens
    day.tokens.cacheWrite += usage.cacheWriteTokens
    if (!priceKnown) day.hasEstimatedPrices = true
    state[key] = day
    // 60 jours d'historique de dépense suffisent pour l'onglet Analytics.
    const keep = Object.keys(state).sort().slice(-60)
    await this.store.write(Object.fromEntries(keep.map((k) => [k, state[k]!])))
  }

  async snapshot(): Promise<BudgetSnapshot> {
    const day = await this.day()
    const spent = BudgetMeter.total(day)
    const reserve = this.config.dailyEur * this.config.reserveFraction
    return {
      dayKey: localDayKey(this.clock),
      spentEur: spent,
      budgetEur: this.config.dailyEur,
      remainingEur: Math.max(0, this.config.dailyEur - spent),
      remainingGeneralEur: Math.max(0, this.config.dailyEur - reserve - spent),
      reserveEur: reserve,
      byRole: day.byRole,
      hasEstimatedPrices: day.hasEstimatedPrices,
    }
  }

  private nextMidnightMs(): number {
    const offset = this.clock.timezoneOffsetMinutes() * 60_000
    const local = new Date(this.clock.now() - offset)
    local.setUTCHours(24, 0, 0, 0)
    return local.getTime() + offset
  }
}
