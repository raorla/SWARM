/**
 * SCOUT — observation passive de ce que l'utilisateur voit déjà.
 *
 * Trois observateurs, chacun pour une raison distincte :
 *
 *  - `MutationObserver` : X remplace le contenu du fil en continu (virtualisation). Sans
 *    lui, on ne verrait que les posts présents au chargement.
 *  - `IntersectionObserver` : on n'extrait que ce qui **entre dans le viewport**. C'est ce
 *    qui rend la lecture réellement passive : un post que l'utilisateur n'a jamais vu
 *    n'est jamais lu. C'est aussi la principale économie de CPU.
 *  - Observation de l'URL : X est une SPA, la navigation ne recharge pas la page. Sans ça,
 *    on continuerait d'attribuer les posts à la surface précédente.
 *
 * Le travail est mis en file et découpé (`throttle.ts`) : rien n'est parsé dans le
 * callback d'observation, qui doit rendre la main immédiatement.
 */
import { POST_CONTAINER, PROCESSED_ATTR } from '../dom/x-selectors'
import { queryAll } from '../dom/query'
import type { SelectorHealth } from '../dom/selector-health'
import { extractPost } from './extract-post'
import {
  detectSurface,
  isObservable,
  type Surface,
  type SurfaceContext,
} from './feed-router'
import {
  Batcher,
  DEFAULT_THROTTLE,
  SlicedQueue,
  TokenBucket,
  browserScheduler,
  type Scheduler,
  type ThrottleConfig,
} from './throttle'
import type { ExtractedPost } from '../dom/dom-schemas'
import { createLogger } from '@/shared/logger'
import type { Clock } from '@/shared/time'

const log = createLogger('content:scout')

export interface ScoutOptions {
  clock: Clock
  health: SelectorHealth
  scheduler?: Scheduler
  throttle?: ThrottleConfig
  watchlist?: readonly string[]
  ownHandle?: string | null
  /** Appelé par lots. C'est le seul canal de sortie du scout. */
  onBatch: (posts: readonly ExtractedPost[]) => void
  /** Signalé quand un post ne s'extrait pas, pour le diagnostic. */
  onExtractionFailure?: (article: Element, reason: string) => void
}

export interface ScoutHandle {
  stop(): void
  stats(): ScoutStats
  /** Force l'envoi du lot courant. Utile aux tests et au changement de page. */
  flush(): void
}

export interface ScoutStats {
  observed: number
  extracted: number
  failed: number
  throttled: number
  droppedFromQueue: number
  surface: Surface | 'unsupported'
}

export function startScout(options: ScoutOptions): ScoutHandle {
  const scheduler = options.scheduler ?? browserScheduler()
  const throttleConfig = options.throttle ?? DEFAULT_THROTTLE
  const watchlist = options.watchlist ?? []

  let surfaceCtx: SurfaceContext = detectSurface(new URL(location.href), watchlist)
  let lastPath = location.pathname + location.search

  const stats: ScoutStats = {
    observed: 0,
    extracted: 0,
    failed: 0,
    throttled: 0,
    droppedFromQueue: 0,
    surface: surfaceCtx.surface,
  }

  const bucket = TokenBucket.perMinute(throttleConfig.maxPerMinute, scheduler.now())

  const batcher = new Batcher<ExtractedPost>(throttleConfig, (items) => {
    options.onBatch(items)
  })

  const queue = new SlicedQueue<Element>(scheduler, (article) => {
    if (!isObservable(surfaceCtx)) return

    if (!bucket.tryConsume(scheduler.now())) {
      stats.throttled += 1
      // On ne remet pas en file : le post sera revu au prochain passage dans le viewport
      // si l'utilisateur y revient. Réinsérer créerait une file qui ne se vide jamais.
      return
    }

    const result = extractPost(article, {
      surface: surfaceCtx.surface,
      clock: options.clock,
      report: options.health.sink,
      ownHandle: options.ownHandle ?? null,
    })

    if (!result.ok) {
      stats.failed += 1
      options.onExtractionFailure?.(article, result.error.kind)
      return
    }
    stats.extracted += 1
    batcher.add(result.value)
  })

  /* ── IntersectionObserver : seuls les posts réellement vus sont traités ──── */

  const seen = new WeakSet<Element>()

  const intersection = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const article = entry.target
        intersection.unobserve(article)
        if (seen.has(article)) continue
        seen.add(article)
        // Marqueur DOM en plus du WeakSet : X réutilise ses nœuds au recyclage de liste,
        // et l'attribut survit là où une référence d'objet ne suffit pas.
        article.setAttribute(PROCESSED_ATTR, '1')
        stats.observed += 1
        queue.push(article)
      }
    },
    // 25 % visible : assez pour dire que l'utilisateur l'a vu, pas assez pour rater un
    // post survolé rapidement.
    { threshold: 0.25 },
  )

  function registerArticles(root: ParentNode): void {
    const { els } = queryAll(root, POST_CONTAINER, options.health.sink)
    for (const article of els) {
      if (article.hasAttribute(PROCESSED_ATTR) || seen.has(article)) continue
      intersection.observe(article)
    }
  }

  /* ── MutationObserver : le fil est virtualisé, il change en permanence ───── */

  const mutation = new MutationObserver((records) => {
    // Rendre la main immédiatement : on ne fait qu'enregistrer des cibles, jamais parser.
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue
        const el = node as Element
        if (el.matches(POST_CONTAINER.candidates[0]!)) {
          if (!el.hasAttribute(PROCESSED_ATTR)) intersection.observe(el)
        } else {
          registerArticles(el)
        }
      }
    }
    checkNavigation()
  })

  /* ── Navigation SPA ─────────────────────────────────────────────────────── */

  function checkNavigation(): void {
    const path = location.pathname + location.search
    if (path === lastPath) return
    lastPath = path
    batcher.flushNow() // le lot en cours appartient à l'ancienne surface
    surfaceCtx = detectSurface(new URL(location.href), watchlist)
    stats.surface = surfaceCtx.surface
    log.debug('surface changée', { surface: surfaceCtx.surface })
    if (isObservable(surfaceCtx)) registerArticles(document)
    else queue.clear()
  }

  const onNavigate = (): void => checkNavigation()
  window.addEventListener('popstate', onNavigate)

  if (isObservable(surfaceCtx)) {
    registerArticles(document)
  } else {
    log.debug('surface non observable, scout inactif', { path: location.pathname })
  }

  mutation.observe(document.body, { childList: true, subtree: true })

  return {
    stop(): void {
      mutation.disconnect()
      intersection.disconnect()
      window.removeEventListener('popstate', onNavigate)
      batcher.dispose()
      queue.clear()
    },
    stats(): ScoutStats {
      return { ...stats, droppedFromQueue: queue.droppedCount }
    },
    flush(): void {
      batcher.flushNow()
    },
  }
}
