/**
 * ANALYST — le branchement de la boucle d'apprentissage.
 *
 * Ce fichier existe parce que `src/analytics/` était juste et **jamais appelé** : l'alarme de
 * mesure loggait « mesure due » et retournait. Aucun test unitaire ne pouvait le signaler,
 * puisque chaque pièce prise séparément passait. Les tests ci-dessous portent donc sur le
 * raccordement, et surtout sur la règle qui décide de la qualité d'un pattern : **quel relevé
 * a le droit de mesurer quelle échéance**.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createDb, type SwarmDb } from '@/db'
import { DAY, FakeClock } from '@/shared/time'
import type { Action, OwnPost } from '@/db/schema'

let dbSeq = 0
const opened: SwarmDb[] = []
const NOW = Date.parse('2026-08-25T12:00:00.000Z')

function action(overrides: Partial<Action> = {}): Action {
  return {
    idempotencyKey: `key-${Math.abs(hash(JSON.stringify(overrides)))}`,
    type: 'reply',
    opportunityId: null,
    draftId: null,
    content: 'une réponse de longueur moyenne, publiée et mesurable',
    stagedAtMs: NOW - 8 * DAY,
    publishedAtMs: NOW - 8 * DAY,
    outcome: 'published',
    xPostId: '1789456000000000001',
    agentTrail: [],
    totalCostEur: 0.01,
    promptVersionHash: 'abcdef0123456789',
    nichePackId: 'memecoin',
    ...overrides,
  }
}

/** Hash déterministe : les tests n'ont pas droit à `Math.random()` (MH-17). */
function hash(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0
  return h
}

function sighting(overrides: Partial<OwnPost> = {}): OwnPost {
  return {
    postId: '1789456000000000001',
    text: 'une réponse de longueur moyenne, publiée et mesurable',
    lang: 'fr',
    postedAtMs: NOW - 8 * DAY,
    collectedAtMs: NOW - 7 * DAY,
    likeCount: 12,
    replyCount: 3,
    repostCount: 1,
    hasMedia: false,
    isReply: true,
    passesGuard: true,
    guardCategories: [],
    ...overrides,
  }
}

async function setup(): Promise<{
  mod: typeof import('@/background/analyst.handler')
  database: SwarmDb
  clock: FakeClock
  deps: { database: SwarmDb; clock: FakeClock }
}> {
  vi.resetModules()
  const database = createDb(`analyst-${dbSeq++}`)
  opened.push(database)
  const clock = new FakeClock('2026-08-25T12:00:00.000Z')
  vi.doMock('@/db', async () => {
    const actual = await vi.importActual<typeof import('@/db')>('@/db')
    return { ...actual, db: () => database }
  })
  const mod = await import('@/background/analyst.handler')
  return { mod, database, clock, deps: { database, clock } }
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(async () => {
  vi.doUnmock('@/db')
  while (opened.length > 0) {
    const d = opened.pop()!
    d.close()
    await d.delete().catch(() => undefined)
  }
})

describe('mesure passive', () => {
  it('écrit une mesure quand un relevé tombe dans la fenêtre', async () => {
    const { mod, database, deps } = await setup()
    await database.actions.add(action())
    // Publié à J-8, relevé à J-7 : c'est exactement l'échéance J+1.
    await database.ownPosts.add(sighting())

    const run = await mod.runDueMeasurements(deps)
    expect(run.recorded).toBeGreaterThanOrEqual(1)

    const outcomes = await database.outcomes.toArray()
    const j1 = outcomes.find((o) => o.dayOffset === 1)
    expect(j1?.likes).toBe(12)
    expect(j1?.replies).toBe(3)
  })

  it('n’invente pas d’impressions ni d’abonnés', async () => {
    // Un zéro faux ferait baisser une moyenne ; `null` est exclu du calcul. Et un abonné
    // attribué pèse 20× dans le score d'engagement — l'estimer fabriquerait des patterns.
    const { mod, database, deps } = await setup()
    await database.actions.add(action())
    await database.ownPosts.add(sighting())
    await mod.runDueMeasurements(deps)

    const outcome = (await database.outcomes.toArray())[0]
    expect(outcome?.impressions).toBeNull()
    expect(outcome?.profileClicks).toBeNull()
    expect(outcome?.attributedFollows).toBe(0)
  })

  it('compte les mesures en attente de relevé au lieu de les perdre', async () => {
    // C'est le coût assumé de la mesure passive, et il doit être chiffré : une couverture
    // inconnue rend tout pattern inexploitable.
    const { mod, database, deps } = await setup()
    await database.actions.add(action())

    const run = await mod.runDueMeasurements(deps)
    expect(run.recorded).toBe(0)
    expect(run.awaitingSighting).toBe(run.due)
    expect(run.due).toBe(2) // J+1 et J+7
  })

  it('refuse un relevé trop tardif pour l’échéance', async () => {
    // Mesurer J+1 avec un relevé de J+6 comparerait des calendriers, pas des réponses.
    const { mod, database, deps } = await setup()
    await database.actions.add(
      action({ publishedAtMs: NOW - 8 * DAY, stagedAtMs: NOW - 8 * DAY }),
    )
    await database.ownPosts.add(sighting({ collectedAtMs: NOW - 2 * DAY }))

    const run = await mod.runDueMeasurements(deps)
    const j1 = (await database.outcomes.toArray()).filter((o) => o.dayOffset === 1)
    expect(j1).toHaveLength(0)
    expect(run.missed).toBeGreaterThanOrEqual(1)
  })

  it('refuse un relevé ANTÉRIEUR à l’échéance', async () => {
    // Sous-estimer est le même défaut que surestimer, dans l'autre sens.
    const { mod, deps } = await setup()
    const choice = mod.pickSighting([sighting({ collectedAtMs: NOW - 9 * DAY })], {
      action: action(),
      offset: 7,
      dueAtMs: NOW - DAY,
    })
    expect(choice.kind).toBe('none')
    void deps
  })

  it('choisit le relevé le plus proche de l’échéance', async () => {
    const { mod } = await setup()
    const choice = mod.pickSighting(
      [
        sighting({ collectedAtMs: NOW - 6 * DAY, likeCount: 99 }),
        sighting({ collectedAtMs: NOW - 7 * DAY, likeCount: 12 }),
      ],
      { action: action(), offset: 1, dueAtMs: NOW - 7 * DAY },
    )
    expect(choice.kind).toBe('usable')
    if (choice.kind === 'usable') expect(choice.post.likeCount).toBe(12)
  })

  it('est idempotent : deux passages n’écrivent pas deux fois', async () => {
    // L'alarme se déclenche deux fois par jour, et une échéance reste due plusieurs jours.
    const { mod, database, deps } = await setup()
    await database.actions.add(action())
    await database.ownPosts.add(sighting())

    await mod.runDueMeasurements(deps)
    const first = await database.outcomes.count()
    await mod.runDueMeasurements(deps)
    expect(await database.outcomes.count()).toBe(first)
  })

  it('ne mesure pas une action abandonnée', async () => {
    // Mesurer un post qui n'existe pas entraînerait la boucle sur du bruit (MH-09).
    const { mod, database, deps } = await setup()
    await database.actions.add(action({ outcome: 'abandoned', publishedAtMs: null }))
    await database.ownPosts.add(sighting())

    const run = await mod.runDueMeasurements(deps)
    expect(run.due).toBe(0)
    expect(await database.outcomes.count()).toBe(0)
  })
})

describe('agrégation en patterns', () => {
  it('remplace la table plutôt que de l’accumuler', async () => {
    // Un pattern dont l'échantillon a été purgé par la rétention doit disparaître, sinon il
    // continue de piloter les prompts sur des données qui n'existent plus.
    const { mod, database, deps } = await setup()
    await database.patterns.add({
      dimension: 'angle',
      value: 'fantôme',
      sampleSize: 50,
      avgEngagement: 999,
      avgAttributedFollows: 9,
      confidence: 1,
      updatedAtMs: NOW,
    })

    await mod.refreshPatterns(deps)
    const values = (await database.patterns.toArray()).map((p) => p.value)
    expect(values).not.toContain('fantôme')
  })

  it('reste silencieux sous le seuil d’échantillon', async () => {
    const { mod, database, deps } = await setup()
    await database.actions.add(action())
    await database.ownPosts.add(sighting())
    await mod.runDueMeasurements(deps)

    const refresh = await mod.refreshPatterns(deps)
    // Une seule action mesurée : aucun pattern ne doit être affirmé.
    expect(refresh.digest.insufficient).toBe(true)
    expect(refresh.digest.top).toHaveLength(0)
  })

  it('l’empreinte du digest ne bouge pas sans nouvelle donnée — DoD §5', async () => {
    // C'est la mécanique qui prouve « les prompts changent selon les performances » : sans
    // donnée nouvelle, rien ne doit changer, sinon le signal serait du bruit.
    const { mod, deps } = await setup()
    const first = await mod.refreshPatterns(deps)
    const second = await mod.refreshPatterns(deps)
    expect(second.fingerprintBefore).toBe(first.fingerprintAfter)
    expect(second.changed).toBe(false)
  })
})

describe('instantané pour l’UI', () => {
  it('chiffre la couverture de mesure', async () => {
    const { mod, database, deps } = await setup()
    await database.actions.add(action())
    await database.actions.add(
      action({ xPostId: '1789456000000000002', idempotencyKey: 'key-2' }),
    )
    await database.ownPosts.add(sighting())
    await mod.runDueMeasurements(deps)

    const snapshot = await mod.analyticsSnapshot(deps)
    expect(snapshot.published).toBe(2)
    expect(snapshot.measured).toBe(1)
    expect(snapshot.measurementCoverage).toBeCloseTo(0.5)
    // La seconde action n'a jamais été relevée : elle doit apparaître en attente.
    expect(snapshot.awaitingSighting).toBeGreaterThan(0)
  })

  it('rapporte le taux d’abandon comme un signal, pas comme un échec', async () => {
    const { mod, database, deps } = await setup()
    await database.actions.add(action())
    await database.actions.add(
      action({ outcome: 'abandoned', publishedAtMs: null, idempotencyKey: 'key-3' }),
    )
    const snapshot = await mod.analyticsSnapshot(deps)
    expect(snapshot.abandonRate.sample).toBe(2)
    expect(snapshot.abandonRate.rate).toBeCloseTo(0.5)
  })

  it('ne divise pas par zéro sur une base vide', async () => {
    const { mod, deps } = await setup()
    const snapshot = await mod.analyticsSnapshot(deps)
    expect(snapshot.measurementCoverage).toBe(0)
    expect(snapshot.costPerPublishedEur).toBe(0)
    expect(snapshot.vetoRate.sample).toBe(0)
    expect(snapshot.summary).toContain('Pas encore de signal')
  })

  it('expose le coût par réponse publiée', async () => {
    const { mod, database, deps } = await setup()
    await database.actions.add(action({ totalCostEur: 0.02 }))
    const snapshot = await mod.analyticsSnapshot(deps)
    expect(snapshot.costPerPublishedEur).toBeCloseTo(0.02)
  })
})
