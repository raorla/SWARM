/**
 * Fraîcheur et saturation.
 *
 * Deux points de conception y sont testés parce qu'ils sont invisibles à la relecture :
 *
 *  - **La continuité au seuil.** Une décroissance exponentielle brute laisse une valeur
 *    résiduelle juste avant le seuil puis chute à zéro. Cette discontinuité produit des
 *    inversions inexplicables entre deux posts d'âge voisin dans le classement.
 *  - **« Inconnu » n'est pas « zéro ».** Un compteur de réponses illisible ne doit pas faire
 *    passer un post saturé pour un post frais.
 */
import { describe, expect, it } from 'vitest'
import {
  ageMinutes,
  computeFreshness,
  expiresAtMs,
  HALF_LIFE_RATIO,
} from '@/scoring/freshness'
import { computeSaturation, isSaturated } from '@/scoring/saturation'

const NOW = Date.parse('2026-08-25T12:00:00.000Z')
const minutesAgo = (n: number): number => NOW - n * 60_000

describe('fraîcheur', () => {
  it('vaut 1 sur un post à l’instant', () => {
    expect(computeFreshness({ postedAtMs: NOW, nowMs: NOW }, 45)).toBe(1)
  })

  it('vaut exactement 0 au seuil', () => {
    expect(computeFreshness({ postedAtMs: minutesAgo(45), nowMs: NOW }, 45)).toBe(0)
    expect(computeFreshness({ postedAtMs: minutesAgo(60), nowMs: NOW }, 45)).toBe(0)
  })

  it('est CONTINUE juste avant le seuil', () => {
    // La propriété qui évite les inversions inexplicables : sans correction, la valeur juste
    // avant le seuil serait ~0,1 puis tomberait à 0, et deux posts d'une minute d'écart
    // seraient classés à l'opposé.
    const justBefore = computeFreshness({ postedAtMs: minutesAgo(44.5), nowMs: NOW }, 45)
    expect(justBefore).toBeGreaterThan(0)
    expect(justBefore).toBeLessThan(0.02)
  })

  it('décroît de moitié à la demi-vie configurée', () => {
    const halfLifeMinutes = 45 * HALF_LIFE_RATIO
    const atHalfLife = computeFreshness(
      { postedAtMs: minutesAgo(halfLifeMinutes), nowMs: NOW },
      45,
    )
    // Autour de 0,5 après renormalisation : la correction de continuité décale légèrement.
    expect(atHalfLife).toBeGreaterThan(0.4)
    expect(atHalfLife).toBeLessThan(0.55)
  })

  it('décroît plus vite au début qu’à la fin', () => {
    // Une réponse à 5 minutes vaut presque autant qu'à 2 ; une réponse à 40 minutes ne vaut
    // presque plus rien. Un modèle linéaire surestimerait massivement le milieu de fenêtre.
    const early =
      computeFreshness({ postedAtMs: minutesAgo(0), nowMs: NOW }, 45) -
      computeFreshness({ postedAtMs: minutesAgo(10), nowMs: NOW }, 45)
    const late =
      computeFreshness({ postedAtMs: minutesAgo(30), nowMs: NOW }, 45) -
      computeFreshness({ postedAtMs: minutesAgo(40), nowMs: NOW }, 45)
    expect(early).toBeGreaterThan(late)
  })

  it('traite un post daté du futur comme frais, sans le récompenser', () => {
    // Anomalie d'horloge, pas aubaine : le noter au-dessus de 1 fausserait le classement.
    expect(computeFreshness({ postedAtMs: NOW + 60_000, nowMs: NOW }, 45)).toBe(1)
  })

  it('respecte des seuils de pack différents', () => {
    const at30 = computeFreshness({ postedAtMs: minutesAgo(30), nowMs: NOW }, 45)
    const at30Long = computeFreshness({ postedAtMs: minutesAgo(30), nowMs: NOW }, 180)
    // Une niche à conversations lentes garde de la valeur bien plus longtemps.
    expect(at30Long).toBeGreaterThan(at30)
  })

  it('reste borné même sur un seuil absurde', () => {
    for (const threshold of [0, -5, 1, 100_000]) {
      const value = computeFreshness(
        { postedAtMs: minutesAgo(10), nowMs: NOW },
        threshold,
      )
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('ageMinutes et expiresAtMs sont cohérents', () => {
    expect(ageMinutes({ postedAtMs: minutesAgo(17), nowMs: NOW })).toBe(17)
    expect(expiresAtMs(NOW, 45)).toBe(NOW + 45 * 60_000)
  })
})

describe('saturation', () => {
  it('vaut 1 sur une conversation vierge', () => {
    expect(computeSaturation({ replyCount: 0, likeCount: 10 }, 120)).toBe(1)
  })

  it('vaut 0 au seuil', () => {
    expect(computeSaturation({ replyCount: 120, likeCount: 500 }, 120)).toBe(0)
    expect(computeSaturation({ replyCount: 500, likeCount: 500 }, 120)).toBe(0)
  })

  it('« inconnu » n’est pas « zéro réponse »', () => {
    // Supposer « peu de réponses » ferait remonter des posts saturés dont on n'a simplement
    // pas pu lire le compteur.
    expect(computeSaturation({ replyCount: null, likeCount: 100 }, 120)).toBe(0.5)
  })

  it('décroît logarithmiquement', () => {
    // Passer de 2 à 20 réponses change tout ; de 200 à 220, rien.
    const at = (replies: number): number =>
      computeSaturation({ replyCount: replies, likeCount: 0 }, 200)
    expect(at(2) - at(20)).toBeGreaterThan(at(180) - at(198))
  })

  it('un fort ratio likes/réponses laisse de la place', () => {
    // 50 réponses et 5 000 likes : il reste du monde à atteindre. 50 réponses et 60 likes :
    // la conversation est fermée.
    const wideAudience = computeSaturation({ replyCount: 50, likeCount: 5_000 }, 200)
    const closedLoop = computeSaturation({ replyCount: 50, likeCount: 60 }, 200)
    expect(wideAudience).toBeGreaterThan(closedLoop)
  })

  it('le bonus d’audience reste un ajustement, pas un facteur', () => {
    // Plafonné : sinon un post viral saturé remonterait en tête de file.
    const saturatedButViral = computeSaturation(
      { replyCount: 150, likeCount: 1_000_000 },
      200,
    )
    const freshAndQuiet = computeSaturation({ replyCount: 2, likeCount: 5 }, 200)
    expect(saturatedButViral).toBeLessThan(freshAndQuiet)
  })

  it('reste borné dans [0, 1]', () => {
    const cases = [
      { replyCount: 0, likeCount: 10_000_000 },
      { replyCount: 1, likeCount: 10_000_000 },
      { replyCount: 199, likeCount: 0 },
      { replyCount: null, likeCount: null },
    ]
    for (const input of cases) {
      const value = computeSaturation(input, 200)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('isSaturated suit le seuil du pack', () => {
    expect(isSaturated({ replyCount: 120, likeCount: 0 }, 120)).toBe(true)
    expect(isSaturated({ replyCount: 119, likeCount: 0 }, 120)).toBe(false)
    // Inconnu n'est pas saturé : on ne rejette pas sur une absence de mesure.
    expect(isSaturated({ replyCount: null, likeCount: 0 }, 120)).toBe(false)
  })
})
