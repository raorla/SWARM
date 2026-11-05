/**
 * Contrat unifié des providers LLM.
 *
 * Un seul module sort du navigateur (`llm/client.ts`) : c'est ce qui rend la promesse
 * « zéro donnée sortante sauf vers votre provider » vérifiable par lecture, et non par
 * confiance. Un `fetch` ailleurs dans `src/` est un bug de revue, et un lint le signale.
 */
import type { z } from 'zod'

export type ProviderId =
  'openrouter' | 'anthropic' | 'openai' | 'gemini' | 'xai' | 'openai-compatible'

/** Rôle fonctionnel de l'appel — sert au routage de modèle et au budget segmenté. */
export type AgentRole =
  'qualifier' | 'strategist' | 'writer' | 'critic' | 'analyst' | 'selftest'

/**
 * Effort. Aligné sur `output_config.effort` côté Anthropic ; les providers qui ne le
 * supportent pas l'ignorent silencieusement plutôt que d'échouer — on ne veut pas qu'un
 * réglage de coût casse un provider local.
 */
export type Effort = 'low' | 'medium' | 'high'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /**
   * Marque une frontière de cache. Le préfixe stable (Voice Profile, guardrails,
   * patterns) est ~85 % du prompt de WRITER et CRITIC : sans cache, le coût par
   * opportunité triple. Voir SPEC §3.2 et FEEDBACK R-03.
   */
  cacheable?: boolean
}

export interface LlmRequest {
  role: AgentRole
  model: string
  messages: readonly LlmMessage[]
  maxOutputTokens: number
  effort?: Effort
  /** Schéma attendu de la réponse. Sa présence active la validation + réparation. */
  jsonSchema?: z.ZodType
  /** Étiquette lisible pour le journal et le cockpit. */
  label?: string
}

/** Usage tel que **rapporté par le provider**. Jamais estimé — SPEC §3.2, règle 2. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Tokens lus depuis le cache, facturés à taux réduit. `0` si non rapporté. */
  cacheReadTokens: number
  /** Tokens écrits en cache, facturés à taux majoré. */
  cacheWriteTokens: number
  /**
   * Tokens de réflexion, quand le provider les distingue. Ils sont facturés en output :
   * les ignorer ferait mentir le compteur de budget d'un facteur inconnu.
   */
  reasoningTokens: number
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
}

export interface LlmResponse<T = string> {
  /** Texte brut renvoyé par le modèle. */
  text: string
  /** Objet validé, présent uniquement si `jsonSchema` était fourni. */
  data?: T
  usage: TokenUsage
  costEur: number
  model: string
  provider: ProviderId
  /** Vrai si la réponse a nécessité une réparation de JSON — métrique de qualité. */
  repaired: boolean
  latencyMs: number
}

export interface ProviderCredentials {
  providerId: ProviderId
  apiKey: string
  /** Requis pour `openai-compatible` (Ollama, LM Studio). */
  baseUrl?: string
}

/** Contrat que chaque provider implémente. Volontairement minimal. */
export interface Provider {
  readonly id: ProviderId
  readonly label: string
  /** Domaine à demander dans `optional_host_permissions`. */
  originPattern(creds: ProviderCredentials): string
  /** Vrai si le provider propage le cache de prompt — décide du routage (FEEDBACK R-03). */
  readonly supportsPromptCache: boolean
  complete(
    req: LlmRequest,
    creds: ProviderCredentials,
    signal: AbortSignal,
  ): Promise<{ text: string; usage: TokenUsage; model: string }>
}
