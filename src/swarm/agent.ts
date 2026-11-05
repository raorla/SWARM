/**
 * Interface commune des agents du swarm.
 *
 * L'intérêt n'est pas l'abstraction pour elle-même : c'est que **chaque appel d'agent
 * produise sa trace** — coût réel, latence, réparation de JSON, hash de prompt — sans que
 * chaque agent ait à s'en souvenir. La boucle d'apprentissage de la Phase 5 dépend
 * entièrement de cette trace ; la laisser à la discipline de chaque agent garantirait qu'un
 * agent l'oublie un jour, et l'oubli serait invisible.
 */
import type { AgentRole, LlmMessage } from '@/llm/types'
import type { LlmClient } from '@/llm/client'
import type { LlmError } from '@/llm/errors'
import type { AgentTrailStep } from '@/db/schema'
import type { RouteContext } from '@/llm/router'
import type { Result } from '@/shared/result'
import { err, ok } from '@/shared/result'
import type { z } from 'zod'
import type { PromptId } from './prompts'
import { loadPrompt } from './prompts'

export interface AgentContext {
  client: LlmClient
  /** Rang EV de l'opportunité, pour l'escalade de modèle du WRITER. */
  routeContext?: RouteContext
  signal?: AbortSignal
}

export interface AgentRun<Output> {
  output: Output
  step: AgentTrailStep
}

export type AgentFailure =
  { kind: 'llm'; error: LlmError } | { kind: 'refused'; reason: string }

/**
 * Un agent transforme une entrée en sortie validée, et rend compte de son coût.
 *
 * `refused` est distinct de `llm` : un agent qui décide de ne rien produire — le CRITIC qui
 * pose son veto, le WRITER qui ne trouve pas d'angle — n'est pas en panne. C'est un
 * résultat, et le confondre avec une erreur technique ferait remonter des alertes pour un
 * fonctionnement normal (SPEC §4.5).
 */
export interface Agent<Input, Output> {
  readonly role: AgentRole
  readonly promptId: PromptId
  run(input: Input, ctx: AgentContext): Promise<Result<AgentRun<Output>, AgentFailure>>
}

export interface DefineAgentOptions<Input, Output, S extends z.ZodType> {
  role: AgentRole
  promptId: PromptId
  schema: S
  /**
   * Construit les messages. Le préfixe stable doit être marqué `cacheable` : c'est lui qui
   * fait passer le coût d'entrée de plein tarif à un dixième (SPEC §3.2, règle 1).
   */
  buildMessages(input: Input, promptContent: string): LlmMessage[] | Promise<LlmMessage[]>
  /**
   * Traduit la sortie validée en résultat métier. Peut refuser — un refus n'est pas une
   * erreur.
   */
  interpret(raw: z.output<S>, input: Input): Result<Output, AgentFailure>
  label?(input: Input): string
}

/**
 * Fabrique d'agent : centralise le chargement du prompt, la validation et la trace.
 *
 * Chaque agent n'écrit donc que ce qui lui est propre — ses messages et son interprétation.
 * Tout le reste est identique par construction, ce qui est le seul moyen fiable de garantir
 * que la trace est complète pour tous.
 */
export function defineAgent<Input, Output, S extends z.ZodType>(
  options: DefineAgentOptions<Input, Output, S>,
): Agent<Input, Output> {
  return {
    role: options.role,
    promptId: options.promptId,

    async run(input, ctx): Promise<Result<AgentRun<Output>, AgentFailure>> {
      const prompt = await loadPrompt(options.promptId)
      const messages = await options.buildMessages(input, prompt.content)

      const response = await ctx.client.call({
        role: options.role,
        messages,
        schema: options.schema,
        ...(ctx.routeContext !== undefined ? { routeContext: ctx.routeContext } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(options.label !== undefined ? { label: options.label(input) } : {}),
      })

      if (!response.ok) return err({ kind: 'llm', error: response.error })

      const data = response.value.data
      if (data === undefined) {
        // Schéma fourni mais `data` absent : incohérence interne du client, pas du modèle.
        return err({
          kind: 'refused',
          reason: 'réponse validée sans données — incohérence du client LLM',
        })
      }

      const step: AgentTrailStep = {
        role: options.role,
        model: response.value.model,
        provider: response.value.provider,
        costEur: response.value.costEur,
        tokens: {
          input: response.value.usage.inputTokens,
          output: response.value.usage.outputTokens,
        },
        latencyMs: response.value.latencyMs,
        repaired: response.value.repaired,
        promptVersionHash: prompt.hash,
      }

      const interpreted = options.interpret(data, input)
      // La trace est produite **même en cas de refus** : un veto du CRITIC a coûté un appel,
      // et ce coût doit apparaître dans le budget comme dans les analytics. Ne le compter
      // qu'en cas de succès sous-estimerait systématiquement la dépense réelle.
      if (!interpreted.ok) return err(interpreted.error)

      return ok({ output: interpreted.value, step })
    },
  }
}

/** Coût cumulé d'une chaîne d'agents. */
export function totalCost(trail: readonly AgentTrailStep[]): number {
  return trail.reduce((sum, step) => sum + step.costEur, 0)
}

/** Vrai si un agent de la chaîne a nécessité une réparation — métrique de qualité. */
export function anyRepaired(trail: readonly AgentTrailStep[]): boolean {
  return trail.some((step) => step.repaired)
}
