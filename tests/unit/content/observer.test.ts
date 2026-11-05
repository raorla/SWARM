/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://x.com/home" }
 *
 * L'URL du document doit être sur x.com : `history.pushState` refuse un changement
 * cross-origin, et la détection de surface lit `location`.
 *
 * SCOUT — l'entrée de données de tout le produit.
 *
 * jsdom n'implémente pas `IntersectionObserver`. On le stube, ce qui a un avantage : le
 * test *contrôle* quels posts entrent dans le viewport, donc on peut vérifier la propriété
 * qui compte vraiment — qu'un post jamais vu n'est jamais lu. C'est ce qui rend la lecture
 * réellement passive (SPEC §4.1), et c'est invérifiable avec un vrai observateur.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startScout, type ScoutHandle } from '@/content/scout/observer'
import { SelectorHealth } from '@/content/dom/selector-health'
import { PROCESSED_ATTR } from '@/content/dom/x-selectors'
import type { Scheduler } from '@/content/scout/throttle'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import { FakeClock } from '@/shared/time'

const FIXTURES = join(process.cwd(), 'tests/fixtures/x-dom')
const POST_HTML = readFileSync(join(FIXTURES, 'timeline-post.html'), 'utf8')
const MEDIA_HTML = readFileSync(join(FIXTURES, 'post-with-media.html'), 'utf8')

/** Stub d'IntersectionObserver : le test décide ce qui entre dans le viewport. */
class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = []
  readonly observed = new Set<Element>()
  private readonly callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    StubIntersectionObserver.instances.push(this)
  }

  observe(el: Element): void {
    this.observed.add(el)
  }
  unobserve(el: Element): void {
    this.observed.delete(el)
  }
  disconnect(): void {
    this.observed.clear()
  }

  /** Simule l'entrée dans le viewport des éléments donnés. */
  enter(els: readonly Element[]): void {
    const entries = els
      .filter((el) => this.observed.has(el))
      .map((el) => ({ target: el, isIntersecting: true }) as IntersectionObserverEntry)
    if (entries.length > 0)
      this.callback(entries, this as unknown as IntersectionObserver)
  }

  static latest(): StubIntersectionObserver {
    const last = StubIntersectionObserver.instances.at(-1)
    if (!last) throw new Error('aucun IntersectionObserver créé')
    return last
  }

  static reset(): void {
    StubIntersectionObserver.instances = []
  }
}

/** Ordonnanceur synchrone au budget généreux : le travail se fait à l'appel. */
const eagerScheduler: Scheduler = { now: () => 0, idle: (fn) => fn(1_000_000) }

function setUrl(path: string): void {
  window.history.pushState({}, '', `https://x.com${path}`)
}

let handles: ScoutHandle[] = []

function start(
  options: {
    onBatch?: (posts: readonly ExtractedPost[]) => void
    watchlist?: readonly string[]
    maxPerMinute?: number
    batchSize?: number
  } = {},
): { handle: ScoutHandle; batches: ExtractedPost[][] } {
  const batches: ExtractedPost[][] = []
  const health = new SelectorHealth(
    new FakeClock(),
    () => undefined,
    new Set(['post.text']),
  )
  const handle = startScout({
    clock: new FakeClock('2026-08-25T12:12:00.000Z'),
    health,
    scheduler: eagerScheduler,
    throttle: {
      maxPerMinute: options.maxPerMinute ?? 1_000,
      batchSize: options.batchSize ?? 1,
      flushAfterMs: 1_000,
    },
    ...(options.watchlist ? { watchlist: options.watchlist } : {}),
    onBatch: (posts) => {
      batches.push([...posts])
      options.onBatch?.(posts)
    },
  })
  handles.push(handle)
  return { handle, batches }
}

beforeEach(() => {
  document.body.innerHTML = ''
  StubIntersectionObserver.reset()
  vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
  setUrl('/home')
})

afterEach(() => {
  for (const h of handles) h.stop()
  handles = []
  vi.unstubAllGlobals()
})

describe('SCOUT — lecture réellement passive', () => {
  it('ne lit AUCUN post qui n’est pas entré dans le viewport', () => {
    // C'est la propriété centrale de SPEC §4.1 : on lit ce que l'utilisateur voit déjà,
    // rien de plus. Un post présent dans le DOM mais jamais affiché reste non lu.
    document.body.innerHTML = POST_HTML + MEDIA_HTML
    const { handle, batches } = start()

    expect(handle.stats().observed).toBe(0)
    expect(batches).toHaveLength(0)
    // Les deux articles sont bien surveillés, mais aucun n'a été traité.
    expect(StubIntersectionObserver.latest().observed.size).toBe(2)
  })

  it('lit un post quand il entre dans le viewport', () => {
    document.body.innerHTML = POST_HTML
    const { handle, batches } = start()
    const article = document.querySelector('article')!

    StubIntersectionObserver.latest().enter([article])

    expect(handle.stats().observed).toBe(1)
    expect(handle.stats().extracted).toBe(1)
    expect(batches).toHaveLength(1)
    expect(batches[0]?.[0]?.authorHandle).toBe('aliceonchain')
  })

  it('ne lit jamais deux fois le même post', () => {
    // X recycle ses nœuds au défilement : sans déduplication, chaque post serait compté
    // plusieurs fois et fausserait le triage.
    document.body.innerHTML = POST_HTML
    const { handle } = start()
    const article = document.querySelector('article')!
    const io = StubIntersectionObserver.latest()

    io.enter([article])
    io.observe(article)
    io.enter([article])

    expect(handle.stats().observed).toBe(1)
  })

  it('marque les posts traités dans le DOM, pas seulement en mémoire', () => {
    // Un WeakSet ne survit pas au recyclage de nœuds par X ; l'attribut, si.
    document.body.innerHTML = POST_HTML
    start()
    const article = document.querySelector('article')!
    StubIntersectionObserver.latest().enter([article])
    expect(article.getAttribute(PROCESSED_ATTR)).toBe('1')
  })

  it('ignore un article déjà marqué au démarrage', () => {
    // Cas réel : réinjection du content script après une mise à jour de l'extension.
    document.body.innerHTML = POST_HTML
    document.querySelector('article')!.setAttribute(PROCESSED_ATTR, '1')
    start()
    expect(StubIntersectionObserver.latest().observed.size).toBe(0)
  })
})

describe('SCOUT — surfaces', () => {
  it('n’observe rien sur une surface interdite (SPEC §2.2)', () => {
    // Ne pas observer /messages est plus fort que filtrer ce qu'on y aurait lu.
    setUrl('/messages/1234')
    document.body.innerHTML = POST_HTML
    const { handle } = start()
    expect(handle.stats().surface).toBe('unsupported')
    expect(StubIntersectionObserver.latest().observed.size).toBe(0)
  })

  it('étiquette les posts avec la surface où ils ont été vus', () => {
    // La surface conditionne le scoring : confondre notifications et recherche fausserait
    // l'EV.
    setUrl('/notifications')
    document.body.innerHTML = POST_HTML
    const { batches } = start()
    StubIntersectionObserver.latest().enter([document.querySelector('article')!])
    expect(batches[0]?.[0]?.surface).toBe('notifications')
  })

  it('reconnaît un profil de la watchlist', () => {
    setUrl('/aliceonchain')
    document.body.innerHTML = POST_HTML
    const { batches } = start({ watchlist: ['aliceonchain'] })
    StubIntersectionObserver.latest().enter([document.querySelector('article')!])
    expect(batches[0]?.[0]?.surface).toBe('watchlist')
  })

  it('vide le lot en cours au changement de surface', () => {
    // Un lot appartient à la surface où il a été collecté : le mélanger étiqueterait des
    // posts avec la mauvaise provenance.
    document.body.innerHTML = POST_HTML
    const { handle, batches } = start({ batchSize: 50 })
    StubIntersectionObserver.latest().enter([document.querySelector('article')!])
    expect(batches).toHaveLength(0) // lot incomplet, en attente

    setUrl('/notifications')
    window.dispatchEvent(new PopStateEvent('popstate'))

    expect(batches).toHaveLength(1)
    expect(batches[0]?.[0]?.surface).toBe('timeline')
    expect(handle.stats().surface).toBe('notifications')
  })
})

describe('SCOUT — débit et robustesse', () => {
  it('limite le débit et le compte', () => {
    document.body.innerHTML = POST_HTML.repeat(20)
    const { handle } = start({ maxPerMinute: 4 })
    const articles = [...document.querySelectorAll('article')]
    StubIntersectionObserver.latest().enter(articles)

    const stats = handle.stats()
    // Capacité du seau = un quart du débit, soit 1 pour maxPerMinute = 4.
    expect(stats.extracted).toBeLessThanOrEqual(2)
    expect(stats.throttled).toBeGreaterThan(0)
    expect(stats.observed).toBe(20)
  })

  it('compte les extractions échouées sans s’arrêter', () => {
    // Un post illisible ne doit pas interrompre la lecture des suivants.
    document.body.innerHTML =
      readFileSync(join(FIXTURES, 'broken-post.html'), 'utf8') + POST_HTML
    const failures: string[] = []
    const health = new SelectorHealth(new FakeClock(), () => undefined, new Set())
    const handle = startScout({
      clock: new FakeClock('2026-08-25T12:12:00.000Z'),
      health,
      scheduler: eagerScheduler,
      throttle: { maxPerMinute: 1_000, batchSize: 1, flushAfterMs: 1_000 },
      onBatch: () => undefined,
      onExtractionFailure: (_a, reason) => failures.push(reason),
    })
    handles.push(handle)

    StubIntersectionObserver.latest().enter([...document.querySelectorAll('article')])

    expect(failures).toContain('no-permalink')
    expect(handle.stats().extracted).toBe(1)
    expect(handle.stats().failed).toBe(1)
  })

  it('regroupe les posts en lots', () => {
    document.body.innerHTML = POST_HTML + MEDIA_HTML
    const { batches } = start({ batchSize: 2 })
    StubIntersectionObserver.latest().enter([...document.querySelectorAll('article')])
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
  })

  it('flush() force l’envoi d’un lot incomplet', () => {
    document.body.innerHTML = POST_HTML
    const { handle, batches } = start({ batchSize: 50 })
    StubIntersectionObserver.latest().enter([document.querySelector('article')!])
    expect(batches).toHaveLength(0)
    handle.flush()
    expect(batches).toHaveLength(1)
  })

  it('stop() détache tout', () => {
    document.body.innerHTML = POST_HTML
    const { handle } = start()
    const io = StubIntersectionObserver.latest()
    handle.stop()
    expect(io.observed.size).toBe(0)
    // Un post qui entrerait après l'arrêt ne doit rien déclencher.
    io.enter([document.querySelector('article')!])
    expect(handle.stats().extracted).toBe(0)
  })
})
