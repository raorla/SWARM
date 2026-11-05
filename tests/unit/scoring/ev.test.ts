/**
 * SCORE EV — différenciateur n°4.
 *
 * Deux propriétés valent tous les autres tests :
 *
 *  1. **Un facteur nul annule tout.** C'est la propriété du produit de la spec, conservée
 *     délibérément : répondre hors sujet ne rapporte rien, quelle que soit l'audience.
 *  2. **Le score reste à l'échelle des facteurs.** Un produit brut de cinq facteurs s'écrase
 *     vers zéro — cinq facteurs à 0,6 donneraient 0,078 — et le classement perdrait sa
 *     résolution là où se trouve la majorité des posts.
 */
import { describe, expect, it } from 'vitest'
import {
  AFFINITY_COOLDOWN_MS,
  computeAuthorAffinity,
  computeEv,
  computeReach,
  describeScore,
  scoreOpportunity,
  type EvFactors,
} from '@/scoring/ev'
import { NEUTRAL_WEIGHTS } from '@/scoring/weights'
import { bundledPack } from '@/niches/loader'
import type { EvWeights } from '@/niches/pack.schema'

const pack = bundledPack('memecoin')!
const NOW = Date.parse('2026-08-25T12:00:00.000Z')

const factors = (overrides: Partial<EvFactors> = {}): EvFactors => ({
  reach: 0.6,
  nicheRelevance: 0.7,
  freshness: 0.8,
  saturationInverse: 0.7,
  authorAffinity: 0.5,
  ...overrides,
})

describe('propriété du produit : un facteur nul annule tout', () => {
  it('annule sur une pertinence de niche nulle', () => {
    // Un post hors niche à portée immense vaut zéro, et c'est voulu.
    const result = computeEv(factors({ nicheRelevance: 0, reach: 1 }), NEUTRAL_WEIGHTS)
    expect(result.ev).toBe(0)
    expect(result.vetoedBy).toBe('nicheRelevance')
  })

  it('annule sur une fraîcheur nulle', () => {
    const result = computeEv(factors({ freshness: 0 }), NEUTRAL_WEIGHTS)
    expect(result.ev).toBe(0)
    expect(result.vetoedBy).toBe('freshness')
  })

  it('annule sur une saturation totale', () => {
    const result = computeEv(factors({ saturationInverse: 0 }), NEUTRAL_WEIGHTS)
    expect(result.ev).toBe(0)
  })

  it('annule sur une affinité nulle — période de refroidissement', () => {
    const result = computeEv(factors({ authorAffinity: 0 }), NEUTRAL_WEIGHTS)
    expect(result.ev).toBe(0)
    expect(result.vetoedBy).toBe('authorAffinity')
  })

  it('n’annule pas sur un facteur simplement faible', () => {
    const result = computeEv(factors({ nicheRelevance: 0.05 }), NEUTRAL_WEIGHTS)
    expect(result.ev).toBeGreaterThan(0)
    expect(result.vetoedBy).toBeNull()
  })
})

describe('échelle du score', () => {
  it('cinq facteurs à 0,6 donnent 0,6 — pas 0,078', () => {
    // La correction qui rend le classement lisible : un produit brut écraserait tout vers
    // zéro et rendrait les scores indistinguables.
    const result = computeEv(
      {
        reach: 0.6,
        nicheRelevance: 0.6,
        freshness: 0.6,
        saturationInverse: 0.6,
        authorAffinity: 0.6,
      },
      NEUTRAL_WEIGHTS,
    )
    expect(result.ev).toBeCloseTo(0.6, 6)
  })

  it('tous les facteurs à 1 donnent 1', () => {
    const result = computeEv(
      {
        reach: 1,
        nicheRelevance: 1,
        freshness: 1,
        saturationInverse: 1,
        authorAffinity: 1,
      },
      NEUTRAL_WEIGHTS,
    )
    expect(result.ev).toBeCloseTo(1, 6)
  })

  it('reste borné dans [0, 1] sur des entrées aberrantes', () => {
    const wild = computeEv(
      {
        reach: 5,
        nicheRelevance: -3,
        freshness: Number.NaN,
        saturationInverse: Infinity,
        authorAffinity: 0.5,
      },
      NEUTRAL_WEIGHTS,
    )
    expect(wild.ev).toBeGreaterThanOrEqual(0)
    expect(wild.ev).toBeLessThanOrEqual(1)
  })

  it('un NaN est ramené à zéro, pas propagé', () => {
    // Un NaN dans le classement rendrait tout le tri instable sans qu'on sache pourquoi.
    const result = computeEv(factors({ reach: Number.NaN }), NEUTRAL_WEIGHTS)
    expect(Number.isFinite(result.ev)).toBe(true)
    expect(result.factors.reach).toBe(0)
  })
})

describe('poids', () => {
  it('un poids élevé sur un facteur fort tire le score vers le haut', () => {
    const base = factors({ nicheRelevance: 0.9, reach: 0.3 })
    const nicheHeavy: EvWeights = { ...NEUTRAL_WEIGHTS, nicheRelevance: 4 }
    const reachHeavy: EvWeights = { ...NEUTRAL_WEIGHTS, reach: 4 }
    expect(computeEv(base, nicheHeavy).ev).toBeGreaterThan(computeEv(base, reachHeavy).ev)
  })

  it('des poids tous nuls donnent la moyenne, pas zéro', () => {
    // L'utilisateur n'a pas dit « rien ne compte », il n'a rien dit.
    const zeroWeights: EvWeights = {
      reach: 0,
      nicheRelevance: 0,
      freshness: 0,
      saturationPenalty: 0,
      authorAffinity: 0,
    }
    const result = computeEv(factors(), zeroWeights)
    expect(result.ev).toBeGreaterThan(0.5)
    expect(result.ev).toBeLessThan(0.8)
  })

  it('les parts de poids somment à 1', () => {
    const result = computeEv(factors(), pack.evWeights)
    const total = result.contributions.reduce((sum, c) => sum + c.share, 0)
    expect(total).toBeCloseTo(1, 6)
  })
})

describe('facteur limitant', () => {
  it('désigne le facteur au plus fort déficit pondéré', () => {
    // Ce n'est pas « le plus faible » : un facteur faible mais peu pondéré limite moins
    // qu'un facteur moyen très pondéré.
    const result = computeEv(factors({ reach: 0.2, nicheRelevance: 0.5 }), {
      ...NEUTRAL_WEIGHTS,
      nicheRelevance: 10,
      reach: 1,
    })
    expect(result.limitingFactor).toBe('nicheRelevance')
  })

  it('produit une phrase de résumé exploitable', () => {
    const good = describeScore(
      computeEv(factors({ nicheRelevance: 0.9 }), NEUTRAL_WEIGHTS),
    )
    expect(good).toContain('EV')
    const vetoed = describeScore(computeEv(factors({ freshness: 0 }), NEUTRAL_WEIGHTS))
    expect(vetoed).toContain('Écarté')
  })
})

describe('computeReach', () => {
  it('l’engagement observé pèse plus que le nombre d’abonnés', () => {
    // Un post à 500 likes chez un compte de 2 000 abonnés a débordé de son audience : c'est
    // un meilleur signal de portée que le nombre d'abonnés.
    const viral = computeReach({
      authorFollowers: 2_000,
      likeCount: 500,
      repostCount: 80,
      replyCount: 40,
    })
    const quietBig = computeReach({
      authorFollowers: 500_000,
      likeCount: 3,
      repostCount: 0,
      replyCount: 1,
    })
    expect(viral).toBeGreaterThan(quietBig)
  })

  it('n’invente pas d’audience quand les abonnés sont inconnus', () => {
    // Le fil de X n'expose pas le nombre d'abonnés : deviner ferait un classement confiant
    // et faux.
    const unknown = computeReach({
      authorFollowers: null,
      likeCount: 100,
      repostCount: 10,
      replyCount: 5,
    })
    expect(unknown).toBeGreaterThan(0)
    expect(unknown).toBeLessThanOrEqual(1)
  })

  it('vaut zéro sur un post sans aucun signal', () => {
    expect(
      computeReach({
        authorFollowers: null,
        likeCount: 0,
        repostCount: 0,
        replyCount: 0,
      }),
    ).toBe(0)
  })

  it('est logarithmique : un même écart ABSOLU compte moins en haut de l’échelle', () => {
    // La propriété se teste à écart absolu constant, pas à ratio constant : la différence
    // entre 100 et 1 100 abonnés doit compter plus que celle entre 100 000 et 101 000.
    const at = (followers: number): number =>
      computeReach({
        authorFollowers: followers,
        likeCount: 10,
        repostCount: 0,
        replyCount: 0,
      })

    const lowGain = at(1_100) - at(100)
    const highGain = at(101_000) - at(100_000)
    expect(lowGain).toBeGreaterThan(highGain)
  })

  it('à ratio constant, les gains sont comparables — c’est ce que fait un log', () => {
    const at = (followers: number): number =>
      computeReach({
        authorFollowers: followers,
        likeCount: 10,
        repostCount: 0,
        replyCount: 0,
      })

    const decade1 = at(1_000) - at(100)
    const decade2 = at(100_000) - at(10_000)
    // Même facteur ×10 : les deux gains sont du même ordre, à la pondération près.
    expect(Math.abs(decade1 - decade2)).toBeLessThan(0.05)
  })
})

describe('computeAuthorAffinity', () => {
  const base = {
    warmth: null,
    interactionCount: 0,
    ignoredCount: 0,
    onWatchlist: false,
    lastInteractionMs: null,
    nowMs: NOW,
  }

  it('un compte inconnu est neutre, pas mauvais', () => {
    // Un produit qui ne parlerait qu'aux comptes déjà connus ne ferait jamais grandir un
    // réseau.
    expect(computeAuthorAffinity(base)).toBe(0.5)
  })

  it('la watchlist vaut le maximum', () => {
    expect(computeAuthorAffinity({ ...base, onWatchlist: true })).toBe(1)
  })

  it('une interaction récente ANNULE l’affinité', () => {
    // C'est ce facteur qui empêche le produit de devenir un reply guy sur trois comptes.
    const recent = computeAuthorAffinity({
      ...base,
      warmth: 5,
      lastInteractionMs: NOW - 60_000,
    })
    expect(recent).toBe(0)
  })

  it('la période de refroidissement expire', () => {
    const after = computeAuthorAffinity({
      ...base,
      warmth: 4,
      lastInteractionMs: NOW - AFFINITY_COOLDOWN_MS - 1,
    })
    expect(after).toBeGreaterThan(0.5)
  })

  it('la watchlist ne contourne pas le refroidissement', () => {
    // Sinon un compte suivi de près recevrait dix réponses par jour.
    const recent = computeAuthorAffinity({
      ...base,
      onWatchlist: true,
      lastInteractionMs: NOW - 60_000,
    })
    expect(recent).toBe(0)
  })

  it('être ignoré désinvestit rapidement un compte', () => {
    const engaged = computeAuthorAffinity({ ...base, warmth: 3, ignoredCount: 0 })
    const ignored = computeAuthorAffinity({ ...base, warmth: 3, ignoredCount: 3 })
    expect(ignored).toBeLessThan(engaged - 0.4)
  })

  it('la familiarité augmente l’affinité', () => {
    const cold = computeAuthorAffinity({ ...base, warmth: 0 })
    const warm = computeAuthorAffinity({ ...base, warmth: 5 })
    expect(warm).toBeGreaterThan(cold)
  })
})

describe('scoreOpportunity — assemblage', () => {
  it('produit un score et un décomposé complets', () => {
    const result = scoreOpportunity({
      reach: { authorFollowers: 5_000, likeCount: 80, repostCount: 4, replyCount: 12 },
      nicheRelevance: 0.8,
      freshness: { postedAtMs: NOW - 10 * 60_000, nowMs: NOW },
      saturation: { replyCount: 12, likeCount: 80 },
      affinity: {
        warmth: null,
        interactionCount: 0,
        ignoredCount: 0,
        onWatchlist: false,
        lastInteractionMs: null,
        nowMs: NOW,
      },
      pack,
    })
    expect(result.ev).toBeGreaterThan(0.3)
    expect(result.contributions).toHaveLength(5)
    expect(result.factors.freshness).toBeGreaterThan(0.4)
  })

  it('écarte un post périmé au seuil du pack', () => {
    const result = scoreOpportunity({
      reach: {
        authorFollowers: 100_000,
        likeCount: 5_000,
        repostCount: 500,
        replyCount: 20,
      },
      nicheRelevance: 1,
      // Le pack memecoin plafonne à 45 minutes.
      freshness: { postedAtMs: NOW - 120 * 60_000, nowMs: NOW },
      saturation: { replyCount: 20, likeCount: 5_000 },
      affinity: {
        warmth: 5,
        interactionCount: 10,
        ignoredCount: 0,
        onWatchlist: true,
        lastInteractionMs: null,
        nowMs: NOW,
      },
      pack,
    })
    expect(result.ev).toBe(0)
    expect(result.vetoedBy).toBe('freshness')
  })

  it('fonctionne sur n’importe quel pack — agnosticisme', () => {
    for (const id of ['memecoin', 'saas-b2b', 'generic']) {
      const p = bundledPack(id)!
      const result = scoreOpportunity({
        reach: { authorFollowers: 3_000, likeCount: 40, repostCount: 2, replyCount: 5 },
        nicheRelevance: 0.7,
        freshness: { postedAtMs: NOW - 10 * 60_000, nowMs: NOW },
        saturation: { replyCount: 5, likeCount: 40 },
        affinity: {
          warmth: null,
          interactionCount: 0,
          ignoredCount: 0,
          onWatchlist: false,
          lastInteractionMs: null,
          nowMs: NOW,
        },
        pack: p,
      })
      expect(result.ev, id).toBeGreaterThanOrEqual(0)
      expect(result.ev, id).toBeLessThanOrEqual(1)
    }
  })
})
