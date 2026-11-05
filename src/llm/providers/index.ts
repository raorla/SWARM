import type { Provider, ProviderId } from '../types'
import { openRouterProvider } from './openrouter'
import { anthropicProvider } from './anthropic'
import { openAiCompatibleProvider } from './openai-compatible'

/**
 * Registre des providers.
 *
 * OpenAI, Gemini et xAI sont prévus par le type `ProviderId` mais pas encore
 * implémentés : leur absence est explicite (`getProvider` renvoie `undefined`) plutôt que
 * silencieuse. Trois providers couvrent les trois cas qui comptent aujourd'hui — un
 * agrégateur, un accès direct pour le cache, un endpoint local — et les autres suivront
 * le même contrat de 60 lignes.
 */
const REGISTRY: Partial<Record<ProviderId, Provider>> = {
  openrouter: openRouterProvider,
  anthropic: anthropicProvider,
  'openai-compatible': openAiCompatibleProvider,
}

export function getProvider(id: ProviderId): Provider | undefined {
  return REGISTRY[id]
}

export function availableProviders(): readonly Provider[] {
  return Object.values(REGISTRY).filter((p): p is Provider => p !== undefined)
}

export const IMPLEMENTED_PROVIDERS: readonly ProviderId[] = Object.keys(
  REGISTRY,
) as ProviderId[]

export { openRouterProvider, anthropicProvider, openAiCompatibleProvider }
