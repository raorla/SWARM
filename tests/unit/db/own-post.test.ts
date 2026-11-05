/**
 * Corpus des posts de l'utilisateur.
 *
 * La qualification par le garde-fou est calculée **à l'écriture**, pas à la lecture : le
 * Voice Profile la lira des dizaines de fois, et le classifieur — même gratuit — n'a pas à
 * tourner en boucle (MH-18).
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createDb, type SwarmDb } from '@/db'
import { OwnPostRepo, type OwnPostInput } from '@/db/repositories/own-post.repo'
import { bundledPack } from '@/niches/loader'
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
const pack = bundledPack('memecoin')!

let seq = 0
function input(text: string, overrides: Partial<OwnPostInput> = {}): OwnPostInput {
  seq += 1
  return {
    postId: `1789456000000${String(seq).padStart(6, '0')}`,
    text,
    lang: 'en',
    postedAtMs: clock.now() - seq * 3_600_000,
    likeCount: 10,
    replyCount: 2,
    repostCount: 1,
    hasMedia: false,
    isReply: false,
    ...overrides,
  }
}

describe('OwnPostRepo', () => {
  it('qualifie à l’écriture et non à la lecture', async () => {
    const repo = new OwnPostRepo(freshDb('own-qualify'), clock)
    await repo.upsert(
      input('locked liquidity is table stakes'),
      pack.additionalBlockedTopics,
    )
    await repo.upsert(
      input('this is going 100x guaranteed'),
      pack.additionalBlockedTopics,
    )

    const all = await repo.all()
    expect(all.find((p) => p.text.includes('100x'))?.passesGuard).toBe(false)
    expect(all.find((p) => p.text.includes('liquidity'))?.passesGuard).toBe(true)
  })

  it('conserve les catégories déclenchées, pour le diagnostic', async () => {
    const repo = new OwnPostRepo(freshDb('own-cats'), clock)
    await repo.upsert(input('price target $4, guaranteed returns'), [])
    const post = (await repo.all())[0]
    expect(post?.guardCategories).toContain('financial-advice')
  })

  it('rafraîchit un post recollecté au lieu d’échouer', async () => {
    // Un corpus qu'on ne peut pas re-collecter serait figé au premier passage.
    const repo = new OwnPostRepo(freshDb('own-upsert'), clock)
    const base = input('un post stable')
    await repo.upsert(base)
    await repo.upsert({ ...base, likeCount: 999 })
    expect(await repo.count()).toBe(1)
    expect((await repo.all())[0]?.likeCount).toBe(999)
  })

  it('sépare le corpus entier du corpus assaini (MH-18)', async () => {
    const repo = new OwnPostRepo(freshDb('own-split'), clock)
    await repo.upsertMany(
      [
        input('locked liquidity note one'),
        input('locked liquidity note two'),
        input('100x incoming, maximum potential'),
      ],
      pack.additionalBlockedTopics,
    )
    // La forme se calcule sur tout, le registre seulement sur ce qui passe.
    expect(await repo.count()).toBe(3)
    expect(await repo.passingGuard()).toHaveLength(2)
  })

  it('expose des statistiques de corpus exploitables', async () => {
    const repo = new OwnPostRepo(freshDb('own-stats'), clock)
    await repo.upsertMany([
      input('note propre une'),
      input('note propre deux'),
      input('to the moon soon'),
    ])
    const stats = await repo.stats()
    expect(stats.total).toBe(3)
    expect(stats.passingGuard).toBe(2)
    expect(stats.excludedRatio).toBeCloseTo(1 / 3, 3)
    expect(stats.newestPostedAtMs).toBeGreaterThan(stats.oldestPostedAtMs!)
  })

  it('gère un corpus vide sans NaN', async () => {
    const stats = await new OwnPostRepo(freshDb('own-empty'), clock).stats()
    expect(stats.total).toBe(0)
    expect(stats.excludedRatio).toBe(0)
    expect(stats.oldestPostedAtMs).toBeNull()
  })

  it('requalifie tout le corpus quand les règles changent', async () => {
    // Sans ça, `passesGuard` refléterait des règles qui n'existent plus, et le Voice Profile
    // s'appuierait sur une qualification périmée.
    const repo = new OwnPostRepo(freshDb('own-requalify'), clock)
    await repo.upsertMany([input('parlons de tokenomics tranquillement')], [])
    expect(await repo.passingGuard()).toHaveLength(1)

    const { changed } = await repo.requalify(['tokenomics'])
    expect(changed).toBe(1)
    expect(await repo.passingGuard()).toHaveLength(0)
  })

  it('trie du plus récent au plus ancien', async () => {
    const repo = new OwnPostRepo(freshDb('own-order'), clock)
    await repo.upsertMany([input('ancien'), input('recent')])
    const all = await repo.all()
    expect(all[0]!.postedAtMs).toBeGreaterThan(all[1]!.postedAtMs)
  })
})
