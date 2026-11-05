/**
 * MÉMOIRE RELATIONNELLE — différenciateur n°3.
 *
 * Le bloc central est l'**asymétrie de `warmth`**. Sans elle, la familiarité mesurerait notre
 * insistance et non leur réceptivité — et le scoring d'affinité récompenserait précisément le
 * comportement que le produit existe pour éviter.
 *
 * Les tests portent sur des **trajectoires**, pas sur des pas isolés : la propriété qui compte
 * n'est pas « une réponse ajoute 0 » mais « répondre dix fois sans réciprocité ne crée aucune
 * intimité ».
 */
import { describe, expect, it } from 'vitest'
import {
  applyDecay,
  applyInteraction,
  buildRelationshipBrief,
  emptyRelationship,
  familiarityLevel,
  MAX_WARMTH,
  RELATIONSHIP_STALE_AFTER_MS,
  toneGuidance,
  WARMTH_DECAY_AFTER_MS,
  type InteractionKind,
} from '@/memory/relationships'
import {
  checkCooldown,
  normalizedWarmth,
  progressToNextLevel,
} from '@/memory/warmth'
import { DAY, FakeClock } from '@/shared/time'

const START = '2026-08-25T12:00:00.000Z'

function sequence(kinds: readonly InteractionKind[], clock = new FakeClock(START)) {
  let relationship = emptyRelationship('someone', clock.now())
  for (const kind of kinds) {
    relationship = applyInteraction(relationship, { handle: 'someone', kind }, clock)
    // Une heure entre chaque : assez pour que ce soient des interactions distinctes, pas assez
    // pour déclencher un refroidissement.
    clock.advanceHours(1)
  }
  return relationship
}

describe('asymétrie de warmth — le cœur du module', () => {
  it('répondre dix fois sans réciprocité ne crée AUCUNE intimité', () => {
    // Le test qui définit le module. Une familiarité qui monte parce qu'on parle beaucoup
    // mesurerait notre insistance.
    const relationship = sequence(Array.from({ length: 10 }, () => 'we-replied' as const))
    expect(relationship.interactionCount).toBe(10)
    expect(relationship.warmth).toBe(0)
    expect(familiarityLevel(relationship)).toBe('croisé')
  })

  it('la réciprocité fait monter la familiarité', () => {
    const relationship = sequence([
      'we-replied',
      'they-replied',
      'we-replied',
      'they-replied',
      'we-replied',
      'they-reposted',
    ])
    expect(relationship.warmth).toBeGreaterThan(1.5)
    expect(familiarityLevel(relationship)).not.toBe('croisé')
  })

  it('un abonnement pèse plus que tout le reste', () => {
    // C'est l'objectif du produit : le noyer dans les likes rendrait la mesure aveugle.
    const followed = sequence(['they-followed'])
    const liked = sequence(['they-liked', 'they-liked', 'they-liked', 'they-liked'])
    expect(followed.warmth).toBeGreaterThan(liked.warmth)
  })

  it('l’indifférence fait DESCENDRE la familiarité', () => {
    const warm = sequence(['they-replied', 'they-replied', 'they-replied'])
    const cooled = sequence([
      'they-replied',
      'they-replied',
      'they-replied',
      ...Array.from({ length: 6 }, () => 'ignored' as const),
    ])
    expect(cooled.warmth).toBeLessThan(warm.warmth)
    expect(cooled.ignoredCount).toBe(6)
  })

  it('reste bornée à l’échelle 0–5', () => {
    const saturated = sequence(Array.from({ length: 30 }, () => 'they-followed' as const))
    expect(saturated.warmth).toBe(MAX_WARMTH)

    const floored = sequence(Array.from({ length: 50 }, () => 'ignored' as const))
    expect(floored.warmth).toBe(0)
  })

  it('seules NOS actions comptent comme interactions', () => {
    // Leurs réactions sont des signaux, pas des tours de parole : les compter gonflerait
    // artificiellement l'historique.
    const relationship = sequence(['we-replied', 'they-replied', 'they-liked', 'they-reposted'])
    expect(relationship.interactionCount).toBe(1)
  })
})

describe('refroidissement temporel', () => {
  it('une relation sans interaction refroidit d’un cran par période', () => {
    const clock = new FakeClock(START)
    const warm = sequence(['they-followed', 'they-followed', 'they-replied'], clock)
    const before = warm.warmth

    clock.advance(WARMTH_DECAY_AFTER_MS * 2 + DAY)
    const decayed = applyDecay(warm, clock)
    expect(decayed.warmth).toBeLessThan(before - 1)
  })

  it('ne refroidit pas avant l’échéance', () => {
    const clock = new FakeClock(START)
    const warm = sequence(['they-replied'], clock)
    clock.advance(WARMTH_DECAY_AFTER_MS - DAY)
    expect(applyDecay(warm, clock).warmth).toBe(warm.warmth)
  })

  it('une interaction après une longue absence ne repart PAS du niveau d’avant', () => {
    // Sinon on présumerait une intimité qui n'existe plus.
    const clock = new FakeClock(START)
    let relationship = sequence(
      ['they-followed', 'they-followed', 'they-replied', 'they-replied'],
      clock,
    )
    const peak = relationship.warmth

    clock.advance(WARMTH_DECAY_AFTER_MS * 3)
    relationship = applyInteraction(relationship, { handle: 'someone', kind: 'we-replied' }, clock)
    expect(relationship.warmth).toBeLessThan(peak)
  })

  it('une relation jamais entamée ne refroidit pas', () => {
    const clock = new FakeClock(START)
    const fresh = emptyRelationship('someone', clock.now())
    clock.advance(WARMTH_DECAY_AFTER_MS * 10)
    expect(applyDecay(fresh, clock).warmth).toBe(0)
  })
})

describe('sujets et notes', () => {
  it('fusionne les sujets sans doublon', () => {
    const clock = new FakeClock(START)
    let relationship = emptyRelationship('someone', clock.now())
    relationship = applyInteraction(
      relationship,
      { handle: 'someone', kind: 'we-replied', ourTopics: ['Liquidité', 'float'] },
      clock,
    )
    relationship = applyInteraction(
      relationship,
      { handle: 'someone', kind: 'we-replied', ourTopics: ['liquidité', 'holders'] },
      clock,
    )
    expect(relationship.ourTopics).toEqual(['liquidité', 'float', 'holders'])
  })

  it('borne la liste de sujets', () => {
    // Au-delà, la liste devient un nuage de mots inutilisable dans un prompt.
    const clock = new FakeClock(START)
    let relationship = emptyRelationship('someone', clock.now())
    for (let i = 0; i < 40; i++) {
      relationship = applyInteraction(
        relationship,
        { handle: 'someone', kind: 'we-replied', theirTopics: [`sujet${i}`] },
        clock,
      )
    }
    expect(relationship.theirTopics.length).toBeLessThanOrEqual(20)
  })

  it('borne les notes', () => {
    // Elles vont dans le prompt du STRATEGIST : une note sans borne coûterait plus que la
    // réponse qu'elle informe.
    const clock = new FakeClock(START)
    let relationship = emptyRelationship('someone', clock.now())
    for (let i = 0; i < 100; i++) {
      relationship = applyInteraction(
        relationship,
        { handle: 'someone', kind: 'we-replied', note: `note numéro ${i} avec du contexte` },
        clock,
      )
    }
    expect(relationship.notes.length).toBeLessThanOrEqual(1_000)
  })

  it('normalise le handle', () => {
    expect(emptyRelationship('@SomeOne', 0).handle).toBe('someone')
  })
})

describe('brief pour le STRATEGIST', () => {
  it('avertit quand on parle plus qu’on n’est écouté', () => {
    // Le cas exact que l'asymétrie de `warmth` existe pour rendre visible.
    const clock = new FakeClock(START)
    const insistent = sequence(Array.from({ length: 6 }, () => 'we-replied' as const), clock)
    const brief = buildRelationshipBrief(insistent, clock)
    expect(brief?.warning).toContain('plus qu’on n’est écouté')
  })

  it('avertit après plusieurs réponses ignorées', () => {
    const clock = new FakeClock(START)
    const ignored = sequence(
      ['we-replied', 'ignored', 'we-replied', 'ignored', 'we-replied', 'ignored'],
      clock,
    )
    const brief = buildRelationshipBrief(ignored, clock)
    expect(brief?.warning).toContain('pas réceptif')
  })

  it('n’avertit pas sur une relation saine', () => {
    const clock = new FakeClock(START)
    const healthy = sequence(['we-replied', 'they-replied', 'we-replied', 'they-reposted'], clock)
    expect(buildRelationshipBrief(healthy, clock)?.warning).toBeNull()
  })

  it('une relation éteinte redevient un inconnu', () => {
    // Ne pas présumer d'une intimité vieille de six mois.
    const clock = new FakeClock(START)
    const old = sequence(['they-followed', 'they-followed', 'they-replied'], clock)
    clock.advance(RELATIONSHIP_STALE_AFTER_MS + DAY)

    const brief = buildRelationshipBrief(old, clock)
    expect(brief?.stale).toBe(true)
    expect(brief?.level).toBe('inconnu')
    expect(brief?.tone).toContain('Premier contact')
  })

  it('renvoie null sur un compte inconnu', () => {
    expect(buildRelationshipBrief(null, new FakeClock(START))).toBeNull()
  })

  it('le registre change avec la familiarité', () => {
    const levels = ['inconnu', 'croisé', 'connu', 'familier', 'proche'] as const
    const tones = levels.map((level) => toneGuidance(level))
    // Cinq registres distincts : un ton uniforme raterait ce que le CRM social apporte.
    expect(new Set(tones).size).toBe(5)
    expect(tones[0]).toContain('pas de familiarité')
    expect(tones[4]).toContain('bref')
  })
})

describe('période de refroidissement par familiarité', () => {
  it('est plus longue pour un inconnu que pour un proche', () => {
    // Répondre deux fois dans la journée à un inconnu est du harcèlement ; le faire avec
    // quelqu'un avec qui on échange est une conversation.
    const clock = new FakeClock(START)
    const stranger = sequence(['we-replied'], new FakeClock(START))
    const close = sequence(
      Array.from({ length: 4 }, () => 'they-followed' as const),
      new FakeClock(START),
    )
    expect(checkCooldown(stranger, clock).requiredMs).toBeGreaterThan(
      checkCooldown(close, clock).requiredMs,
    )
  })

  it('autorise un compte jamais contacté', () => {
    const verdict = checkCooldown(null, new FakeClock(START))
    expect(verdict.allowed).toBe(true)
    expect(verdict.reason).toContain('jamais interagi')
  })

  it('refuse une réponse trop rapprochée, avec l’instant de reprise', () => {
    const clock = new FakeClock(START)
    const recent = sequence(['we-replied'], new FakeClock(START))
    const verdict = checkCooldown(recent, clock)
    expect(verdict.allowed).toBe(false)
    expect(verdict.nextAllowedAtMs).toBeGreaterThan(clock.now())
    expect(verdict.reason).toContain('requises')
  })

  it('autorise après expiration', () => {
    const clock = new FakeClock(START)
    const relationship = sequence(['we-replied'], new FakeClock(START))
    clock.advance(5 * DAY)
    expect(checkCooldown(relationship, clock).allowed).toBe(true)
  })
})

describe('progression de familiarité', () => {
  it('indique le palier suivant et ce qu’il demande', () => {
    const relationship = sequence(['they-liked'])
    const progress = progressToNextLevel(relationship)
    expect(progress.next).not.toBeNull()
    // La formulation dit ce qui fait progresser : la réciprocité, pas l'insistance.
    expect(progress.requirement).toContain('réciprocité')
    expect(progress.requirement).toContain('ne suffit pas')
  })

  it('signale le niveau maximum', () => {
    const maxed = sequence(Array.from({ length: 20 }, () => 'they-followed' as const))
    const progress = progressToNextLevel(maxed)
    expect(progress.next).toBeNull()
    expect(progress.progressPct).toBe(100)
  })

  it('la progression est bornée dans [0, 100]', () => {
    for (const kinds of [[], ['they-liked'], ['they-followed', 'they-followed']] as InteractionKind[][]) {
      const progress = progressToNextLevel(kinds.length === 0 ? null : sequence(kinds))
      expect(progress.progressPct).toBeGreaterThanOrEqual(0)
      expect(progress.progressPct).toBeLessThanOrEqual(100)
    }
  })

  it('normalise la familiarité dans [0, 1] pour le scoring', () => {
    expect(normalizedWarmth(null)).toBe(0)
    const maxed = sequence(Array.from({ length: 20 }, () => 'they-followed' as const))
    expect(normalizedWarmth(maxed)).toBe(1)
  })
})
