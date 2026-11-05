/**
 * File d'opportunités.
 *
 * Deux propriétés portent la qualité de l'écran Flux :
 *
 *  1. **La file se vide.** Une file qui ne se purge pas devient un cimetière, et voir des
 *     posts de la veille en tête est pire que voir une file vide.
 *  2. **Un état terminal est définitif.** Sans ça, un post rejeté serait requalifié au
 *     prochain passage dans le viewport, repayé, et rejeté à nouveau — une boucle qui
 *     consomme du budget indéfiniment sans rien produire.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createDb, type SwarmDb } from '@/db'
import {
  OpportunityRepo,
  TERMINAL_STATUSES,
  toStoredBreakdown,
} from '@/db/repositories/opportunity.repo'
import { computeEv } from '@/scoring/ev'
import { NEUTRAL_WEIGHTS } from '@/scoring/weights'
import type { Opportunity, OpportunityStatus } from '@/db/schema'
import { FakeClock } from '@/shared/time'

/**
 * Compteur monotone de bases de test.
 *
 * `opened.length` ne convient PAS : le tableau est vidé après chaque test, donc tous les
 * tests rouvriraient la même base — et `fake-indexeddb` fait alors courir la suppression de
 * l'une avec l'ouverture de la suivante. Les échecs qui en résultent sont intermittents et
 * ne ressemblent pas à leur cause.
 */
let dbSeq = 0

const opened: SwarmDb[] = []
function freshDb(name: string): SwarmDb {
  const d = createDb(`${name}-${dbSeq++}`)
  opened.push(d)
  return d
}
afterEach(async () => {
  while (opened.length > 0) {
    const d = opened.pop()!
    d.close()
    await d.delete().catch(() => undefined)
  }
})

const clock = new FakeClock('2026-08-25T12:00:00.000Z')
let seq = 0

function opportunity(overrides: Partial<Opportunity> = {}): Omit<Opportunity, 'id'> {
  seq += 1
  return {
    postId: `178945600000000${String(seq).padStart(4, '0')}`,
    authorHandle: `author${seq}`,
    authorFollowers: null,
    text: `un post de test numéro ${seq}`,
    lang: 'en',
    metrics: { replies: 5, likes: 40, reposts: 2 },
    postedAtMs: clock.now() - 5 * 60_000,
    observedAtMs: clock.now(),
    surface: 'timeline',
    evScore: 0.5,
    scoreBreakdown: null,
    status: 'qualified',
    rejectionReason: null,
    nichePackId: 'memecoin',
    nichePackVersion: '0.1.0',
    createdAtMs: clock.now(),
    ...overrides,
  }
}

describe('insertion et rafraîchissement', () => {
  it('insère une opportunité', async () => {
    const repo = new OpportunityRepo(freshDb('opp-insert'), clock)
    const result = await repo.upsert(opportunity())
    expect(result.ok).toBe(true)
  })

  it('rafraîchit le score d’un post revu', async () => {
    // Le scout revoit les mêmes posts au fil du scroll, et leurs métriques ont changé : un
    // post qui a pris 40 réponses depuis n'est plus la même opportunité.
    const repo = new OpportunityRepo(freshDb('opp-refresh'), clock)
    const base = opportunity({ evScore: 0.5 })
    await repo.upsert(base)
    await repo.upsert({
      ...base,
      evScore: 0.2,
      metrics: { replies: 45, likes: 40, reposts: 2 },
    })

    const stored = await repo.byPostId(base.postId)
    expect(stored?.evScore).toBe(0.2)
    expect(stored?.metrics.replies).toBe(45)
  })

  it('REFUSE de remettre en file une opportunité déjà traitée', async () => {
    // Sans ça, un post rejeté serait requalifié, repayé et rejeté à nouveau — une boucle qui
    // consomme du budget sans rien produire.
    for (const status of TERMINAL_STATUSES) {
      const repo = new OpportunityRepo(freshDb(`opp-terminal-${status}`), clock)
      const base = opportunity({ status })
      await repo.upsert(base)
      const second = await repo.upsert({ ...base, status: 'qualified' })
      expect(second.ok, status).toBe(false)
      if (!second.ok) expect(second.error.kind).toBe('duplicate')
    }
  })

  it('upsertMany compte les insérés et les ignorés', async () => {
    const repo = new OpportunityRepo(freshDb('opp-many'), clock)
    const rejected = opportunity({ status: 'rejected-critic' })
    await repo.upsert(rejected)
    const result = await repo.upsertMany([opportunity(), opportunity(), { ...rejected }])
    expect(result.inserted).toBe(2)
    expect(result.skipped).toBe(1)
  })
})

describe('file de travail', () => {
  it('trie par EV décroissant', async () => {
    const repo = new OpportunityRepo(freshDb('opp-sort'), clock)
    await repo.upsertMany([
      opportunity({ evScore: 0.3 }),
      opportunity({ evScore: 0.9 }),
      opportunity({ evScore: 0.6 }),
    ])
    const queue = await repo.queue()
    expect(queue.map((row) => row.evScore)).toEqual([0.9, 0.6, 0.3])
  })

  it('n’inclut que les statuts actifs', async () => {
    const repo = new OpportunityRepo(freshDb('opp-status'), clock)
    await repo.upsertMany([
      opportunity({ status: 'qualified' }),
      opportunity({ status: 'drafted' }),
      opportunity({ status: 'rejected-critic' }),
      opportunity({ status: 'published' }),
      opportunity({ status: 'expired' }),
    ])
    const queue = await repo.queue()
    expect(queue).toHaveLength(2)
  })

  it('EXCLUT les périmées à la lecture, sans attendre la purge', async () => {
    // La purge tourne sur alarme, la lecture est immédiate. Sans ce double filtre,
    // l'utilisateur qui ouvre le Flux juste avant une purge verrait des posts morts en tête.
    const repo = new OpportunityRepo(freshDb('opp-expire-read'), clock)
    await repo.upsertMany([
      opportunity({ evScore: 0.9, postedAtMs: clock.now() - 200 * 60_000 }),
      opportunity({ evScore: 0.4, postedAtMs: clock.now() - 5 * 60_000 }),
    ])
    const queue = await repo.queue(50, 45)
    expect(queue).toHaveLength(1)
    expect(queue[0]?.evScore).toBe(0.4)
  })

  it('respecte la limite demandée', async () => {
    const repo = new OpportunityRepo(freshDb('opp-limit'), clock)
    await repo.upsertMany(Array.from({ length: 10 }, () => opportunity()))
    expect(await repo.queue(3)).toHaveLength(3)
  })

  it('next() renvoie la tête de file', async () => {
    const repo = new OpportunityRepo(freshDb('opp-next'), clock)
    await repo.upsertMany([opportunity({ evScore: 0.2 }), opportunity({ evScore: 0.8 })])
    expect((await repo.next())?.evScore).toBe(0.8)
  })

  it('next() renvoie null sur une file vide', async () => {
    expect(await new OpportunityRepo(freshDb('opp-empty'), clock).next()).toBeNull()
  })
})

describe('expiration', () => {
  it('marque expirées les opportunités trop vieilles, sans les supprimer', async () => {
    // Le motif d'expiration est une donnée d'analyse : un taux élevé signifie que
    // l'utilisateur ne suit pas le rythme de sa file, ce qui est un réglage à revoir.
    const repo = new OpportunityRepo(freshDb('opp-expire'), clock)
    await repo.upsertMany([
      opportunity({ postedAtMs: clock.now() - 200 * 60_000 }),
      opportunity({ postedAtMs: clock.now() - 3 * 60_000 }),
    ])
    const { expired } = await repo.expireStale(45)
    expect(expired).toBe(1)

    const stats = await repo.stats(45)
    expect(stats.byStatus['expired']).toBe(1)
    expect(stats.total).toBe(2)
  })

  it('est idempotente', async () => {
    const repo = new OpportunityRepo(freshDb('opp-expire-idem'), clock)
    await repo.upsert(opportunity({ postedAtMs: clock.now() - 200 * 60_000 }))
    await repo.expireStale(45)
    expect((await repo.expireStale(45)).expired).toBe(0)
  })
})

describe('statistiques', () => {
  it('distingue les causes d’une file vide', async () => {
    // Quatre causes très différentes : les confondre ferait chercher un bug là où il y a un
    // réglage.
    const repo = new OpportunityRepo(freshDb('opp-stats'), clock)
    await repo.upsertMany([
      opportunity({ status: 'rejected-qualifier' }),
      opportunity({ status: 'rejected-qualifier' }),
      opportunity({ status: 'rejected-critic' }),
      opportunity({ status: 'expired' }),
    ])
    const stats = await repo.stats()
    expect(stats.queued).toBe(0)
    expect(stats.qualifierRejectedRate).toBe(0.5)
    expect(stats.criticRejectedRate).toBe(0.25)
    expect(stats.expiredRate).toBe(0.25)
  })

  it('calcule EV moyen et maximum sur la file vivante', async () => {
    const repo = new OpportunityRepo(freshDb('opp-stats-ev'), clock)
    await repo.upsertMany([opportunity({ evScore: 0.4 }), opportunity({ evScore: 0.8 })])
    const stats = await repo.stats()
    expect(stats.avgEv).toBeCloseTo(0.6, 6)
    expect(stats.topEv).toBe(0.8)
  })

  it('gère une base vide sans NaN', async () => {
    const stats = await new OpportunityRepo(freshDb('opp-stats-empty'), clock).stats()
    for (const value of [stats.avgEv, stats.topEv, stats.expiredRate]) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})

describe('déduplication avant triage', () => {
  it('knownPostIds évite de repayer un triage déjà fait', async () => {
    // Le scout revoit les mêmes posts à chaque passage dans le viewport : sans ce filtre, le
    // triage serait repayé indéfiniment.
    const repo = new OpportunityRepo(freshDb('opp-known'), clock)
    const a = opportunity()
    const b = opportunity()
    await repo.upsertMany([a, b])

    const known = await repo.knownPostIds([a.postId, b.postId, '1789456999999999999'])
    expect(known.has(a.postId)).toBe(true)
    expect(known.has('1789456999999999999')).toBe(false)
    expect(known.size).toBe(2)
  })

  it('isKnown répond sur un seul identifiant', async () => {
    const repo = new OpportunityRepo(freshDb('opp-isknown'), clock)
    const a = opportunity()
    await repo.upsert(a)
    expect(await repo.isKnown(a.postId)).toBe(true)
    expect(await repo.isKnown('1789456999999999999')).toBe(false)
  })
})

describe('toStoredBreakdown', () => {
  it('conserve les cinq facteurs et le score', () => {
    const breakdown = computeEv(
      {
        reach: 0.6,
        nicheRelevance: 0.7,
        freshness: 0.8,
        saturationInverse: 0.5,
        authorAffinity: 0.4,
      },
      NEUTRAL_WEIGHTS,
    )
    const stored = toStoredBreakdown(breakdown)
    expect(stored.reach).toBe(0.6)
    expect(stored.saturation).toBe(0.5)
    expect(stored.ev).toBe(breakdown.ev)
  })
})

describe('changement de statut', () => {
  it('enregistre le motif avec le statut', async () => {
    const repo = new OpportunityRepo(freshDb('opp-setstatus'), clock)
    const result = await repo.upsert(opportunity())
    if (!result.ok) throw new Error('insertion échouée')

    await repo.setStatus(result.value, 'rejected-critic', 'répète ton post du 12')
    const stored = await repo.get(result.value)
    expect(stored?.status).toBe('rejected-critic')
    expect(stored?.rejectionReason).toContain('post du 12')
  })

  it('un statut terminal sort l’opportunité de la file', async () => {
    const repo = new OpportunityRepo(freshDb('opp-terminal-queue'), clock)
    const result = await repo.upsert(opportunity())
    if (!result.ok) throw new Error('insertion échouée')
    expect(await repo.queue()).toHaveLength(1)

    await repo.setStatus(result.value, 'rejected-critic' as OpportunityStatus, 'motif')
    expect(await repo.queue()).toHaveLength(0)
  })
})
