/**
 * ANALYST et boucle d'apprentissage — le différenciateur n°2.
 *
 * Le bloc le plus important est le dernier : **le DoD de la Phase 5**, « les prompts changent
 * démontrablement en fonction des performances passées ». `hasLearned` y répond par oui ou
 * non, ce qu'une inspection visuelle ne fait pas.
 *
 * Le reste protège la propriété qui rend l'apprentissage utile plutôt que nuisible : un
 * pattern à n=3 n'est pas un pattern, et le réinjecter ferait converger le WRITER sur du
 * bruit — une convergence qui rendrait la mesure auto-réalisatrice.
 */
import { describe, expect, it } from 'vitest'
import {
  MEASUREMENT_OFFSETS,
  engagementScore,
  isUsableOutcome,
  selectDueMeasurements,
  toOutcome,
} from '@/analytics/measure'
import {
  ATTRIBUTION_WINDOW_MS,
  attributeFollowers,
  attributionCaveat,
} from '@/analytics/attribution'
import {
  MIN_SAMPLE_SIZE,
  TOP_N,
  aggregatePatterns,
  authorTierBucket,
  digestPatterns,
  hourBucket,
  lengthBucket,
  patternConfidence,
  weekdayBucket,
  type ObservedAction,
} from '@/analytics/aggregate'
import {
  buildPatternBlock,
  describeDigest,
  digestFingerprint,
  hasLearned,
} from '@/analytics/inject'
import type { Action, Outcome, Pattern } from '@/db/schema'
import { DAY, FakeClock, HOUR } from '@/shared/time'

const clock = new FakeClock('2026-08-25T12:00:00.000Z')
const NOW = clock.now()

let seq = 0
function action(overrides: Partial<Action> = {}): Action {
  seq += 1
  return {
    id: seq,
    idempotencyKey: `k-${seq}`,
    type: 'reply',
    opportunityId: seq,
    draftId: seq,
    content: 'une réponse de longueur moyenne pour les tests de tranche',
    stagedAtMs: NOW - 10 * DAY,
    publishedAtMs: NOW - 10 * DAY,
    outcome: 'published',
    xPostId: `17894569999999${String(seq).padStart(5, '0')}`,
    agentTrail: [],
    totalCostEur: 0.014,
    promptVersionHash: 'abc123',
    nichePackId: 'memecoin',
    ...overrides,
  }
}

function outcome(actionId: number, offset: 1 | 7, overrides: Partial<Outcome> = {}): Outcome {
  return {
    id: actionId * 10 + offset,
    actionId,
    dayOffset: offset,
    checkedAtMs: NOW,
    impressions: 1_200,
    likes: 12,
    replies: 2,
    reposts: 1,
    profileClicks: 5,
    attributedFollows: 0,
    ...overrides,
  }
}

describe('sélection des mesures dues', () => {
  it('ne mesure QUE les actions confirmées publiées (MH-09)', () => {
    // Mesurer une action abandonnée renverrait les métriques d'un post inexistant, et la
    // boucle s'entraînerait sur du bruit.
    const targets = selectDueMeasurements(
      [
        action({ outcome: 'published' }),
        action({ outcome: 'abandoned' }),
        action({ outcome: 'pending' }),
      ],
      [],
      clock,
    )
    expect(new Set(targets.map((t) => t.action.outcome))).toEqual(new Set(['published']))
  })

  it('produit une mesure par décalage', () => {
    const targets = selectDueMeasurements([action()], [], clock)
    expect(targets.map((t) => t.offset).sort()).toEqual([...MEASUREMENT_OFFSETS])
  })

  it('n’est pas due avant l’échéance', () => {
    // Publiée il y a deux heures : ni J+1 ni J+7.
    const recent = action({ publishedAtMs: NOW - 2 * HOUR })
    expect(selectDueMeasurements([recent], [], clock)).toHaveLength(0)
  })

  it('J+1 est due, J+7 pas encore', () => {
    const yesterday = action({ publishedAtMs: NOW - 2 * DAY })
    const targets = selectDueMeasurements([yesterday], [], clock)
    expect(targets.map((t) => t.offset)).toEqual([1])
  })

  it('ne remesure pas ce qui l’a déjà été', () => {
    const a = action()
    const targets = selectDueMeasurements([a], [outcome(a.id!, 1)], clock)
    expect(targets.map((t) => t.offset)).toEqual([7])
  })

  it('trie les plus anciennes d’abord', () => {
    // Une mesure en retard perd de la valeur ; une mesure récente peut attendre.
    const old = action({ publishedAtMs: NOW - 30 * DAY })
    const recent = action({ publishedAtMs: NOW - 8 * DAY })
    const targets = selectDueMeasurements([recent, old], [], clock)
    expect(targets[0]?.action.id).toBe(old.id)
  })

  it('toOutcome conserve les métriques non lisibles comme null', () => {
    // « Non lisible » et « zéro » sont deux choses différentes : X masque parfois les
    // impressions, et les confondre ferait apprendre sur une absence de mesure.
    const target = selectDueMeasurements([action()], [], clock)[0]!
    const result = toOutcome(
      target,
      { impressions: null, likes: 4, replies: 0, reposts: 1, profileClicks: null },
      2,
      clock,
    )
    expect(result.impressions).toBeNull()
    expect(result.profileClicks).toBeNull()
    expect(result.attributedFollows).toBe(2)
  })
})

describe('score d’engagement', () => {
  it('pondère selon l’effort demandé', () => {
    // Une réponse demande plus qu'un repost, qui demande plus qu'un like.
    const like = engagementScore({ likes: 1, replies: 0, reposts: 0, attributedFollows: 0 })
    const repost = engagementScore({ likes: 0, replies: 0, reposts: 1, attributedFollows: 0 })
    const reply = engagementScore({ likes: 0, replies: 1, reposts: 0, attributedFollows: 0 })
    expect(repost).toBeGreaterThan(like)
    expect(reply).toBeGreaterThan(repost)
  })

  it('un follower gagné pèse un ordre de grandeur au-dessus', () => {
    // C'est l'objectif du produit : le noyer dans les likes rendrait les patterns aveugles à
    // ce qui compte vraiment.
    const follow = engagementScore({ likes: 0, replies: 0, reposts: 0, attributedFollows: 1 })
    const manyLikes = engagementScore({ likes: 15, replies: 0, reposts: 0, attributedFollows: 0 })
    expect(follow).toBeGreaterThan(manyLikes)
  })

  it('les impressions sont EXCLUES du score', () => {
    // X les masque régulièrement : une métrique qui disparaît la moitié du temps rendrait les
    // patterns incomparables entre les périodes.
    const a = engagementScore({ likes: 5, replies: 1, reposts: 1, attributedFollows: 0 })
    const b = engagementScore({ likes: 5, replies: 1, reposts: 1, attributedFollows: 0 })
    expect(a).toBe(b)
  })

  it('une mesure entièrement nulle est inexploitable', () => {
    // Impossible de distinguer « a fait zéro » d'un échec de lecture. Apprendre dessus serait
    // apprendre sur une erreur.
    expect(
      isUsableOutcome(outcome(1, 1, { likes: 0, replies: 0, reposts: 0, impressions: null })),
    ).toBe(false)
    expect(isUsableOutcome(outcome(1, 1, { likes: 0, replies: 0, reposts: 0, impressions: 900 }))).toBe(
      true,
    )
  })
})

describe('attribution des abonnés', () => {
  const samples = [
    { atMs: NOW - 2 * DAY, count: 1_000 },
    { atMs: NOW - DAY, count: 1_010 },
    { atMs: NOW, count: 1_030 },
  ]

  it('répartit proportionnellement aux clics profil', () => {
    // Le seul lien mesurable entre une réponse et une visite de profil.
    const a = action({ id: 101, publishedAtMs: NOW - 2 * DAY })
    const b = action({ id: 102, publishedAtMs: NOW - DAY })
    const result = attributeFollowers({
      followerSamples: samples,
      publishedActions: [
        { action: a, profileClicks: 30 },
        { action: b, profileClicks: 10 },
      ],
      clock,
    })
    expect(result.attributed).toBeGreaterThan(0)
    expect(result.byActionId.get(101)!).toBeGreaterThan(result.byActionId.get(102)!)
  })

  it('un seul relevé n’attribue rien, et le dit', () => {
    const result = attributeFollowers({
      followerSamples: [{ atMs: NOW, count: 1_000 }],
      publishedActions: [{ action: action(), profileClicks: 10 }],
      clock,
    })
    expect(result.attributed).toBe(0)
    expect(result.confidence).toBe(0)
    expect(attributionCaveat(result)).toContain('Pas assez de relevés')
  })

  it('un gain sans action à expliquer est compté NON attribué', () => {
    // Croissance organique, ou effet d'un post antérieur : le compter comme attribué serait
    // s'attribuer un mérite qu'on n'a pas.
    const result = attributeFollowers({
      followerSamples: samples,
      publishedActions: [],
      clock,
    })
    expect(result.attributed).toBe(0)
    expect(result.unattributed).toBe(30)
  })

  it('sans données de clics, répartit uniformément mais baisse la confiance', () => {
    // Une répartition uniforme n'explique rien : le dire est plus honnête que de la présenter
    // comme un résultat.
    const result = attributeFollowers({
      followerSamples: samples,
      publishedActions: [
        { action: action({ id: 201, publishedAtMs: NOW - DAY }), profileClicks: null },
        { action: action({ id: 202, publishedAtMs: NOW - DAY }), profileClicks: null },
      ],
      clock,
    })
    expect(result.byActionId.get(201)).toBe(result.byActionId.get(202))
    expect(result.confidence).toBeLessThan(0.4)
    expect(attributionCaveat(result)).toContain('corrélation temporelle')
  })

  it('la confiance chute quand beaucoup d’actions se disputent le gain', () => {
    const oneAction = attributeFollowers({
      followerSamples: samples,
      publishedActions: [
        { action: action({ id: 301, publishedAtMs: NOW - DAY }), profileClicks: 20 },
      ],
      clock,
    })
    const manyActions = attributeFollowers({
      followerSamples: samples,
      publishedActions: Array.from({ length: 10 }, (_, i) => ({
        action: action({ id: 400 + i, publishedAtMs: NOW - DAY }),
        profileClicks: 5,
      })),
      clock,
    })
    expect(manyActions.confidence).toBeLessThan(oneAction.confidence)
  })

  it('ignore les actions hors fenêtre d’attribution', () => {
    const tooOld = action({ id: 501, publishedAtMs: NOW - 20 * DAY })
    const result = attributeFollowers({
      followerSamples: samples,
      publishedActions: [{ action: tooOld, profileClicks: 100 }],
      clock,
    })
    expect(result.byActionId.has(501)).toBe(false)
    expect(ATTRIBUTION_WINDOW_MS).toBeLessThan(20 * DAY)
  })

  it('aucun gain observé : rien à attribuer, confiance totale', () => {
    const flat = [
      { atMs: NOW - DAY, count: 1_000 },
      { atMs: NOW, count: 1_000 },
    ]
    const result = attributeFollowers({
      followerSamples: flat,
      publishedActions: [{ action: action(), profileClicks: 10 }],
      clock,
    })
    expect(result.attributed).toBe(0)
    expect(result.confidence).toBe(1)
    expect(attributionCaveat(result)).toBeNull()
  })
})

describe('tranches de dimension', () => {
  it('classe les longueurs en bornes lisibles', () => {
    expect(lengthBucket('court')).toContain('très court')
    expect(lengthBucket('x'.repeat(90))).toContain('court')
    expect(lengthBucket('x'.repeat(150))).toContain('moyen')
    expect(lengthBucket('x'.repeat(300))).toContain('long')
  })

  it('classe les heures en heure LOCALE', () => {
    // Un pattern horaire calé sur UTC serait faux pour tout utilisateur non britannique.
    const utcMidnight = Date.parse('2026-08-25T00:00:00.000Z')
    expect(hourBucket(utcMidnight, 0)).toContain('nuit')
    // Même instant, fuseau Paris (+2) : il est 2 h du matin, donc encore la nuit.
    expect(hourBucket(utcMidnight, -120)).toContain('nuit')
    // 22 h UTC = minuit à Paris.
    expect(hourBucket(Date.parse('2026-08-25T22:00:00.000Z'), -120)).toContain('nuit')
  })

  it('distingue semaine et week-end', () => {
    // 2026-08-23 est un dimanche.
    expect(weekdayBucket(Date.parse('2026-08-23T12:00:00.000Z'), 0)).toBe('week-end')
    expect(weekdayBucket(Date.parse('2026-08-25T12:00:00.000Z'), 0)).toBe('semaine')
  })

  it('classe les audiences en bornes logarithmiques', () => {
    expect(authorTierBucket(null)).toBe('inconnu')
    expect(authorTierBucket(500)).toContain('micro')
    expect(authorTierBucket(5_000)).toContain('petit')
    expect(authorTierBucket(50_000)).toContain('moyen')
    expect(authorTierBucket(500_000)).toContain('grand')
  })
})

describe('confiance d’un pattern', () => {
  it('croît avec la taille de l’échantillon', () => {
    const few = patternConfidence([10, 12, 11], 5)
    const many = patternConfidence(Array.from({ length: 30 }, () => 11), 5)
    expect(many).toBeGreaterThan(few)
  })

  it('CHUTE quand les mesures sont dispersées', () => {
    // La composante que les agrégations naïves oublient, et celle qui empêche un unique post
    // viral de créer un « pattern ».
    const stable = patternConfidence([10, 11, 10, 11, 10, 11, 10, 11, 10, 11], 5)
    const wild = patternConfidence([1, 400, 2, 3, 1, 500, 2, 1, 3, 2], 5)
    expect(wild).toBeLessThan(stable / 2)
  })

  it('est nulle sur un pattern indiscernable de la moyenne globale', () => {
    // Un pattern qui fait exactement la moyenne n'apprend rien, même stable et nombreux.
    const identical = patternConfidence(Array.from({ length: 30 }, () => 10), 10)
    const distinct = patternConfidence(Array.from({ length: 30 }, () => 20), 10)
    expect(identical).toBeLessThan(distinct)
  })

  it('est nulle sur un échantillon vide', () => {
    expect(patternConfidence([], 10)).toBe(0)
  })
})

describe('agrégation', () => {
  function observation(contentLength: number, likes: number, id: number): ObservedAction {
    const a = action({
      id,
      content: 'x'.repeat(contentLength),
      publishedAtMs: NOW - 10 * DAY,
    })
    return { action: a, outcomes: [outcome(id, 7, { likes, replies: 0, reposts: 0 })] }
  }

  it('écarte les actions non publiées et le compte', () => {
    const result = aggregatePatterns(
      [
        { action: action({ outcome: 'abandoned' }), outcomes: [] },
        observation(80, 20, 900),
      ],
      clock,
    )
    expect(result.skipped['non-publiee']).toBe(1)
    expect(result.usableSample).toBe(1)
  })

  it('écarte les mesures inexploitables et le compte', () => {
    const zero = action({ id: 910 })
    const result = aggregatePatterns(
      [
        {
          action: zero,
          outcomes: [outcome(910, 7, { likes: 0, replies: 0, reposts: 0, impressions: null })],
        },
      ],
      clock,
    )
    expect(result.skipped['mesure-inexploitable']).toBe(1)
    expect(result.usableSample).toBe(0)
  })

  it('utilise la mesure la plus TARDIVE, sans additionner', () => {
    // J+7 englobe J+1 : additionner compterait le même engagement deux fois.
    const a = action({ id: 920 })
    const result = aggregatePatterns(
      [
        {
          action: a,
          outcomes: [outcome(920, 1, { likes: 5 }), outcome(920, 7, { likes: 50 })],
        },
      ],
      clock,
    )
    // Le score doit refléter 50 likes, pas 55.
    expect(result.globalAverage).toBe(engagementScore({ likes: 50, replies: 2, reposts: 1, attributedFollows: 0 }))
  })

  it('regroupe par dimension et valeur', () => {
    const result = aggregatePatterns(
      [observation(80, 10, 930), observation(85, 20, 931), observation(300, 5, 932)],
      clock,
    )
    const lengthPatterns = result.patterns.filter((p) => p.dimension === 'length')
    expect(lengthPatterns.length).toBeGreaterThanOrEqual(2)
    const shortPattern = lengthPatterns.find((p) => p.value.includes('court'))
    expect(shortPattern?.sampleSize).toBe(2)
  })

  it('accepte les angles fournis depuis les brouillons', () => {
    // L'angle n'est pas sur l'action : on ne le devine pas depuis le texte, un angle inféré
    // serait faux la moitié du temps et contaminerait tous les patterns d'angle.
    const angles = new Map([
      [940, 'counterpoint'],
      [941, 'data'],
    ])
    const result = aggregatePatterns(
      [observation(80, 10, 940), observation(80, 30, 941)],
      clock,
      angles,
    )
    const anglePatterns = result.patterns.filter((p) => p.dimension === 'angle')
    expect(anglePatterns.map((p) => p.value).sort()).toEqual(['counterpoint', 'data'])
  })

  it('gère un ensemble vide sans NaN', () => {
    const result = aggregatePatterns([], clock)
    expect(result.patterns).toHaveLength(0)
    expect(Number.isFinite(result.globalAverage)).toBe(true)
  })
})

describe('sélection pour les prompts', () => {
  function pattern(overrides: Partial<Pattern>): Pattern {
    return {
      dimension: 'angle',
      value: 'counterpoint',
      sampleSize: MIN_SAMPLE_SIZE + 5,
      avgEngagement: 20,
      avgAttributedFollows: 0.5,
      confidence: 0.7,
      updatedAtMs: NOW,
      ...overrides,
    }
  }

  it('FILTRE les patterns sous le seuil d’échantillon', () => {
    // Un pattern à n=3 en tête de liste ferait converger le WRITER sur du bruit, et cette
    // convergence rendrait la mesure auto-réalisatrice.
    const digest = digestPatterns([pattern({ sampleSize: 3, avgEngagement: 999 })], 10, 3)
    expect(digest.insufficient).toBe(true)
    expect(digest.top).toHaveLength(0)
  })

  it('filtre aussi les patterns peu fiables', () => {
    const digest = digestPatterns([pattern({ confidence: 0.05 })], 10, 50)
    expect(digest.insufficient).toBe(true)
  })

  it('sépare le top du flop par rapport à la moyenne globale', () => {
    const digest = digestPatterns(
      [
        pattern({ value: 'data', avgEngagement: 30 }),
        pattern({ value: 'joke', avgEngagement: 4 }),
      ],
      10,
      40,
    )
    expect(digest.top.map((p) => p.value)).toContain('data')
    expect(digest.flop.map((p) => p.value)).toContain('joke')
  })

  it('un gros écart peu fiable ne devance pas un écart modéré et solide', () => {
    const digest = digestPatterns(
      [
        pattern({ value: 'fragile', avgEngagement: 100, confidence: 0.25 }),
        pattern({ value: 'solide', avgEngagement: 25, confidence: 0.9 }),
      ],
      10,
      60,
    )
    expect(digest.top[0]?.value).toBe('solide')
  })

  it('borne le top et le flop', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      pattern({ value: `v${i}`, avgEngagement: 20 + i }),
    )
    const digest = digestPatterns(many, 10, 200)
    expect(digest.top.length).toBeLessThanOrEqual(TOP_N)
  })
})

describe('réinjection dans les prompts', () => {
  const strongDigest = digestPatterns(
    [
      {
        dimension: 'angle',
        value: 'counterpoint',
        sampleSize: 15,
        avgEngagement: 30,
        avgAttributedFollows: 1,
        confidence: 0.8,
        updatedAtMs: NOW,
      },
      {
        dimension: 'length',
        value: 'long (200+)',
        sampleSize: 12,
        avgEngagement: 4,
        avgAttributedFollows: 0,
        confidence: 0.7,
        updatedAtMs: NOW,
      },
    ],
    10,
    60,
  )

  it('n’affirme RIEN sans données suffisantes', () => {
    // Le garde-fou principal : un prompt qui affirme sur trois observations ferait converger
    // le WRITER sur du bruit.
    const block = buildPatternBlock(digestPatterns([], 0, 2))
    expect(block).toContain('Pas encore de signal')
    expect(block).toContain("N'infère rien")
  })

  it('DÉCRIT au lieu de commander', () => {
    // « Les réponses courtes ont fait +40 % » laisse le modèle juger ; « écris court » lui
    // retire l'arbitrage. Sur un signal bruité, la première formulation est la seule honnête.
    const block = buildPatternBlock(strongDigest)
    expect(block).toContain('indication, pas comme une consigne')
    expect(block).toContain('suis le post')
    expect(block).not.toMatch(/\bécris (court|long)\b/i)
  })

  it('met la taille d’échantillon DANS la ligne', () => {
    // Un modèle qui lit « +40 % » sans voir « sur 9 observations » traitera le chiffre comme
    // une loi.
    const block = buildPatternBlock(strongDigest)
    expect(block).toMatch(/n=15/)
    expect(block).toMatch(/signal net|tendance|signal faible/)
  })

  it('sépare ce qui a marché de ce qui n’a pas marché', () => {
    const block = buildPatternBlock(strongDigest)
    expect(block).toContain('Ce qui a mieux marché')
    expect(block).toContain('Ce qui a moins bien marché')
  })
})

describe('DoD Phase 5 — les prompts changent démontrablement', () => {
  /**
   * La question exacte du DoD : « les prompts changent démontrablement en fonction des
   * performances passées ». Une empreinte y répond par oui ou non, ce qu'une inspection
   * visuelle ne fait pas.
   */
  const before = digestPatterns([], 0, 2)

  const after = digestPatterns(
    [
      {
        dimension: 'angle',
        value: 'counterpoint',
        sampleSize: 15,
        avgEngagement: 30,
        avgAttributedFollows: 1,
        confidence: 0.8,
        updatedAtMs: NOW,
      },
    ],
    10,
    60,
  )

  it('détecte qu’un cycle d’apprentissage a changé les prompts', () => {
    const result = hasLearned(before, after)
    expect(result.changed).toBe(true)
    expect(result.from).toBe('insufficient')
    expect(result.to).toContain('counterpoint')
  })

  it('le contenu du prompt change réellement, pas seulement l’empreinte', () => {
    const blockBefore = buildPatternBlock(before)
    const blockAfter = buildPatternBlock(after)
    expect(blockAfter).not.toBe(blockBefore)
    expect(blockAfter).toContain('counterpoint')
    expect(blockBefore).not.toContain('counterpoint')
  })

  it('ne signale PAS de changement quand rien n’a bougé', () => {
    // Une empreinte qui bougerait sans que le contenu change invaliderait le cache de prompt
    // pour rien — donc triplerait le coût d'entrée sans raison.
    expect(hasLearned(after, after).changed).toBe(false)
    expect(digestFingerprint(after)).toBe(digestFingerprint(after))
  })

  it('résume l’état de l’apprentissage pour l’UI', () => {
    expect(describeDigest(before)).toContain('Pas encore de signal')
    const described = describeDigest(after)
    expect(described).toContain('60 réponses mesurées')
    expect(described).toContain('counterpoint')
  })
})
