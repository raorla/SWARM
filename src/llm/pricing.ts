/**
 * Tarification — SPEC §3.2, règle 4.
 *
 * Les prix ne sont pas codés en dur : ils sont synchronisés depuis le catalogue du
 * provider. Un catalogue de plusieurs centaines de modèles évolue plus vite qu'un build
 * d'extension, et un compteur de budget avec des prix périmés est un compteur cassé —
 * qui donne l'illusion du contrôle, ce qui est pire que pas de compteur.
 *
 * La table ci-dessous est un **repli hors ligne**, pas une référence. Elle sert quand la
 * synchronisation n'a pas encore eu lieu, et l'UI signale alors que les coûts sont
 * approximatifs.
 */
import { z } from 'zod'

/** Taux de conversion, remplacé par un taux configurable en Phase 5. */
export const USD_TO_EUR = 0.92

export interface ModelPrice {
  /** USD par million de tokens d'entrée. */
  inputPerMTok: number
  outputPerMTok: number
  /** Lecture de cache, en général 0,1× l'entrée. */
  cacheReadPerMTok: number
  /** Écriture de cache, en général 1,25× l'entrée. */
  cacheWritePerMTok: number
}

function withCacheRates(input: number, output: number): ModelPrice {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: input * 0.1,
    cacheWritePerMTok: input * 1.25,
  }
}

/**
 * Repli hors ligne. Tarifs Anthropic de référence utilisés dans le chiffrage de
 * SPEC §3.2. À ne jamais considérer comme à jour.
 */
export const FALLBACK_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-4-5': withCacheRates(1, 5),
  'claude-sonnet-5': withCacheRates(3, 15),
  'claude-opus-5': withCacheRates(5, 25),
  // Noms tels que OpenRouter les expose.
  'anthropic/claude-haiku-4.5': withCacheRates(1, 5),
  'anthropic/claude-sonnet-5': withCacheRates(3, 15),
  'anthropic/claude-opus-5': withCacheRates(5, 25),
}

/** Modèle du catalogue OpenRouter (`GET /api/v1/models`) — champs utilisés seulement. */
export const OpenRouterModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  context_length: z.number().optional(),
  pricing: z.object({
    // OpenRouter exprime les prix en USD **par token**, en chaîne.
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
  }),
})

export const OpenRouterCatalogSchema = z.object({
  data: z.array(OpenRouterModelSchema),
})

/** Convertit une entrée de catalogue OpenRouter en `ModelPrice` (USD / MTok). */
export function priceFromOpenRouter(
  entry: z.infer<typeof OpenRouterModelSchema>,
): ModelPrice | null {
  const perToken = (s: string | undefined): number | null => {
    if (s === undefined) return null
    const n = Number(s)
    return Number.isFinite(n) ? n * 1_000_000 : null
  }
  const input = perToken(entry.pricing.prompt)
  const output = perToken(entry.pricing.completion)
  if (input === null || output === null) return null
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: perToken(entry.pricing.input_cache_read) ?? input * 0.1,
    cacheWritePerMTok: perToken(entry.pricing.input_cache_write) ?? input * 1.25,
  }
}

export interface PriceTable {
  prices: Readonly<Record<string, ModelPrice>>
  /** Instant de la dernière synchronisation. `null` = repli hors ligne en usage. */
  syncedAtMs: number | null
}

export const FALLBACK_TABLE: PriceTable = { prices: FALLBACK_PRICES, syncedAtMs: null }

/**
 * Coût en euros d'un usage mesuré.
 *
 * Les tokens de réflexion sont facturés en output : les compter séparément puis les
 * additionner serait un double comptage si le provider les inclut déjà dans
 * `outputTokens`. On considère `outputTokens` comme le total facturable et
 * `reasoningTokens` comme purement informatif — c'est la convention de l'API Messages, et
 * c'est celle qu'on documente.
 */
export function computeCostEur(
  table: PriceTable,
  model: string,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  },
): { eur: number; priceKnown: boolean } {
  const price = table.prices[model] ?? FALLBACK_PRICES[model]
  if (!price) {
    // Un modèle de prix inconnu ne doit pas compter pour zéro : ce serait une fuite
    // silencieuse du plafond de budget. On facture prudemment au tarif le plus élevé
    // connu, et on signale que le prix est incertain.
    const worst = Object.values(FALLBACK_PRICES).reduce(
      (a, b) => (b.outputPerMTok > a.outputPerMTok ? b : a),
      {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      },
    )
    return { eur: applyPrice(worst, usage), priceKnown: false }
  }
  return { eur: applyPrice(price, usage), priceKnown: true }
}

function applyPrice(
  p: ModelPrice,
  u: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  },
): number {
  const usd =
    (u.inputTokens * p.inputPerMTok +
      u.outputTokens * p.outputPerMTok +
      u.cacheReadTokens * p.cacheReadPerMTok +
      u.cacheWriteTokens * p.cacheWritePerMTok) /
    1_000_000
  return usd * USD_TO_EUR
}
