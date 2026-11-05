/**
 * COMPTABILITÉ D'USAGE D'OPENROUTER — la seule erreur de ce module qui ne casse rien.
 *
 * Elle fausse le budget, silencieusement. Le défaut a été trouvé le 2026-08-26 en mesurant
 * R-03 : les deux API ne comptent pas pareil.
 *
 *  - **Anthropic en direct** : `input_tokens` EXCLUT les tokens lus depuis le cache.
 *  - **OpenRouter** : `prompt_tokens` les INCLUT, et `cached_tokens` en est un sous-ensemble.
 *
 * `computeCostEur` facture l'entrée au plein tarif et le cache à 10 %. Prendre la convention
 * d'OpenRouter au pied de la lettre revient donc à facturer les tokens cachés **deux fois** :
 * un appel à 3 135 tokens cachés sur 3 150 était estimé ~0,0096 € au lieu de ~0,0010 €. Le
 * cache, censé diviser le coût par dix, multipliait la facture estimée par dix — et le plafond
 * quotidien coupait alors que l'euro n'était pas dépensé.
 */
import { describe, expect, it } from 'vitest'
import { __readUsageForTest as readUsage } from '@/llm/providers/openrouter'
import { FALLBACK_TABLE, computeCostEur } from '@/llm/pricing'

const MODEL = 'anthropic/claude-sonnet-5'

describe('lecture de l’usage OpenRouter', () => {
  it('soustrait les tokens cachés du total du prompt', () => {
    // Les chiffres viennent de la mesure réelle du 2026-08-26.
    const usage = readUsage({
      prompt_tokens: 3_150,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 3_135 },
    })
    expect(usage.inputTokens).toBe(15)
    expect(usage.cacheReadTokens).toBe(3_135)
  })

  it('le coût d’un appel très caché est un dixième du coût non caché', () => {
    // La propriété qui justifie toute l'architecture de préfixe cachable (SPEC §3.2 règle 1).
    const cached = computeCostEur(
      FALLBACK_TABLE,
      MODEL,
      readUsage({
        prompt_tokens: 3_150,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 3_135 },
      }),
    )
    const uncached = computeCostEur(
      FALLBACK_TABLE,
      MODEL,
      readUsage({ prompt_tokens: 3_150, completion_tokens: 4 }),
    )
    expect(cached.eur).toBeLessThan(uncached.eur / 5)
  })

  it('sans cache, l’entrée reste le total du prompt', () => {
    const usage = readUsage({ prompt_tokens: 1_200, completion_tokens: 300 })
    expect(usage.inputTokens).toBe(1_200)
    expect(usage.cacheReadTokens).toBe(0)
  })

  it('accepte la forme alternative `cache_read_input_tokens`', () => {
    // Certains modèles amont remontent le champ d'Anthropic tel quel à travers OpenRouter.
    const usage = readUsage({
      prompt_tokens: 1_000,
      completion_tokens: 10,
      cache_read_input_tokens: 900,
    })
    expect(usage.inputTokens).toBe(100)
    expect(usage.cacheReadTokens).toBe(900)
  })

  it('ne produit JAMAIS un nombre de tokens négatif', () => {
    // Si un modèle amont rapportait les deux selon la convention d'Anthropic, la soustraction
    // donnerait un négatif — et un token négatif ferait *baisser* le compteur de budget. Une
    // fuite du plafond est pire qu'une surestimation.
    const usage = readUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 900 },
    })
    expect(usage.inputTokens).toBe(0)
    expect(usage.cacheReadTokens).toBe(900)
  })

  it('un champ absent vaut zéro, jamais NaN', () => {
    // Un `NaN` propagé dans le compteur de budget le rend inexploitable sans qu'on sache
    // pourquoi : toutes les comparaisons de plafond deviennent fausses.
    for (const raw of [undefined, null, {}, { prompt_tokens: 'beaucoup' }]) {
      const usage = readUsage(raw)
      for (const value of Object.values(usage)) {
        expect(Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('lit les tokens de réflexion sans les compter deux fois', () => {
    // Ils sont déjà inclus dans `completion_tokens` : les additionner doublerait la sortie,
    // qui est la partie la plus chère.
    const usage = readUsage({
      prompt_tokens: 100,
      completion_tokens: 500,
      completion_tokens_details: { reasoning_tokens: 400 },
    })
    expect(usage.outputTokens).toBe(500)
    expect(usage.reasoningTokens).toBe(400)
  })
})
