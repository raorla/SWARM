/**
 * LLM CLIENT — le seul module de SWARM qui sort du navigateur.
 *
 * C'est ce qui rend la promesse de PRIVACY.md vérifiable par lecture : un `fetch` ailleurs
 * dans `src/` est un bug de revue, et un lint le signale. Tout appel passe ici, donc tout
 * appel est compté, plafonné, journalisé et validé.
 *
 * Séquence d'un appel :
 *   permission d'hôte → budget (avant) → provider (avec retry) → usage réel →
 *   coût → validation Zod → réparation si besoin → budget (après).
 */
import { getProvider } from './providers'
import { LlmError, describeLlmError } from './errors'
import { DEFAULT_RETRY, realSleep, withRetry, type RetryPolicy } from './retry'
import { buildRepairInstruction, repairAndParse } from './json-repair'
import { computeCostEur, FALLBACK_TABLE, USD_TO_EUR, type PriceTable } from './pricing'
import {
  resolveRoute,
  worstCaseCostEur,
  DEFAULT_ROUTING,
  type RouteContext,
  type RoutingTable,
} from './router'
import type { BudgetMeter } from './budget'
import type { Keystore } from './keystore'
import type { AgentRole, LlmMessage, LlmResponse, ProviderId } from './types'
import { cryptoRng, type Rng } from '@/shared/rng'
import { systemClock, type Clock } from '@/shared/time'
import { err, ok, type Result } from '@/shared/result'
import { createLogger } from '@/shared/logger'
import type { z } from 'zod'

const log = createLogger('llm')

export interface LlmClientDeps {
  keystore: Keystore
  budget: BudgetMeter
  clock?: Clock
  rng?: Rng
  routing?: RoutingTable
  prices?: PriceTable
  retry?: RetryPolicy
  /**
   * Vérifie la permission d'hôte. Injectable pour les tests, et parce que le content
   * script n'a pas le droit d'appeler `chrome.permissions`.
   */
  hasHostPermission?: (origin: string) => Promise<boolean>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface CallOptions<S extends z.ZodType | undefined = undefined> {
  role: AgentRole
  /** Messages ; marquer `cacheable` sur le préfixe stable (SPEC §3.2 règle 1). */
  messages: readonly LlmMessage[]
  schema?: S
  routeContext?: RouteContext
  /** Surcharge ponctuelle du modèle — utilisée par l'écran de test et le backtest. */
  overrideModel?: string
  overrideProvider?: ProviderId
  signal?: AbortSignal
  label?: string
}

export type CallResult<T> = Result<LlmResponse<T>, LlmError>

export class LlmClient {
  private readonly clock: Clock
  private readonly rng: Rng
  private readonly routing: RoutingTable
  private prices: PriceTable
  private readonly retry: RetryPolicy
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(private readonly deps: LlmClientDeps) {
    this.clock = deps.clock ?? systemClock
    this.rng = deps.rng ?? cryptoRng
    this.routing = deps.routing ?? DEFAULT_ROUTING
    this.prices = deps.prices ?? FALLBACK_TABLE
    this.retry = deps.retry ?? DEFAULT_RETRY
    this.sleep = deps.sleep ?? realSleep
  }

  setPrices(table: PriceTable): void {
    this.prices = table
  }

  get priceTable(): PriceTable {
    return this.prices
  }

  /** Appel typé. `schema` fourni ⇒ `data` est présent et validé. */
  async call<S extends z.ZodType>(
    opts: CallOptions<S> & { schema: S },
  ): Promise<CallResult<z.output<S>>>
  async call(opts: CallOptions<undefined>): Promise<CallResult<never>>
  async call<S extends z.ZodType>(
    opts: CallOptions<S | undefined>,
  ): Promise<CallResult<unknown>> {
    const route = resolveRoute(this.routing, opts.role, opts.routeContext ?? {})
    const providerId = opts.overrideProvider ?? route.providerId
    const model = opts.overrideModel ?? route.model

    const provider = getProvider(providerId)
    if (!provider) {
      return err(
        new LlmError('bad-request', `provider « ${providerId} » non implémenté`, {
          provider: providerId,
        }),
      )
    }

    const creds = this.deps.keystore.credentials(providerId)
    if (!creds) {
      return err(
        new LlmError('auth', `aucune clé configurée pour ${provider.label}`, {
          provider: providerId,
        }),
      )
    }

    // 1. Permission d'hôte. Demandée au runtime, donc potentiellement absente.
    if (this.deps.hasHostPermission) {
      const origin = provider.originPattern(creds)
      if (!(await this.deps.hasHostPermission(origin))) {
        return err(
          new LlmError('no-permission', `permission d’accès à ${origin} non accordée`, {
            provider: providerId,
          }),
        )
      }
    }

    // 2. Budget, AVANT l'appel. Un plafond qu'on ne constate qu'après n'en est pas un.
    const estimatedInput = estimateInputTokens(opts.messages)
    const priceForModel = this.prices.prices[model] ?? {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    }
    const worstCase = worstCaseCostEur(
      { ...route, model },
      estimatedInput,
      priceForModel,
      USD_TO_EUR,
    )
    const denial = await this.deps.budget.check(opts.role, worstCase)
    if (denial) {
      return err(
        new LlmError('budget-exhausted', denial.detail, { provider: providerId, model }),
      )
    }

    // 3. Appel, avec retry sur les erreurs retryables uniquement.
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const started = this.clock.now()

    let text: string
    let usage: LlmResponse['usage']
    let actualModel = model
    try {
      const result = await withRetry(
        () =>
          provider.complete(
            {
              role: opts.role,
              model,
              messages: opts.messages,
              maxOutputTokens: route.maxOutputTokens,
              // Omis, pas passé à `undefined` : sous `exactOptionalPropertyTypes`, la
              // distinction est réelle — et côté provider, un `effort` présent active le
              // raisonnement, facturé en sortie.
              ...(route.effort !== undefined ? { effort: route.effort } : {}),
              ...(opts.schema ? { jsonSchema: opts.schema } : {}),
              ...(opts.label ? { label: opts.label } : {}),
            },
            creds,
            controller.signal,
          ),
        this.retry,
        { rng: this.rng, clock: this.clock, sleep: this.sleep },
        controller.signal,
      )
      text = result.text
      usage = result.usage
      actualModel = result.model
    } catch (e) {
      const error = e instanceof LlmError ? e : new LlmError('unknown', String(e))
      log.warn('appel LLM en échec', {
        role: opts.role,
        model,
        kind: error.kind,
        detail: describeLlmError(error),
      })
      return err(error)
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }

    // 4. Coût depuis l'usage RÉEL rapporté par le provider (SPEC §3.2 règle 2).
    const { eur, priceKnown } = computeCostEur(this.prices, actualModel, usage)
    await this.deps.budget.record(opts.role, eur, usage, priceKnown)

    const base: LlmResponse<unknown> = {
      text,
      usage,
      costEur: eur,
      model: actualModel,
      provider: providerId,
      repaired: false,
      latencyMs: this.clock.now() - started,
    }

    if (!opts.schema) return ok(base)

    // 5. Validation, puis réparation locale gratuite avant tout second appel.
    const parsed = repairAndParse(text, opts.schema)
    if (parsed.ok) {
      return ok({ ...base, data: parsed.value.value, repaired: parsed.value.repaired })
    }

    log.info('JSON hors schéma, tentative de reprise', {
      role: opts.role,
      issues: parsed.error.slice(0, 4),
    })

    // 6. Second appel avec consigne de reprise. Une seule fois : si le modèle échoue
    //    deux fois sur le même schéma, le problème est le prompt ou le schéma, pas le
    //    hasard — et insister coûterait du budget pour rien.
    const retryDenial = await this.deps.budget.check(opts.role, worstCase)
    if (retryDenial) {
      return err(
        new LlmError(
          'invalid-json',
          'JSON invalide et budget insuffisant pour reprendre',
          {
            provider: providerId,
            model,
          },
        ),
      )
    }

    const repairMessages: LlmMessage[] = [
      ...opts.messages,
      { role: 'assistant', content: text.slice(0, 2_000) },
      { role: 'user', content: buildRepairInstruction(parsed.error) },
    ]

    try {
      const second = await provider.complete(
        {
          role: opts.role,
          model,
          messages: repairMessages,
          maxOutputTokens: route.maxOutputTokens,
          effort: 'low', // la reprise est mécanique : pas besoin de réflexion.
          ...(opts.schema ? { jsonSchema: opts.schema } : {}),
        },
        creds,
        controller.signal,
      )
      const secondCost = computeCostEur(this.prices, second.model, second.usage)
      await this.deps.budget.record(
        opts.role,
        secondCost.eur,
        second.usage,
        secondCost.priceKnown,
      )

      const reparsed = repairAndParse(second.text, opts.schema)
      if (!reparsed.ok) {
        return err(
          new LlmError(
            'invalid-json',
            `réponse hors schéma : ${reparsed.error.slice(0, 3).join(' ; ')}`,
            {
              provider: providerId,
              model,
            },
          ),
        )
      }
      return ok({
        ...base,
        text: second.text,
        data: reparsed.value.value,
        repaired: true,
        costEur: eur + secondCost.eur,
        usage: {
          inputTokens: usage.inputTokens + second.usage.inputTokens,
          outputTokens: usage.outputTokens + second.usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens + second.usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens + second.usage.cacheWriteTokens,
          reasoningTokens: usage.reasoningTokens + second.usage.reasoningTokens,
        },
        latencyMs: this.clock.now() - started,
      })
    } catch (e) {
      return err(e instanceof LlmError ? e : new LlmError('invalid-json', String(e)))
    }
  }
}

/**
 * Estimation grossière du nombre de tokens d'entrée, pour la vérification de budget
 * *avant* l'appel — le seul endroit où une estimation est légitime, puisque le vrai
 * chiffre n'existe pas encore. ~3,5 caractères par token, majoré de 15 % : on veut
 * refuser un appel qui *pourrait* dépasser.
 */
export function estimateInputTokens(messages: readonly LlmMessage[]): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0)
  return Math.ceil((chars / 3.5) * 1.15)
}
