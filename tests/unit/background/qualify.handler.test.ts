/**
 * Handler de triage.
 *
 * C'est le premier chemin du produit qui dépense du budget **sans que l'utilisateur ait
 * cliqué**, donc celui où l'économie doit être la plus stricte. Ces tests protègent la chaîne
 * de filtres gratuits : sur une timeline réelle, elle doit écarter la majorité du lot pour
 * zéro euro, et chaque filtre est vérifié séparément.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createDb, type SwarmDb } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { OpportunityRepo } from '@/db/repositories/opportunity.repo'
import { FakeClock } from '@/shared/time'
import type { PostSnapshot } from '@/messaging/contract'

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
const NOW = Date.parse('2026-08-25T12:00:00.000Z')

let seq = 0
function snapshot(overrides: Partial<PostSnapshot> = {}): PostSnapshot {
  seq += 1
  return {
    postId: `178945600000000${String(seq).padStart(4, '0')}`,
    authorHandle: `author${seq}`,
    authorFollowers: null,
    text: 'the bonding curve mechanics here are genuinely worth discussing at length',
    lang: 'en',
    createdAtMs: NOW - 5 * 60_000,
    replyCount: 5,
    likeCount: 40,
    repostCount: 2,
    hasMedia: false,
    isReply: false,
    surface: 'timeline',
    observedAtMs: NOW,
    ...overrides,
  }
}

interface SetupOptions {
  consented?: boolean
  unlocked?: boolean
  ownHandle?: string | null
  /** Verdicts renvoyés par le QUALIFIER factice, par index de post. */
  relevance?: number
}

async function setup(options: SetupOptions = {}): Promise<{
  /** Handler pré-lié à l'horloge simulée : les tests n'ont pas à la repasser à chaque appel. */
  handle: (
    posts: readonly PostSnapshot[],
  ) => ReturnType<(typeof import('@/background/qualify.handler'))['handleObservedPosts']>
  mod: typeof import('@/background/qualify.handler')
  database: SwarmDb
  clock: FakeClock
  qualifyAll: ReturnType<typeof vi.fn>
}> {
  vi.resetModules()
  const database = createDb(`qh-${dbSeq++}`)
  opened.push(database)
  const clock = new FakeClock('2026-08-25T12:00:00.000Z')

  const configRepo = new ConfigRepo(database, clock)
  await configRepo.get()
  if (options.consented !== false) await configRepo.acceptConsent()
  await configRepo.update({
    activeNichePackId: 'memecoin',
    ownHandle: options.ownHandle === undefined ? 'ACMECTO' : options.ownHandle,
  })

  vi.doMock('@/db', async () => {
    const actual = await vi.importActual<typeof import('@/db')>('@/db')
    return { ...actual, db: () => database }
  })

  const qualifyAll = vi.fn(async (posts: readonly { postId: string }[]) => ({
    qualified: posts.map((post) => ({
      post,
      relevance: options.relevance ?? 0.85,
      angle: 'data',
      note: '',
      corrected: false,
    })),
    trail: [],
    totalCostEur: 0.011,
    batches: 1,
    missingVerdicts: 0,
    failedBatches: 0,
  }))
  vi.doMock('@/swarm/agents/qualifier', () => ({ qualifyAll }))

  vi.doMock('@/background/services', () => ({
    restoreKeystore: async () => ({
      restore: async () => true,
      isInitialized: async () => true,
      isUnlocked: options.unlocked !== false,
      credentials: () => ({ providerId: 'openrouter', apiKey: 'sk-or-v1-fake' }),
    }),
    buildLlmClient: async () => ({ call: vi.fn() }),
  }))

  const mod = await import('@/background/qualify.handler')
  return {
    // L'horloge simulée est injectée ici : le handler dépend du temps pour la fraîcheur,
    // l'expiration et le refroidissement d'affinité, et une horloge système rendrait ces
    // règles intestables (MH-17).
    handle: (posts) => mod.handleObservedPosts({ posts }, { clock }),
    mod,
    database,
    clock,
    qualifyAll,
  }
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(async () => {
  vi.doUnmock('@/db')
  vi.doUnmock('@/swarm/agents/qualifier')
  vi.doUnmock('@/background/services')
  while (opened.length > 0) {
    const d = opened.pop()!
    d.close()
    await d.delete().catch(() => undefined)
  }
})

describe('filtres gratuits — avant toute dépense', () => {
  it('écarte les posts déjà connus', async () => {
    // Le scout revoit les mêmes posts à chaque passage dans le viewport : sans ce filtre, le
    // triage serait repayé indéfiniment.
    const { handle, database, qualifyAll } = await setup()
    const seen = snapshot()
    await new OpportunityRepo(database, new FakeClock()).upsert({
      postId: seen.postId,
      authorHandle: seen.authorHandle,
      authorFollowers: null,
      text: seen.text,
      lang: seen.lang,
      metrics: { replies: 5, likes: 40, reposts: 2 },
      postedAtMs: seen.createdAtMs,
      observedAtMs: seen.observedAtMs,
      surface: 'timeline',
      evScore: 0.5,
      scoreBreakdown: null,
      status: 'qualified',
      rejectionReason: null,
      nichePackId: 'memecoin',
      nichePackVersion: '0.1.0',
      createdAtMs: NOW,
    })

    const result = await handle([seen])
    expect(result.filteredFree).toBe(1)
    expect(result.reasons['deja-vu']).toBe(1)
    expect(qualifyAll).not.toHaveBeenCalled()
  })

  it('écarte ses propres posts — on ne se répond pas', async () => {
    const { handle, qualifyAll } = await setup()
    const result = await handle([snapshot({ authorHandle: 'ACMECTO' })])
    expect(result.reasons['post-propre']).toBe(1)
    expect(qualifyAll).not.toHaveBeenCalled()
  })

  it('écarte un sujet interdit GRATUITEMENT (MH-02)', async () => {
    // Le filtre le plus important de la chaîne : gratuit, déterministe, et c'est un interdit
    // produit, pas une contrainte de coût.
    const { handle, qualifyAll } = await setup()
    const result = await handle([
      snapshot({ text: 'this is going 100x, guaranteed returns, ape in now' }),
    ])
    expect(result.reasons['sujet-interdit']).toBe(1)
    expect(qualifyAll).not.toHaveBeenCalled()
  })

  it('écarte un post périmé au seuil du pack', async () => {
    const { handle, qualifyAll } = await setup()
    const result = await handle([snapshot({ createdAtMs: NOW - 200 * 60_000 })])
    expect(result.reasons['perime']).toBe(1)
    expect(qualifyAll).not.toHaveBeenCalled()
  })

  it('écarte une conversation saturée', async () => {
    const { handle, qualifyAll } = await setup()
    // Le pack memecoin plafonne à 120 réponses.
    const result = await handle([snapshot({ replyCount: 300 })])
    expect(result.reasons['sature']).toBe(1)
    expect(qualifyAll).not.toHaveBeenCalled()
  })

  it('écarte un post trop court sans média', async () => {
    // Un post de trois mots n'offre aucune prise : le faire juger coûte autant qu'un post
    // riche pour un verdict certain.
    const { handle, qualifyAll } = await setup()
    const result = await handle([snapshot({ text: 'gm' })])
    expect(result.reasons['trop-court']).toBe(1)
    expect(qualifyAll).not.toHaveBeenCalled()
  })

  it('garde un post court QUI A un média', async () => {
    const { handle, qualifyAll } = await setup()
    await handle([snapshot({ text: 'ça', hasMedia: true })])
    expect(qualifyAll).toHaveBeenCalled()
  })

  it('écarte une langue non gérée, mais PAS une langue absente', async () => {
    // X omet souvent l'attribut de langue : écarter sur une absence rejetterait la moitié du
    // fil.
    const { handle, qualifyAll } = await setup()
    const result = await handle([snapshot({ lang: 'ja' }), snapshot({ lang: null })])
    expect(result.reasons['langue-non-geree']).toBe(1)
    expect(qualifyAll).toHaveBeenCalledOnce()
  })

  it('un lot entièrement filtré ne coûte RIEN', async () => {
    const { handle, qualifyAll } = await setup()
    const result = await handle([
      snapshot({ text: 'to the moon 100x' }),
      snapshot({ text: 'gm' }),
      snapshot({ createdAtMs: NOW - 300 * 60_000 }),
    ])
    expect(result.filteredFree).toBe(3)
    expect(result.sentToModel).toBe(0)
    expect(result.costEur).toBe(0)
    expect(qualifyAll).not.toHaveBeenCalled()
  })
})

describe('garde-fous d’exécution', () => {
  it('ne trie rien sans consentement (MH-12)', async () => {
    const { handle, qualifyAll } = await setup({ consented: false })
    const result = await handle([snapshot()])
    expect(result.reasons['onboarding-incomplet']).toBe(1)
    expect(qualifyAll).not.toHaveBeenCalled()
  })

  it('s’arrête si le coffre est verrouillé, sans prétendre avoir trié', async () => {
    const { handle, qualifyAll } = await setup({ unlocked: false })
    const result = await handle([snapshot()])
    expect(result.reasons['coffre-verrouille']).toBe(1)
    expect(result.queued).toBe(0)
    expect(qualifyAll).not.toHaveBeenCalled()
  })

  it('gère un lot vide sans appel', async () => {
    const { handle, qualifyAll } = await setup()
    const result = await handle([])
    expect(result.received).toBe(0)
    expect(qualifyAll).not.toHaveBeenCalled()
  })
})

describe('mise en file', () => {
  it('met en file les opportunités au-dessus du seuil', async () => {
    const { handle, database } = await setup({ relevance: 0.9 })
    const result = await handle([snapshot(), snapshot()])
    expect(result.queued).toBe(2)
    expect(result.costEur).toBeCloseTo(0.011, 6)

    const queue = await new OpportunityRepo(
      database,
      new FakeClock('2026-08-25T12:00:00.000Z'),
    ).queue()
    expect(queue).toHaveLength(2)
    expect(queue[0]?.scoreBreakdown).not.toBeNull()
  })

  it('rejette sous le seuil EV du pack, EN CONSERVANT le motif', async () => {
    // Le motif est ce qui permet de régler les seuils au lieu de deviner pourquoi la file
    // est vide.
    const { handle, database } = await setup({ relevance: 0.05 })
    const result = await handle([snapshot()])
    expect(result.rejectedByModel).toBe(1)
    expect(result.queued).toBe(0)

    const stored = await database.opportunities.toArray()
    expect(stored[0]?.status).toBe('rejected-qualifier')
    expect(stored[0]?.rejectionReason).toContain('seuil')
  })

  it('enregistre le pack et sa version — un score n’est comparable qu’à pack égal', async () => {
    const { handle, database } = await setup()
    await handle([snapshot()])
    const stored = await database.opportunities.toArray()
    expect(stored[0]?.nichePackId).toBe('memecoin')
    expect(stored[0]?.nichePackVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('la watchlist du pack remonte l’affinité', async () => {
    // Deux posts identiques, dont un d'un compte de la watchlist : le second doit scorer
    // plus haut.
    const { handle, database } = await setup()
    const packRecord = {
      id: 'memecoin',
      version: '0.1.0',
      json: JSON.stringify({
        formatVersion: 1,
        pack: {
          ...(await import('@/niches/loader')).bundledPack('memecoin')!,
          watchlist: ['author1'],
        },
      }),
      installedAtMs: NOW,
      isBundled: true,
    }
    await database.nichePacks.put(packRecord)

    seq = 0
    await handle([snapshot(), snapshot()])
    const stored = await database.opportunities.orderBy('postId').toArray()
    expect(stored).toHaveLength(2)
    const watched = stored.find((row) => row.authorHandle === 'author1')
    const other = stored.find((row) => row.authorHandle === 'author2')
    expect(watched!.evScore).toBeGreaterThan(other!.evScore)
  })
})
