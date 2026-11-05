import { describe, expect, it } from 'vitest'
import {
  computeCostEur,
  FALLBACK_TABLE,
  OpenRouterCatalogSchema,
  priceFromOpenRouter,
  USD_TO_EUR,
} from '@/llm/pricing'

describe('pricing', () => {
  it('calcule le coût depuis les tarifs connus', () => {
    // 1M in + 1M out sur Haiku 4.5 ($1 / $5) = $6 → ~5,52 €.
    const { eur, priceKnown } = computeCostEur(FALLBACK_TABLE, 'claude-haiku-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(priceKnown).toBe(true)
    expect(eur).toBeCloseTo(6 * USD_TO_EUR, 4)
  })

  it('applique le tarif réduit de lecture de cache', () => {
    const cached = computeCostEur(FALLBACK_TABLE, 'claude-sonnet-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    })
    const fresh = computeCostEur(FALLBACK_TABLE, 'claude-sonnet-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    // C'est ce ratio de 10× qui rend le chiffrage à 1 €/jour possible (SPEC §3.2).
    expect(fresh.eur / cached.eur).toBeCloseTo(10, 1)
  })

  it('facture prudemment un modèle inconnu et le signale', () => {
    // Compter zéro serait une fuite silencieuse du plafond de budget.
    const { eur, priceKnown } = computeCostEur(FALLBACK_TABLE, 'modele/inconnu-42', {
      inputTokens: 10_000,
      outputTokens: 10_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(priceKnown).toBe(false)
    expect(eur).toBeGreaterThan(0)
  })

  it('convertit un catalogue OpenRouter (prix par token → par MTok)', () => {
    const catalog = OpenRouterCatalogSchema.parse({
      data: [
        {
          id: 'anthropic/claude-haiku-4.5',
          pricing: { prompt: '0.000001', completion: '0.000005' },
        },
      ],
    })
    const price = priceFromOpenRouter(catalog.data[0]!)
    expect(price).not.toBeNull()
    expect(price!.inputPerMTok).toBeCloseTo(1, 6)
    expect(price!.outputPerMTok).toBeCloseTo(5, 6)
    // Taux de cache déduits quand le catalogue ne les fournit pas.
    expect(price!.cacheReadPerMTok).toBeCloseTo(0.1, 6)
    expect(price!.cacheWritePerMTok).toBeCloseTo(1.25, 6)
  })

  it('rejette une entrée de catalogue au prix illisible', () => {
    const entry = { id: 'x/y', pricing: { prompt: 'gratuit', completion: '0.000005' } }
    expect(
      priceFromOpenRouter(OpenRouterCatalogSchema.parse({ data: [entry] }).data[0]!),
    ).toBeNull()
  })

  it('vérifie le chiffrage de référence du QUALIFIER (SPEC §3.2)', () => {
    // 4 appels de 5 300 tokens d'entrée et 1 250 de sortie sur Haiku 4.5.
    // C'est le DoD de la Phase 3 : 200 posts triés pour moins de 0,05 €.
    const { eur } = computeCostEur(FALLBACK_TABLE, 'claude-haiku-4-5', {
      inputTokens: 4 * 5_300,
      outputTokens: 4 * 1_250,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(eur).toBeLessThan(0.05)
    expect(eur).toBeGreaterThan(0.03)
  })
})
