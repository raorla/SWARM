/**
 * DISTANCE DE VOIX.
 *
 * La propriété qui fait tout le travail est l'**applicabilité par dimension** : une réponse
 * de 12 mots ne se compare pas à un profil de posts de 40 mots sur la longueur médiane.
 * Sans cette règle, le CRITIC rejetterait les bonnes réponses courtes — un faux positif qui
 * coûterait le produit.
 */
import { describe, expect, it } from 'vitest'
import { computeFormStats } from '@/memory/voice-profile'
import {
  computeVoiceDistance,
  describeDistance,
  distanceFromCorpus,
  DEFAULT_WEIGHTS,
} from '@/memory/voice-distance'
import type { OwnPost } from '@/db/schema'

let seq = 0
function post(text: string): OwnPost {
  seq += 1
  return {
    postId: `1789456000000${String(seq).padStart(6, '0')}`,
    text,
    lang: null,
    postedAtMs: 1_760_000_000_000 - seq * 1000,
    collectedAtMs: 1_760_000_000_000,
    likeCount: 5,
    replyCount: 1,
    repostCount: 0,
    hasMedia: false,
    isReply: false,
    passesGuard: true,
    guardCategories: [],
  }
}

/** Style laconique : minuscules, sans emoji, sans exclamation, une phrase. */
const TERSE = [
  post('locked liquidity is table stakes now'),
  post('the float is the actual signal here'),
  post('bonding curves are widely misunderstood'),
  post('most launches die from bad distribution'),
  post('low float plus real holders is rare'),
].map((p) => p)

/** Style opposé : majuscules, emojis, exclamations, plusieurs lignes. */
const LOUD = [
  post('HUGE NEWS!!! 🚀🚀🚀\n\nThis is MASSIVE!\n\nDont miss out!'),
  post('AMAZING update today!!! 🔥\n\nEveryone is talking!\n\nLets go!'),
  post('INCREDIBLE momentum!!! 💎\n\nThe community is ON FIRE!\n\nBig things!'),
]

const terseStats = computeFormStats(TERSE)
const loudStats = computeFormStats(LOUD)

describe('conformité et divergence', () => {
  it('un texte du même registre est proche', () => {
    const result = computeVoiceDistance(
      'holders matter more than the chart here',
      terseStats,
    )
    expect(result.distance).toBeLessThan(0.3)
  })

  it('un texte du registre opposé est éloigné', () => {
    // Texte long volontairement : c'est le cas réel du registre bruyant, et il active toutes
    // les dimensions. Sur un texte court, les dimensions de structure sont écartées à juste
    // titre, ce qui réduit mécaniquement le pouvoir discriminant — c'est le prix de ne pas
    // pénaliser les bonnes réponses courtes.
    const result = computeVoiceDistance(
      'HUGE NEWS EVERYONE!!! 🚀🚀🚀\n\nThis is absolutely MASSIVE for the whole community!\n\nDont miss out on this one!',
      terseStats,
    )
    expect(result.distance).toBeGreaterThan(0.5)
  })

  it('la métrique est symétrique dans son verdict', () => {
    // Un texte laconique doit être éloigné d'un profil bruyant, autant que l'inverse.
    const terseVsLoud = computeVoiceDistance('the float is the signal here', loudStats)
    const loudVsTerse = computeVoiceDistance('HUGE NEWS!!! 🚀', terseStats)
    expect(terseVsLoud.distance).toBeGreaterThan(0.4)
    expect(loudVsTerse.distance).toBeGreaterThan(0.4)
  })

  it('reste borné dans [0, 1]', () => {
    for (const text of ['', 'x', 'a'.repeat(5000), '🚀'.repeat(50), '!!!???…—;']) {
      const result = computeVoiceDistance(text, terseStats)
      expect(result.distance).toBeGreaterThanOrEqual(0)
      expect(result.distance).toBeLessThanOrEqual(1)
    }
  })
})

describe('applicabilité par dimension — la propriété centrale', () => {
  it('une réponse courte n’est PAS pénalisée sur les dimensions de structure', () => {
    // Le faux positif qu'on évite : sans cette règle, le CRITIC rejetterait les bonnes
    // réponses courtes parce qu'elles n'ont pas la cadence d'un post long.
    const result = computeVoiceDistance('true', terseStats)
    const skipped = result.breakdown.filter((d) => !d.applicable).map((d) => d.name)
    expect(skipped).toContain('sentences')
    expect(skipped).toContain('lineBreaks')
    expect(skipped).toContain('wordLength')
  })

  it('les dimensions écartées ne comptent ni comme conformes ni comme divergentes', () => {
    // Les compter comme 0 serait aussi faux que les compter comme 1.
    const short = computeVoiceDistance('vrai', terseStats)
    expect(short.dimensionsUsed).toBeLessThan(short.breakdown.length)
    const contributing = short.breakdown.filter((d) => d.applicable).length
    expect(short.dimensionsUsed).toBe(contributing)
  })

  it('les emojis restent évalués même sur un texte court', () => {
    // Signal binaire fort, indépendant de la longueur : sa présence trahit un registre.
    const withEmoji = computeVoiceDistance('vrai 🚀', terseStats)
    const without = computeVoiceDistance('vrai', terseStats)
    expect(withEmoji.distance).toBeGreaterThan(without.distance)
  })

  it('la fiabilité chute quand peu de dimensions s’appliquent', () => {
    // Un score calculé sur deux dimensions n'a pas le même sens qu'un score sur dix, et le
    // CRITIC doit pouvoir en tenir compte.
    const short = computeVoiceDistance('ok', terseStats)
    const long = computeVoiceDistance(
      'the float is the actual signal here and the holders know it well',
      terseStats,
    )
    expect(short.reliability).toBeLessThan(long.reliability)
    // Sur un texte de deux caractères, cinq dimensions sur neuf s'appliquent encore —
    // emoji, ponctuation, capitalisation restent des signaux valides quelle que soit la
    // longueur. La fiabilité baisse, elle ne s'effondre pas, et c'est exact.
    expect(short.reliability).toBeGreaterThan(0.4)
    expect(short.reliability).toBeLessThan(0.9)
  })

  it('la fiabilité est nulle sans profil, et l’étiquette le dit', () => {
    const noProfile = computeVoiceDistance('un texte quelconque', computeFormStats([]))
    expect(noProfile.reliability).toBe(0)
    expect(describeDistance(noProfile)).toContain('indéterminable')
  })

  it('un texte long dans l’intervalle du profil n’est pas pénalisé sur la longueur', () => {
    // L'intervalle [p10, p90] est la référence, pas la médiane : un profil de posts longs
    // tolère des réponses courtes si l'utilisateur en écrit aussi.
    const result = computeVoiceDistance(
      'bonding curves are widely misunderstood',
      terseStats,
    )
    const length = result.breakdown.find((d) => d.name === 'length')
    expect(length?.distance).toBe(0)
  })
})

describe('profil absent', () => {
  it('renvoie une distance INDÉTERMINÉE, pas nulle', () => {
    // Renvoyer 0 ferait croire au CRITIC que la réponse est parfaitement dans le style.
    const result = computeVoiceDistance('un texte quelconque', computeFormStats([]))
    expect(result.distance).toBe(0.5)
    expect(result.reliability).toBe(0)
    expect(result.dimensionsUsed).toBe(0)
  })
})

describe('détails', () => {
  it('expose une décomposition lisible avec le motif d’écartement', () => {
    const result = computeVoiceDistance('ok', terseStats)
    const skipped = result.breakdown.find((d) => !d.applicable)
    expect(skipped?.skippedReason).toBeDefined()
    expect(skipped?.skippedReason?.length).toBeGreaterThan(5)
  })

  it('respecte la pondération fournie', () => {
    // On inspecte la contribution de la dimension plutôt que de comparer deux distances
    // globales : ajouter un emoji change aussi la longueur du texte, et la comparaison
    // serait confondue par la dimension `length`.
    const text = 'the float is the signal 🚀'
    const withWeight = computeVoiceDistance(text, terseStats, DEFAULT_WEIGHTS)
    const withoutWeight = computeVoiceDistance(text, terseStats, {
      ...DEFAULT_WEIGHTS,
      emoji: 0,
    })

    const emojiOf = (r: typeof withWeight) => r.breakdown.find((d) => d.name === 'emoji')!
    expect(emojiOf(withWeight).weight).toBe(DEFAULT_WEIGHTS.emoji)
    expect(emojiOf(withoutWeight).weight).toBe(0)
    // La dimension reste évaluée — sa distance est la même — mais elle ne pèse plus.
    expect(emojiOf(withoutWeight).distance).toBeCloseTo(emojiOf(withWeight).distance, 6)
    expect(withoutWeight.distance).toBeLessThan(withWeight.distance)
  })

  it('distanceFromCorpus recalcule les statistiques à la volée', () => {
    const direct = computeVoiceDistance('the float is the signal here', terseStats)
    const fromCorpus = distanceFromCorpus('the float is the signal here', TERSE)
    expect(fromCorpus.distance).toBeCloseTo(direct.distance, 6)
  })

  it('produit une étiquette lisible à chaque palier', () => {
    const labels = new Set(
      ['holders matter here too', 'HUGE!!! 🚀🚀🚀 DONT MISS OUT NOW EVERYONE'].map((t) =>
        describeDistance(computeVoiceDistance(t, terseStats)),
      ),
    )
    expect(labels.size).toBeGreaterThan(1)
    for (const label of labels) expect(label).toContain('voix')
  })
})
