import { describe, expect, it, vi } from 'vitest'
import {
  Batcher,
  DEFAULT_THROTTLE,
  SlicedQueue,
  TokenBucket,
  type Scheduler,
} from '@/content/scout/throttle'

/** Ordonnanceur contrôlé par le test : on décide quand et combien de budget. */
function fakeScheduler(budgetMs = 8): Scheduler & { run(): void; pending: number } {
  const t = 0
  const queued: ((deadline: number) => void)[] = []
  return {
    now: () => t,
    idle: (fn) => queued.push(fn),
    run(): void {
      const batch = queued.splice(0, queued.length)
      for (const fn of batch) {
        const deadline = t + budgetMs
        fn(deadline)
      }
    },
    get pending(): number {
      return queued.length
    },
  }
}

describe('TokenBucket', () => {
  it('autorise une rafale puis limite', () => {
    const bucket = TokenBucket.perMinute(120, 0)
    // Capacité = un quart du débit : assez pour une arrivée sur la timeline.
    let granted = 0
    while (bucket.tryConsume(0)) granted += 1
    expect(granted).toBe(30)
    expect(bucket.tryConsume(0)).toBe(false)
  })

  it('se recharge avec le temps', () => {
    const bucket = TokenBucket.perMinute(60, 0)
    while (bucket.tryConsume(0)) {
      /* vide le seau */
    }
    expect(bucket.tryConsume(0)).toBe(false)
    // 60/min = 1 par seconde.
    expect(bucket.tryConsume(1_000)).toBe(true)
  })

  it('ne dépasse jamais sa capacité, même après une longue absence', () => {
    // Sans plafond, une absence de deux heures donnerait un droit de collecte massif —
    // exactement le comportement de scraping que SPEC §4.1 interdit.
    const bucket = TokenBucket.perMinute(60, 0)
    expect(bucket.available(7_200_000)).toBe(15)
  })

  it('respecte le débit moyen sur la durée', () => {
    const bucket = TokenBucket.perMinute(60, 0)
    let consumed = 0
    for (let ms = 0; ms <= 60_000; ms += 100) {
      if (bucket.tryConsume(ms)) consumed += 1
    }
    // 15 de capacité initiale + ~60 rechargés sur la minute.
    expect(consumed).toBeGreaterThanOrEqual(60)
    expect(consumed).toBeLessThanOrEqual(80)
  })
})

describe('SlicedQueue', () => {
  it('traite les éléments pendant les temps morts', () => {
    const scheduler = fakeScheduler()
    const processed: number[] = []
    const queue = new SlicedQueue<number>(scheduler, (n) => processed.push(n))
    queue.push(1)
    queue.push(2)
    expect(processed).toHaveLength(0) // rien de synchrone
    scheduler.run()
    expect(processed).toEqual([1, 2])
  })

  it('se met en attente au lieu de boucler quand aucun budget n’est accordé', () => {
    // Un navigateur saturé accorde des tranches sans budget utilisable. Se replanifier
    // indéfiniment serait du gaspillage — et avec un ordonnanceur synchrone, un
    // débordement de pile.
    let t = 100
    const scheduler: Scheduler = { now: () => t, idle: (fn) => fn(0) }
    const queue = new SlicedQueue<number>(scheduler, () => {
      t += 1
    })
    expect(() => queue.push(1)).not.toThrow()
    expect(queue.pending).toBe(1)
    expect(queue.isStalled).toBe(true)
  })

  it('un nouveau push relance une file en attente', () => {
    let budget = 0
    const t = 0
    const scheduler: Scheduler = { now: () => t, idle: (fn) => fn(t + budget) }
    const processed: number[] = []
    const queue = new SlicedQueue<number>(scheduler, (n) => processed.push(n))
    queue.push(1)
    expect(queue.isStalled).toBe(true)
    budget = 100
    queue.push(2)
    expect(processed).toEqual([1, 2])
  })

  it('s’arrête au budget de la tranche, élément par élément', () => {
    // C'est la propriété qui protège le scroll de X : on n'attend pas la fin du lot pour
    // rendre la main, même si un post est anormalement coûteux à parser.
    let t = 0
    const scheduler: Scheduler = {
      now: () => t,
      idle: (fn) => fn(5), // budget de 5 unités
    }
    const processed: number[] = []
    const queue = new SlicedQueue<number>(scheduler, (n) => {
      processed.push(n)
      t += 2 // chaque élément consomme 2 unités
    })
    for (let i = 0; i < 10; i++) queue.push(i)
    // 3 éléments passent (t = 0, 2, 4 < 5), le reste attend.
    expect(processed).toHaveLength(3)
    expect(queue.pending).toBe(7)
  })

  it('reprend jusqu’à vider la file', () => {
    const scheduler = fakeScheduler(1000)
    const processed: number[] = []
    const queue = new SlicedQueue<number>(scheduler, (n) => processed.push(n))
    for (let i = 0; i < 5; i++) queue.push(i)
    scheduler.run()
    expect(processed).toHaveLength(5)
    expect(queue.pending).toBe(0)
  })

  it('jette les plus ANCIENS quand la file sature', () => {
    // Un post vu il y a trente secondes de scroll a perdu sa fraîcheur, donc son intérêt.
    const scheduler = fakeScheduler(0) // aucun budget : rien ne se traite
    const queue = new SlicedQueue<number>(scheduler, () => undefined)
    for (let i = 0; i < 250; i++) queue.push(i)
    expect(queue.pending).toBe(200)
    expect(queue.droppedCount).toBe(50)
  })

  it('un élément qui lance n’arrête pas la file', () => {
    const scheduler = fakeScheduler(1000)
    const processed: number[] = []
    const queue = new SlicedQueue<number>(scheduler, (n) => {
      if (n === 2) throw new Error('post illisible')
      processed.push(n)
    })
    for (const n of [1, 2, 3]) queue.push(n)
    scheduler.run()
    expect(processed).toEqual([1, 3])
  })

  it('se vide sur clear', () => {
    const scheduler = fakeScheduler(0)
    const queue = new SlicedQueue<number>(scheduler, () => undefined)
    queue.push(1)
    queue.clear()
    expect(queue.pending).toBe(0)
  })
})

describe('Batcher', () => {
  it('envoie quand le lot est plein', () => {
    const flushes: number[][] = []
    const batcher = new Batcher<number>({ ...DEFAULT_THROTTLE, batchSize: 3 }, (items) =>
      flushes.push([...items]),
    )
    batcher.add(1)
    batcher.add(2)
    expect(flushes).toHaveLength(0)
    batcher.add(3)
    expect(flushes).toEqual([[1, 2, 3]])
  })

  it('envoie un lot incomplet après le délai', () => {
    // Sans ça, un lot de deux posts resterait bloqué indéfiniment.
    vi.useFakeTimers()
    const flushes: number[][] = []
    const batcher = new Batcher<number>(
      { ...DEFAULT_THROTTLE, batchSize: 10, flushAfterMs: 5_000 },
      (items) => flushes.push([...items]),
    )
    batcher.add(1)
    expect(flushes).toHaveLength(0)
    vi.advanceTimersByTime(5_001)
    expect(flushes).toEqual([[1]])
    vi.useRealTimers()
  })

  it('flushNow sur un lot vide ne fait rien', () => {
    // Réveiller le service worker pour zéro post serait du gaspillage de batterie.
    const flushes: number[][] = []
    const batcher = new Batcher<number>(DEFAULT_THROTTLE, (i) => flushes.push([...i]))
    batcher.flushNow()
    expect(flushes).toHaveLength(0)
  })

  it('annule le minuteur au flush manuel', () => {
    vi.useFakeTimers()
    const flushes: number[][] = []
    const batcher = new Batcher<number>(
      { ...DEFAULT_THROTTLE, batchSize: 10, flushAfterMs: 5_000 },
      (items) => flushes.push([...items]),
    )
    batcher.add(1)
    batcher.flushNow()
    vi.advanceTimersByTime(10_000)
    // Un seul envoi : le minuteur ne doit pas produire un second lot vide.
    expect(flushes).toHaveLength(1)
    vi.useRealTimers()
  })

  it('dispose annule tout sans envoyer', () => {
    vi.useFakeTimers()
    const flushes: number[][] = []
    const batcher = new Batcher<number>(DEFAULT_THROTTLE, (i) => flushes.push([...i]))
    batcher.add(1)
    batcher.dispose()
    vi.advanceTimersByTime(60_000)
    expect(flushes).toHaveLength(0)
    vi.useRealTimers()
  })
})
