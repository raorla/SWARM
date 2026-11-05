/**
 * VOICE PROFILE.
 *
 * Le test le plus important de ce fichier est le dernier bloc : **le Voice Profile ne doit
 * jamais devenir le canal par lequel du contenu interdit rentre dans le produit** (MH-18).
 * C'est le contournement le plus naturel et le moins visible du noyau MH-02, et il n'aurait
 * été découvert qu'en Phase 5, quand le taux de rejet du CRITIC aurait été à 100 % sans
 * explication.
 */
import { describe, expect, it } from 'vitest'
import {
  buildVoiceProfile,
  computeConfidence,
  computeFormStats,
  deriveRules,
  describeProfile,
  extractSignatureOpeners,
  extractSignaturePhrases,
  guessLanguage,
  isProfileUsable,
  selectCanonicalExamples,
  splitSentences,
  splitWords,
} from '@/memory/voice-profile'
import { bundledPack } from '@/niches/loader'
import type { OwnPost } from '@/db/schema'
import { FakeClock } from '@/shared/time'

const clock = new FakeClock('2026-08-25T12:00:00.000Z')
const pack = bundledPack('memecoin')!

let seq = 0
function post(text: string, overrides: Partial<OwnPost> = {}): OwnPost {
  seq += 1
  return {
    postId: `17894560000000${String(seq).padStart(5, '0')}`,
    text,
    lang: null,
    postedAtMs: clock.now() - seq * 3_600_000,
    collectedAtMs: clock.now(),
    likeCount: 10,
    replyCount: 2,
    repostCount: 1,
    hasMedia: false,
    isReply: false,
    passesGuard: true,
    guardCategories: [],
    ...overrides,
  }
}

/** Corpus de style « laconique, minuscules, sans emoji » — un registre reconnaissable. */
const TERSE_CORPUS = [
  post('locked liquidity is table stakes now'),
  post('the float is the actual signal here'),
  post('bonding curves are misunderstood'),
  post('community takeover worked exactly once'),
  post('most launches die from bad distribution'),
  post('low float plus real holders is rare'),
]

describe('segmentation', () => {
  it('découpe en phrases sans se faire piéger par les URL', () => {
    // Le point n'est pas un séparateur fiable sur X : les URL en contiennent.
    const sentences = splitSentences(
      'Regarde https://example.com/a.b.c puis dis-moi. Ça tient ?',
    )
    expect(sentences).toHaveLength(2)
  })

  it('découpe sur les retours à la ligne', () => {
    expect(splitSentences('première ligne\nseconde ligne')).toHaveLength(2)
  })

  it('exclut les URL et les adresses de contrat du comptage de mots', () => {
    // Une adresse de contrat compterait comme un mot de 44 lettres et fausserait la
    // longueur moyenne des mots.
    const words = splitWords(
      'regarde 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU vraiment',
    )
    expect(words).toEqual(['regarde', 'vraiment'])
  })
})

describe('détection de langue', () => {
  it('reconnaît le français et l’anglais', () => {
    expect(guessLanguage('le float est le vrai signal dans cette affaire')).toBe('fr')
    expect(guessLanguage('the float is the actual signal in this one')).toBe('en')
  })

  it('renvoie und sur un texte trop court pour trancher', () => {
    // Prétendre détecter une langue sur deux mots produirait un mix linguistique faux.
    expect(guessLanguage('gm')).toBe('und')
    expect(guessLanguage('$acme')).toBe('und')
  })
})

describe('statistiques de forme', () => {
  it('renvoie un profil vide sur un corpus vide, sans NaN', () => {
    const stats = computeFormStats([])
    expect(stats.sampleSize).toBe(0)
    for (const value of Object.values(stats)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('mesure la longueur et ses percentiles', () => {
    const stats = computeFormStats(TERSE_CORPUS)
    expect(stats.sampleSize).toBe(6)
    expect(stats.medianLength).toBeGreaterThan(20)
    expect(stats.p10Length).toBeLessThanOrEqual(stats.medianLength)
    expect(stats.p90Length).toBeGreaterThanOrEqual(stats.medianLength)
  })

  it('détecte l’absence d’emoji et de ponctuation emphatique', () => {
    const stats = computeFormStats(TERSE_CORPUS)
    expect(stats.emojiRate).toBe(0)
    expect(stats.emojiInventory).toHaveLength(0)
    expect(stats.exclamationRate).toBe(0)
  })

  it('inventorie les emojis employés, les plus fréquents d’abord', () => {
    const stats = computeFormStats([
      post('gm 🐱'),
      post('encore 🐱'),
      post('autre chose 🚀'),
    ])
    expect(stats.emojiInventory[0]).toBe('🐱')
    expect(stats.emojiRate).toBe(1)
  })

  it('détecte le style tout-en-minuscules', () => {
    const stats = computeFormStats(TERSE_CORPUS)
    expect(stats.lowercaseStartRate).toBe(1)
    expect(stats.capitalizedStartRate).toBe(0)
  })

  it('mesure le rythme des retours à la ligne', () => {
    const stats = computeFormStats([
      post('ligne un\nligne deux\nligne trois'),
      post('ligne un\nligne deux'),
    ])
    expect(stats.lineBreakRate).toBe(1)
    expect(stats.avgLinesPerPost).toBeCloseTo(2.5, 1)
  })

  it('ne compte pas les sigles courts comme des capitales emphatiques', () => {
    // « CA », « LP », « OK » et les tickers passeraient sinon pour du style.
    const withAcronyms = computeFormStats([post('CA is out, LP is locked, ok')])
    const withShouting = computeFormStats([post('THIS IS ACTUALLY IMPORTANT everyone')])
    expect(withAcronyms.allCapsWordRate).toBe(0)
    expect(withShouting.allCapsWordRate).toBeGreaterThan(0.4)
  })

  it('calcule un mix linguistique qui somme à 1', () => {
    const stats = computeFormStats([
      post('le float est le vrai signal dans cette affaire'),
      post('the float is the actual signal in this one'),
      post('the community is what matters here for real'),
    ])
    const total = Object.values(stats.languageMix).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 6)
    expect(stats.languageMix['en']).toBeGreaterThan(stats.languageMix['fr'] ?? 0)
  })
})

describe('tics de langage', () => {
  it('extrait un tic d’ouverture d’un seul mot', () => {
    // Le cas le plus courant, et celui qu'une fenêtre fixe de trois mots raterait :
    // « honestly the float » et « honestly nobody reads » ne se ressemblent qu'au premier mot.
    const openers = extractSignatureOpeners([
      post('honestly the float matters more'),
      post('honestly nobody reads the docs'),
      post('honestly this is the whole game'),
    ])
    expect(openers).toContain('honestly')
  })

  it('préfère la forme la plus longue qui se répète', () => {
    // « hot take » est plus informatif que « hot » : garder les deux encombrerait le prompt.
    const openers = extractSignatureOpeners([
      post('hot take the float is everything'),
      post('hot take nobody needs another dog coin'),
      post('hot take liquidity locks are theater'),
    ])
    expect(openers).toContain('hot take')
    expect(openers).not.toContain('hot')
  })

  it('écarte une ouverture d’un seul mot vide', () => {
    // « the » ou « le » domineraient sans rien dire du style.
    const openers = extractSignatureOpeners([
      post('the float matters here'),
      post('the community decides'),
      post('the launch was fine'),
    ])
    expect(openers).not.toContain('the')
  })

  it('ignore une ouverture vue une seule fois', () => {
    // Une occurrence unique n'est pas un tic, c'est une phrase.
    expect(extractSignatureOpeners([post('une phrase unique ici')])).toHaveLength(0)
  })

  it('extrait les n-grammes récurrents en ignorant les mots vides', () => {
    const phrases = extractSignaturePhrases([
      post('the float is what matters'),
      post('the float is the signal'),
      post('the float is underrated'),
    ])
    expect(phrases.some((p) => p.includes('float'))).toBe(true)
  })
})

describe('exemples canoniques', () => {
  it('exclut les posts qui ne passent pas le garde-fou (MH-18)', () => {
    const corpus = [
      ...TERSE_CORPUS,
      post('this is going 100x, maximum potential', {
        passesGuard: false,
        guardCategories: ['financial-advice'],
      }),
    ]
    const stats = computeFormStats(corpus)
    const examples = selectCanonicalExamples(corpus, stats)
    expect(examples.some((e) => e.includes('100x'))).toBe(false)
  })

  it('ne trie PAS par engagement', () => {
    // Trier par likes biaiserait le profil vers un seul registre — celui qui a marché une
    // fois — et le WRITER produirait des variantes de ce coup de chance.
    const corpus = [
      post('un post parfaitement median en longueur ici voila', { likeCount: 1 }),
      post('court', { likeCount: 99999 }),
    ]
    const stats = computeFormStats(corpus)
    const examples = selectCanonicalExamples(corpus, stats, 1)
    expect(examples[0]).not.toBe('court')
  })

  it('écarte les posts trop courts pour enseigner un style', () => {
    const corpus = [post('gm'), post('ok'), ...TERSE_CORPUS]
    const stats = computeFormStats(corpus)
    expect(selectCanonicalExamples(corpus, stats)).not.toContain('gm')
  })

  it('renvoie une liste vide si rien ne passe le garde-fou', () => {
    const corpus = [post('100x incoming', { passesGuard: false })]
    expect(selectCanonicalExamples(corpus, computeFormStats(corpus))).toHaveLength(0)
  })
})

describe('règles dérivées', () => {
  it('déduit des règles franches d’un corpus laconique', () => {
    const { doRules, dontRules } = deriveRules(computeFormStats(TERSE_CORPUS), pack)
    expect(dontRules.join(' ')).toContain('Aucun emoji')
    expect(dontRules.join(' ')).toContain('exclamation')
    expect(doRules.join(' ')).toContain('minuscule')
  })

  it('transmet le lexique banni du pack comme règle explicite', () => {
    // Le modèle doit le voir ici aussi, pas seulement dans les garde-fous partagés.
    const { dontRules } = deriveRules(computeFormStats(TERSE_CORPUS), pack)
    expect(dontRules.join(' ')).toContain('100x')
  })

  it('produit les mêmes règles pour les mêmes statistiques', () => {
    // Déterminisme requis : des règles qui bougent sans raison feraient attribuer la
    // variation au prompt par la boucle d'apprentissage.
    const stats = computeFormStats(TERSE_CORPUS)
    expect(deriveRules(stats, pack)).toEqual(deriveRules(stats, pack))
  })
})

describe('confiance', () => {
  it('croît avec le corpus exploitable, avec un rendement décroissant', () => {
    expect(computeConfidence(0)).toBe(0)
    expect(computeConfidence(50)).toBe(1)
    // Le gain du dixième post est bien supérieur à celui du cinquantième.
    const gainEarly = computeConfidence(10) - computeConfidence(5)
    const gainLate = computeConfidence(50) - computeConfidence(45)
    expect(gainEarly).toBeGreaterThan(gainLate)
  })

  it('est plafonnée à 1', () => {
    expect(computeConfidence(500)).toBe(1)
  })
})

describe('assemblage du profil', () => {
  it('sépare la forme du registre — le cœur de MH-18', () => {
    // La forme est calculée sur le corpus ENTIER : la forme d'un post promotionnel reste la
    // forme de l'utilisateur. Le registre, lui, est filtré.
    const promo = post('MAXIMUM POTENTIAL 🚀\n\nfrom microcap to legendary\n\n$acme', {
      passesGuard: false,
      guardCategories: ['financial-advice'],
    })
    const profile = buildVoiceProfile({
      handle: '@ACMECTO',
      posts: [...TERSE_CORPUS, promo],
      pack,
      clock,
    })

    // Forme : le post promotionnel a compté.
    expect(profile.stats.sampleSize).toBe(7)
    expect(profile.stats.lineBreakRate).toBeGreaterThan(0)
    // Registre : il n'a pas compté.
    expect(profile.canonicalExamples.some((e) => e.includes('MAXIMUM'))).toBe(false)
    expect(profile.guardExcludedCount).toBe(1)
  })

  it('normalise le handle', () => {
    const profile = buildVoiceProfile({
      handle: '@ACMECTO',
      posts: TERSE_CORPUS,
      pack,
      clock,
    })
    expect(profile.handle).toBe('ACMECTO')
  })

  it('signale un corpus majoritairement écarté', () => {
    // Diagnostic honnête : le produit doit pouvoir dire « cette voix est largement non
    // reproductible » au lieu de produire une imitation dégradée en silence.
    const promos = Array.from({ length: 9 }, () =>
      post('100x incoming, maximum potential', { passesGuard: false }),
    )
    const profile = buildVoiceProfile({
      handle: 'ACMECTO',
      posts: [...promos, TERSE_CORPUS[0]!],
      pack,
      clock,
    })
    expect(profile.guardExcludedRatio).toBeCloseTo(0.9, 2)
    expect(describeProfile(profile)).toContain('non reproductible')
  })

  it('un profil sans exemple exploitable n’est pas utilisable', () => {
    const profile = buildVoiceProfile({
      handle: 'x',
      posts: [post('100x', { passesGuard: false })],
      pack,
      clock,
    })
    expect(isProfileUsable(profile)).toBe(false)
    expect(describeProfile(profile)).toContain('insuffisant')
  })

  it('gère un corpus vide sans lancer', () => {
    const profile = buildVoiceProfile({ handle: 'x', posts: [], pack, clock })
    expect(profile.sampleSize).toBe(0)
    expect(profile.confidence).toBe(0)
    expect(describeProfile(profile)).toContain('Aucun post')
  })
})

describe('MH-18 — le profil ne peut pas véhiculer du contenu interdit', () => {
  /**
   * Le test qui compte. Un corpus entièrement promotionnel, mais dont les posts ont été
   * marqués `passesGuard: true` par erreur — config périmée, requalification oubliée, bug
   * de collecte. Le filet de `sanitizeProfile` doit rattraper.
   */
  const mislabelled = [
    post('this is going 100x, guaranteed returns', { passesGuard: true }),
    post('to the moon, price target $4 soon', { passesGuard: true }),
    post('presale whitelist spot available now', { passesGuard: true }),
    post('ape in before it moons, maximum potential', { passesGuard: true }),
    post('from microcap to legendary, dont miss', { passesGuard: true }),
  ]

  it('aucun exemple canonique ne contient un signal de prix', () => {
    const profile = buildVoiceProfile({ handle: 'x', posts: mislabelled, pack, clock })
    for (const example of profile.canonicalExamples) {
      expect(example, `exemple interdit retenu : ${example}`).not.toMatch(
        /100x|to the moon|price target|guaranteed|presale|ape in/i,
      )
    }
  })

  it('aucune règle « à faire » ne contient un terme banni', () => {
    const profile = buildVoiceProfile({ handle: 'x', posts: mislabelled, pack, clock })
    for (const rule of profile.doRules) {
      for (const banned of pack.lexicon.banned) {
        expect(rule.toLowerCase(), `règle do citant « ${banned} »`).not.toContain(
          banned.toLowerCase(),
        )
      }
    }
  })

  it('les règles « à ne pas faire » CITENT les interdits — c’est leur fonction', () => {
    // Filtrer « jamais 100x » retirerait la règle qui interdit « 100x ». La distinction
    // entre citer et reproduire est ce qui rend le filet correct.
    const profile = buildVoiceProfile({ handle: 'x', posts: mislabelled, pack, clock })
    expect(profile.dontRules.join(' ')).toContain('100x')
  })

  it('aucun tic de langage extrait ne reconstitue une formulation interdite', () => {
    const profile = buildVoiceProfile({ handle: 'x', posts: mislabelled, pack, clock })
    for (const phrase of [...profile.signaturePhrases, ...profile.signatureOpeners]) {
      expect(phrase).not.toMatch(/100x|moon|guaranteed|presale/i)
    }
  })
})
