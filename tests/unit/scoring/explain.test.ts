/**
 * Explication du score — SPEC §6.
 *
 * L'exigence « cliquable, explicable » n'est pas décorative : sans elle, les curseurs de
 * l'onglet Config sont décoratifs. L'utilisateur qui voit passer un post qu'il aurait voulu
 * traiter doit lire *quel* facteur l'a écarté et *quel* poids corriger.
 */
import { describe, expect, it } from 'vitest'
import { computeEv } from '@/scoring/ev'
import { explainScore, FACTOR_LABELS } from '@/scoring/explain'
import {
  describeWeights,
  diagnoseWeights,
  NEUTRAL_WEIGHTS,
  parseWeights,
} from '@/scoring/weights'

const factors = {
  reach: 0.6,
  nicheRelevance: 0.7,
  freshness: 0.8,
  saturationInverse: 0.7,
  authorAffinity: 0.5,
}

describe('explainScore', () => {
  it('expose les cinq facteurs avec leur libellé', () => {
    const explained = explainScore(computeEv(factors, NEUTRAL_WEIGHTS))
    expect(explained.factors).toHaveLength(5)
    for (const factor of explained.factors) {
      expect(factor.label).toBe(FACTOR_LABELS[factor.key])
      expect(factor.reason.length).toBeGreaterThan(5)
    }
  })

  it('distingue la valeur du facteur de son poids', () => {
    // Deux informations différentes que l'utilisateur doit pouvoir lire séparément : ce que
    // vaut le post, et ce qu'il a décidé qui compte.
    const explained = explainScore(
      computeEv(factors, { ...NEUTRAL_WEIGHTS, nicheRelevance: 4 }),
    )
    const niche = explained.factors.find((f) => f.key === 'nicheRelevance')!
    expect(niche.valuePct).toBe(70)
    expect(niche.sharePct).toBeGreaterThan(40)
  })

  it('désigne le facteur qui annule et explique pourquoi', () => {
    const explained = explainScore(
      computeEv({ ...factors, authorAffinity: 0 }, NEUTRAL_WEIGHTS),
    )
    expect(explained.factors.find((f) => f.isVeto)?.key).toBe('authorAffinity')
    expect(explained.headline).toContain('annule le score')
    expect(explained.tuningHint).toContain('reply guy')
  })

  it('donne un conseil de réglage actionnable sur un veto de fraîcheur', () => {
    const explained = explainScore(
      computeEv({ ...factors, freshness: 0 }, NEUTRAL_WEIGHTS),
    )
    expect(explained.tuningHint).toContain('âge maximum')
  })

  it('ne donne PAS de conseil quand tout va bien', () => {
    // Un conseil affiché à chaque carte devient du bruit.
    const explained = explainScore(
      computeEv(
        {
          reach: 0.9,
          nicheRelevance: 0.9,
          freshness: 0.9,
          saturationInverse: 0.9,
          authorAffinity: 0.9,
        },
        NEUTRAL_WEIGHTS,
      ),
    )
    expect(explained.tuningHint).toBeNull()
  })

  it('adapte le titre au niveau du score', () => {
    const high = explainScore(
      computeEv(
        {
          reach: 0.9,
          nicheRelevance: 0.9,
          freshness: 0.9,
          saturationInverse: 0.9,
          authorAffinity: 0.9,
        },
        NEUTRAL_WEIGHTS,
      ),
    )
    const low = explainScore(
      computeEv(
        {
          reach: 0.2,
          nicheRelevance: 0.2,
          freshness: 0.2,
          saturationInverse: 0.2,
          authorAffinity: 0.2,
        },
        NEUTRAL_WEIGHTS,
      ),
    )
    expect(high.headline).toContain('élevé')
    expect(low.headline).toContain('faible')
  })
})

describe('poids', () => {
  it('décrit ce que les poids privilégient', () => {
    const description = describeWeights({ ...NEUTRAL_WEIGHTS, nicheRelevance: 5 })
    expect(description).toContain('pertinence de niche')
    expect(description).toContain('%')
  })

  it('reconnaît des poids uniformes', () => {
    expect(describeWeights(NEUTRAL_WEIGHTS)).toContain('également')
  })

  it('signale une configuration qui désactive la formule', () => {
    // Un utilisateur qui met tout à zéro ne règle pas, il désactive. Mieux vaut le lui dire
    // que produire un classement dégénéré.
    const allZero = {
      reach: 0,
      nicheRelevance: 0,
      freshness: 0,
      saturationPenalty: 0,
      authorAffinity: 0,
    }
    expect(diagnoseWeights(allZero)).toContain('désactivée')
  })

  it('signale un facteur unique — c’est un tri, pas un scoring', () => {
    const single = {
      reach: 0,
      nicheRelevance: 1,
      freshness: 0,
      saturationPenalty: 0,
      authorAffinity: 0,
    }
    expect(diagnoseWeights(single)).toContain('tri')
  })

  it('avertit si la pertinence de niche est neutralisée', () => {
    const noNiche = { ...NEUTRAL_WEIGHTS, nicheRelevance: 0 }
    expect(diagnoseWeights(noNiche)).toContain('hors sujet')
  })

  it('ne dit rien sur une configuration saine', () => {
    expect(diagnoseWeights(NEUTRAL_WEIGHTS)).toBeNull()
  })

  it('valide des poids venus de l’extérieur', () => {
    expect(parseWeights(NEUTRAL_WEIGHTS).ok).toBe(true)
    expect(parseWeights({ reach: 'beaucoup' }).ok).toBe(false)
    expect(parseWeights({ ...NEUTRAL_WEIGHTS, reach: 99 }).ok).toBe(false)
  })
})
