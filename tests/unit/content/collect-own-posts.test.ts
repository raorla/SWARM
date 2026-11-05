/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://x.com/ACMECTO" }
 *
 * Collecte du corpus.
 *
 * Ce fichier teste surtout des **refus et des bornes**. Le collecteur est le seul module du
 * produit qui fait défiler une page automatiquement ; ce qui rend l'arbitrage acceptable
 * (SPEC §4.1) n'est pas une promesse mais l'ensemble des limites appliquées ici. Chacune est
 * testée séparément, parce qu'une seule borne se contourne toujours par un cas limite.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectOwnPosts, describeStopReason } from '@/content/scout/collect-own-posts'
import { noopSink } from '@/content/dom/query'
import { FakeClock } from '@/shared/time'
import { SeededRng } from '@/shared/rng'

const FIXTURES = join(process.cwd(), 'tests/fixtures/x-dom')
const POST_TEMPLATE = readFileSync(join(FIXTURES, 'timeline-post.html'), 'utf8')

/** Génère un post attribuable à @ACMECTO, identifiant unique. */
function ownPostHtml(index: number): string {
  const id = `178945600000000${String(index).padStart(4, '0')}`
  return POST_TEMPLATE.replace(/aliceonchain/g, 'ACMECTO')
    .replace(/1789456123456789012/g, id)
    .replace('Alice Onchain', 'ACME')
}

interface Harness {
  clock: FakeClock
  scrolls: number
  /** Simule X : chaque défilement ajoute des posts, jusqu'à épuisement. */
  scrollBy: (delta: number) => void
  sleep: (ms: number) => Promise<void>
}

function harness(options: { postsPerScroll: number; totalAvailable: number }): Harness {
  const clock = new FakeClock('2026-08-25T12:00:00.000Z')
  let rendered = 0
  const h: Harness = {
    clock,
    scrolls: 0,
    scrollBy: (): void => {
      h.scrolls += 1
      const toAdd = Math.min(options.postsPerScroll, options.totalAvailable - rendered)
      for (let i = 0; i < toAdd; i++) {
        document.body.insertAdjacentHTML('beforeend', ownPostHtml(rendered + i))
      }
      rendered += Math.max(0, toAdd)
    },
    // L'horloge simulée avance du délai demandé : les bornes de durée deviennent testables.
    sleep: async (ms: number): Promise<void> => {
      clock.advance(ms)
    },
  }
  return h
}

function render(count: number): void {
  document.body.innerHTML = Array.from({ length: count }, (_, i) => ownPostHtml(i)).join(
    '',
  )
}

const base = {
  rng: new SeededRng(42),
  report: noopSink,
  currentUrl: (): URL => new URL('https://x.com/ACMECTO'),
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('refus — la garde qui compte', () => {
  it('refuse sans handle configuré', async () => {
    // Sans handle, impossible de vérifier de qui est le corpus.
    const result = await collectOwnPosts({
      ...base,
      ownHandle: null,
      clock: new FakeClock(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('no-handle')
  })

  it('REFUSE de parcourir le profil de quelqu’un d’autre', async () => {
    // Le refus central : c'est ce qui empêche un bug d'UI de transformer l'outil en
    // collecteur de profils tiers.
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: new FakeClock(),
      currentUrl: () => new URL('https://x.com/aliceonchain'),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('not-own-profile')
      expect(result.error.detail).toContain('ACMECTO')
    }
  })

  it('refuse depuis une page qui n’est pas un profil', async () => {
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: new FakeClock(),
      currentUrl: () => new URL('https://x.com/home'),
    })
    expect(result.ok).toBe(false)
  })
})

describe('bornes — chacune testée séparément', () => {
  it('s’arrête au quota de posts', async () => {
    const h = harness({ postsPerScroll: 5, totalAvailable: 500 })
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: h.scrollBy,
      sleep: h.sleep,
      limits: { maxPosts: 12 },
    })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.posts).toHaveLength(12)
    expect(result.value.stopReason).toBe('quota-atteint')
  })

  it('s’arrête à la limite de défilements', async () => {
    // Borne indépendante du quota : un profil qui charge lentement ne doit pas faire
    // défiler indéfiniment.
    const h = harness({ postsPerScroll: 1, totalAvailable: 1000 })
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: h.scrollBy,
      sleep: h.sleep,
      limits: { maxPosts: 500, maxScrolls: 4, maxDurationMs: 10 * 60_000 },
    })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.stopReason).toBe('limite-de-defilements')
    expect(result.value.scrolls).toBe(4)
  })

  it('s’arrête à la limite de durée', async () => {
    const h = harness({ postsPerScroll: 1, totalAvailable: 1000 })
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: h.scrollBy,
      sleep: h.sleep,
      limits: { maxPosts: 500, maxScrolls: 500, maxDurationMs: 3_000 },
    })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.stopReason).toBe('limite-de-duree')
  })

  it('détecte la fin du profil par absence de nouveauté', async () => {
    // X n'expose aucun marqueur de fin de liste : l'absence de nouveaux posts est le seul
    // signal disponible.
    const h = harness({ postsPerScroll: 3, totalAvailable: 6 })
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: h.scrollBy,
      sleep: h.sleep,
      limits: { maxPosts: 500, emptyScrollsBeforeStop: 2 },
    })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.stopReason).toBe('fin-du-profil')
    expect(result.value.posts).toHaveLength(6)
  })
})

describe('interruption et navigation', () => {
  it('s’arrête sur abort', async () => {
    const h = harness({ postsPerScroll: 2, totalAvailable: 1000 })
    const controller = new AbortController()
    let scrollCount = 0
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: (d) => {
        scrollCount += 1
        if (scrollCount === 3) controller.abort()
        h.scrollBy(d)
      },
      sleep: h.sleep,
      signal: controller.signal,
      limits: { maxPosts: 500 },
    })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.stopReason).toBe('interrompu')
  })

  it('s’arrête si l’utilisateur quitte son profil EN COURS de collecte', async () => {
    // Vérifié à chaque tour et non seulement à l'entrée : une navigation en cours de route
    // doit arrêter net.
    const h = harness({ postsPerScroll: 2, totalAvailable: 1000 })
    let path = '/ACMECTO'
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: (d) => {
        h.scrollBy(d)
        if (h.scrolls === 2) path = '/aliceonchain'
      },
      sleep: h.sleep,
      currentUrl: () => new URL(`https://x.com${path}`),
      limits: { maxPosts: 500 },
    })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.stopReason).toBe('navigation')
  })
})

describe('contenu collecté', () => {
  it('ne garde que ses propres posts', async () => {
    // Un profil affiche aussi les reposts d'autrui : les inclure polluerait le Voice Profile
    // avec le style de quelqu'un d'autre.
    render(0)
    document.body.innerHTML =
      ownPostHtml(1) + POST_TEMPLATE /* celui-ci est de @aliceonchain */
    const h = harness({ postsPerScroll: 0, totalAvailable: 0 })
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: h.scrollBy,
      sleep: h.sleep,
      limits: { emptyScrollsBeforeStop: 1 },
    })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.posts).toHaveLength(1)
    expect(result.value.posts[0]?.authorHandle).toBe('ACMECTO')
  })

  it('déduplique les posts revus au défilement', async () => {
    // X recycle ses nœuds : sans déduplication, le corpus compterait plusieurs fois le même
    // post et biaiserait toutes les statistiques.
    render(3)
    const h = harness({ postsPerScroll: 0, totalAvailable: 0 })
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: h.scrollBy,
      sleep: h.sleep,
      limits: { emptyScrollsBeforeStop: 1 },
    })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.posts).toHaveLength(3)
    expect(new Set(result.value.posts.map((p) => p.postId)).size).toBe(3)
  })

  it('récolte ce qui est déjà à l’écran avant tout défilement', async () => {
    // Ce qui est visible est déjà visible : le défiler d'abord serait absurde.
    render(4)
    const h = harness({ postsPerScroll: 0, totalAvailable: 0 })
    const progress: number[] = []
    const result = await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: h.scrollBy,
      sleep: h.sleep,
      onProgress: (p) => progress.push(p.collected),
      limits: { emptyScrollsBeforeStop: 1 },
    })
    if (!result.ok) throw new Error('attendu: ok')
    expect(progress[0]).toBe(4)
  })

  it('émet une progression à chaque étape', async () => {
    // Une collecte silencieuse serait indistinguable d'un scraper (SPEC §4.1).
    const h = harness({ postsPerScroll: 2, totalAvailable: 8 })
    const progress: number[] = []
    await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: h.scrollBy,
      sleep: h.sleep,
      onProgress: (p) => progress.push(p.collected),
      limits: { maxPosts: 500, emptyScrollsBeforeStop: 2 },
    })
    expect(progress.length).toBeGreaterThan(3)
    // Monotone croissante : un compteur qui redescend signalerait une déduplication cassée.
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!)
    }
  })

  it('espace les défilements avec une cadence bornée', async () => {
    // Même mécanique log-normale que le governor : jamais deux délais identiques, jamais de
    // martèlement.
    const h = harness({ postsPerScroll: 2, totalAvailable: 20 })
    const delays: number[] = []
    await collectOwnPosts({
      ...base,
      ownHandle: 'ACMECTO',
      clock: h.clock,
      scrollBy: h.scrollBy,
      sleep: async (ms) => {
        delays.push(ms)
        h.clock.advance(ms)
      },
      limits: { maxPosts: 500, scrollDelayMs: { min: 700, max: 2_200 } },
    })
    expect(delays.length).toBeGreaterThan(2)
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(700)
      expect(d).toBeLessThanOrEqual(2_200)
    }
    expect(new Set(delays).size).toBeGreaterThan(1)
  })
})

describe('describeStopReason', () => {
  it('explique chaque raison en langue naturelle', () => {
    const reasons = [
      'quota-atteint',
      'fin-du-profil',
      'limite-de-defilements',
      'limite-de-duree',
      'interrompu',
      'navigation',
    ] as const
    for (const reason of reasons) {
      const text = describeStopReason(reason, 42)
      expect(text, reason).toContain('42')
      expect(text.length, reason).toBeGreaterThan(20)
    }
  })
  void vi
})
