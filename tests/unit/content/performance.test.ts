/**
 * @vitest-environment jsdom
 *
 * SPEC §8 : « le content script ne doit pas dégrader le scroll de X ».
 *
 * ## Pourquoi aucun seuil en millisecondes ici
 *
 * Un seuil absolu dépend de la machine, de la charge, et surtout de l'instrumentation : sous
 * `--coverage`, V8 ralentit l'exécution de trois à cinq fois. Un test qui passe seul et
 * échoue sous la suite complète est un test qu'on finit par désactiver — c'est-à-dire pire
 * qu'aucun test. C'est arrivé deux fois sur ce fichier avant qu'il prenne cette forme.
 *
 * On mesure donc deux choses **insensibles à l'environnement** :
 *
 *  1. **La linéarité du coût de parsing.** Le ralentissement d'instrumentation s'applique aux
 *     deux côtés d'un rapport, donc il s'annule. Et c'est le vrai risque : le mode de
 *     défaillance qu'on craint n'est pas « trois millisecondes de trop », c'est un
 *     comportement quadratique — un sélecteur qui réinterrogerait tout le document par article.
 *  2. **L'invariant de l'ordonnanceur**, avec un coût par élément simulé. C'est lui qui
 *     protège réellement le scroll : une tranche rend la main au budget, pas à la fin du lot.
 *
 * Les valeurs absolues sont mesurées là où elles ont un sens : dans un vrai navigateur, par
 * `tests/e2e/local/overlay.spec.ts`, qui relève la latence réelle du fil principal pendant un
 * défilement.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractPost } from '@/content/scout/extract-post'
import { noopSink } from '@/content/dom/query'
import { SlicedQueue, type Scheduler } from '@/content/scout/throttle'
import { FakeClock } from '@/shared/time'

const FIXTURES = join(process.cwd(), 'tests/fixtures/x-dom')
const TIMELINE_POST = readFileSync(join(FIXTURES, 'timeline-post.html'), 'utf8')

/** Budget d'une tranche : la moitié d'une frame à 60 Hz. */
const SLICE_BUDGET_MS = 8

const opts = {
  surface: 'timeline' as const,
  clock: new FakeClock('2026-08-25T12:12:00.000Z'),
  report: noopSink,
  ownHandle: null,
}

function buildTimeline(count: number): Element[] {
  document.body.innerHTML = TIMELINE_POST.repeat(count)
  return [...document.body.querySelectorAll('article')]
}

/** Médiane de cinq passes, après chauffe. La médiane absorbe un pic de ramasse-miettes. */
function medianCostOf(articleCount: number): number {
  const articles = buildTimeline(articleCount)
  // Chauffe obligatoire : la première extraction paie la compilation des expressions
  // régulières, soit un ordre de grandeur de plus que le régime stationnaire.
  for (const article of articles) extractPost(article, opts)

  const samples: number[] = []
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    for (const article of articles) extractPost(article, opts)
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]!
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('coût du parsing — mesuré en relatif', () => {
  it('le coût croît linéairement avec le nombre de posts', () => {
    // 40 posts d'affilée est le pire cas réaliste d'un scroll appuyé. Un coût quadratique
    // rendrait le scroll injouable au bout d'un écran.
    const one = medianCostOf(1)
    const forty = medianCostOf(40)

    // Un comportement linéaire donne ~40. On tolère largement pour absorber les frais fixes
    // et le bruit de mesure ; un comportement quadratique donnerait ~1 600.
    const ratio = forty / Math.max(one, 0.001)
    expect(ratio, `ratio observé ${ratio.toFixed(1)}× pour 40× le volume`).toBeLessThan(200)
  })

  it('un DOM dégradé ne coûte pas plus cher qu’un DOM sain', () => {
    // Sinon le jour où X change sa structure, le produit dégraderait le scroll **en plus** de
    // ne plus rien lire — deux pannes pour le prix d'une.
    const timeIt = (fn: () => void): number => {
      for (let i = 0; i < 10; i++) fn()
      const samples: number[] = []
      for (let run = 0; run < 5; run++) {
        const start = performance.now()
        for (let i = 0; i < 20; i++) fn()
        samples.push(performance.now() - start)
      }
      samples.sort((a, b) => a - b)
      return samples[2]!
    }

    document.body.innerHTML = readFileSync(join(FIXTURES, 'broken-post.html'), 'utf8')
    const broken = document.body.querySelector('article')!
    const brokenCost = timeIt(() => extractPost(broken, opts))

    const [healthy] = buildTimeline(1)
    const healthyCost = timeIt(() => extractPost(healthy!, opts))

    expect(brokenCost).toBeLessThan(Math.max(healthyCost, 0.001) * 5)
  })
})

describe('ordonnanceur — invariants déterministes', () => {
  /**
   * Le coût par élément est **simulé**, pas mesuré.
   *
   * Ce qu'on teste ici n'est pas la vitesse du parsing mais le comportement de
   * l'ordonnanceur, et il doit être vérifiable exactement : la borne « budget plus un
   * élément » est une propriété du code, pas une statistique.
   */
  const COST_PER_ITEM_MS = 3

  function simulatedScheduler(): { scheduler: Scheduler; now: () => number; advance: (ms: number) => void } {
    let simulatedNow = 0
    return {
      scheduler: {
        now: () => simulatedNow,
        idle: (fn) => fn(simulatedNow + SLICE_BUDGET_MS),
      },
      now: () => simulatedNow,
      advance: (ms) => {
        simulatedNow += ms
      },
    }
  }

  it('une tranche ne dépasse jamais son budget de plus d’un élément', () => {
    const { scheduler, now, advance } = simulatedScheduler()
    let maxSliceMs = 0
    let sliceStart = 0
    let inSlice = false
    let processed = 0

    const queue = new SlicedQueue<number>(scheduler, () => {
      if (!inSlice) {
        inSlice = true
        sliceStart = now()
      }
      processed += 1
      advance(COST_PER_ITEM_MS)
      maxSliceMs = Math.max(maxSliceMs, now() - sliceStart)
    })

    for (let i = 0; i < 60; i++) {
      inSlice = false
      queue.push(i)
    }

    // On ne coupe pas un traitement en cours, donc un élément de dépassement est admis.
    // Jamais plus : c'est la borne exacte.
    expect(maxSliceMs).toBeLessThanOrEqual(SLICE_BUDGET_MS + COST_PER_ITEM_MS)
    expect(processed).toBe(60)
  })

  it('borner la tranche ne perd aucun élément', () => {
    const { scheduler, advance } = simulatedScheduler()
    const processed: number[] = []
    const queue = new SlicedQueue<number>(scheduler, (n) => {
      processed.push(n)
      advance(COST_PER_ITEM_MS)
    })
    for (let i = 0; i < 40; i++) queue.push(i)
    expect(processed).toHaveLength(40)
    expect(queue.pending).toBe(0)
  })

  it('n’accumule aucune structure proportionnelle au nombre de posts vus', () => {
    // Une fuite ici se manifesterait après une heure de scroll, pas en test fonctionnel. Le
    // scout utilise un WeakSet et un attribut DOM, précisément pour ça.
    const articles = buildTimeline(50)
    const scheduler: Scheduler = { now: () => 0, idle: (fn) => fn(1_000_000) }
    const queue = new SlicedQueue<Element>(scheduler, () => undefined)
    for (const article of articles) queue.push(article)
    expect(queue.pending).toBe(0)
    expect(queue.droppedCount).toBe(0)
  })
})
