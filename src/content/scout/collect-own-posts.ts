/**
 * Collecte du corpus de l'utilisateur — source du Voice Profile.
 *
 * ## L'arbitrage, et pourquoi il tient
 *
 * Construire un Voice Profile demande environ 200 posts, ce qui demande de faire défiler un
 * profil. Cela frotte contre « pas de scroll infini automatisé » (SPEC §4.1), et il serait
 * malhonnête de prétendre le contraire.
 *
 * Ce qui rend l'arbitrage acceptable, et qui est **appliqué par le code** et non promis :
 *
 *  1. **Explicitement déclenché.** Jamais en arrière-plan, jamais au chargement d'une page.
 *  2. **Uniquement son propre profil.** Vérifié contre le handle configuré à chaque tour de
 *     boucle, pas seulement à l'entrée : une navigation en cours de collecte doit l'arrêter.
 *  3. **Borné** : nombre de défilements, nombre de posts, durée totale. Trois bornes plutôt
 *     qu'une, parce qu'une seule se contourne par un cas limite.
 *  4. **Interruptible** à tout instant.
 *  5. **Progression visible.** Une collecte silencieuse serait indistinguable d'un scraper.
 *  6. **Cadence humaine** entre les défilements — la même mécanique log-normale que le
 *     governor, pas un `while(true)`.
 */
import { POST_CONTAINER } from '../dom/x-selectors'
import { queryAll, type ReportSink } from '../dom/query'
import { extractPost } from './extract-post'
import { isOwnProfilePage } from './own-identity'
import type { ExtractedPost } from '../dom/dom-schemas'
import { logNormalDelay, type Rng } from '@/shared/rng'
import type { Clock } from '@/shared/time'
import { MINUTE } from '@/shared/time'
import { createLogger } from '@/shared/logger'
import { err, ok, type Result } from '@/shared/result'

const log = createLogger('content:collect-own')

export interface CollectLimits {
  /** Nombre maximum de posts collectés. */
  maxPosts: number
  /** Nombre maximum de défilements, même si le quota de posts n'est pas atteint. */
  maxScrolls: number
  /** Durée totale maximum. */
  maxDurationMs: number
  /** Défilements successifs sans nouveau post avant de conclure à la fin du profil. */
  emptyScrollsBeforeStop: number
  /** Délai entre défilements, borné — cadence humaine. */
  scrollDelayMs: { min: number; max: number }
}

/**
 * Bornes par défaut.
 *
 * 200 posts est la cible du Voice Profile. 60 défilements et 4 minutes sont calibrés pour
 * l'atteindre sans jamais tourner longtemps : si le profil est plus court, la détection de
 * fin s'arrête d'elle-même bien avant.
 */
export const DEFAULT_COLLECT_LIMITS: CollectLimits = {
  maxPosts: 200,
  maxScrolls: 60,
  maxDurationMs: 4 * MINUTE,
  emptyScrollsBeforeStop: 3,
  // 700 ms–2,2 s : assez pour laisser X charger, assez lent pour ne pas marteler.
  scrollDelayMs: { min: 700, max: 2_200 },
}

export interface CollectProgress {
  collected: number
  scrolls: number
  elapsedMs: number
  /** Raison d'arrêt, renseignée seulement à la fin. */
  stopReason: StopReason | null
}

export type StopReason =
  | 'quota-atteint'
  | 'fin-du-profil'
  | 'limite-de-defilements'
  | 'limite-de-duree'
  | 'interrompu'
  | 'navigation'

export type CollectError =
  { kind: 'not-own-profile'; detail: string } | { kind: 'no-handle'; detail: string }

export interface CollectResult {
  posts: ExtractedPost[]
  stopReason: StopReason
  scrolls: number
  elapsedMs: number
}

export interface CollectOptions {
  /** Handle configuré. La collecte refuse tout autre profil. */
  ownHandle: string | null
  clock: Clock
  rng: Rng
  report: ReportSink
  limits?: Partial<CollectLimits>
  onProgress?: (progress: CollectProgress) => void
  signal?: AbortSignal
  /** Injectables pour les tests — le DOM réel n'est pas déterministe. */
  scrollBy?: (delta: number) => void
  sleep?: (ms: number) => Promise<void>
  currentUrl?: () => URL
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function collectOwnPosts(
  options: CollectOptions,
): Promise<Result<CollectResult, CollectError>> {
  const limits: CollectLimits = { ...DEFAULT_COLLECT_LIMITS, ...options.limits }
  const urlOf = options.currentUrl ?? ((): URL => new URL(location.href))
  const scroll = options.scrollBy ?? ((delta: number): void => window.scrollBy(0, delta))
  const sleep = options.sleep ?? realSleep

  if (!options.ownHandle) {
    return err({
      kind: 'no-handle',
      detail:
        'aucun handle configuré — impossible de vérifier qu’il s’agit de ton profil',
    })
  }

  if (!isOwnProfilePage(urlOf(), options.ownHandle)) {
    // Refus explicite plutôt que collecte silencieuse : c'est ce qui empêche un bug d'UI de
    // transformer l'outil en collecteur de profils tiers.
    return err({
      kind: 'not-own-profile',
      detail: `la collecte ne fonctionne que sur /${options.ownHandle.replace(/^@/, '')}`,
    })
  }

  const startedAt = options.clock.now()
  const byPostId = new Map<string, ExtractedPost>()
  let scrolls = 0
  let emptyScrolls = 0
  let stopReason: StopReason | null = null

  const harvest = (): number => {
    const before = byPostId.size
    const { els } = queryAll(document, POST_CONTAINER, options.report)
    for (const article of els) {
      if (byPostId.size >= limits.maxPosts) break
      const extracted = extractPost(article, {
        surface: 'watchlist', // son propre profil : affinité maximale par définition
        clock: options.clock,
        report: options.report,
        ownHandle: options.ownHandle,
      })
      if (!extracted.ok) continue
      // On ne garde que ses propres posts : un profil affiche aussi les reposts d'autrui.
      if (!extracted.value.isOwnPost) continue
      byPostId.set(extracted.value.postId, extracted.value)
    }
    return byPostId.size - before
  }

  const emitProgress = (): void => {
    options.onProgress?.({
      collected: byPostId.size,
      scrolls,
      elapsedMs: options.clock.now() - startedAt,
      stopReason,
    })
  }

  // Première récolte avant tout défilement : ce qui est déjà à l'écran est déjà visible.
  harvest()
  emitProgress()

  while (stopReason === null) {
    if (options.signal?.aborted) {
      stopReason = 'interrompu'
      break
    }
    if (byPostId.size >= limits.maxPosts) {
      stopReason = 'quota-atteint'
      break
    }
    if (scrolls >= limits.maxScrolls) {
      stopReason = 'limite-de-defilements'
      break
    }
    if (options.clock.now() - startedAt >= limits.maxDurationMs) {
      stopReason = 'limite-de-duree'
      break
    }
    // Vérifié à CHAQUE tour, pas seulement à l'entrée : si l'utilisateur navigue ailleurs
    // pendant la collecte, elle doit s'arrêter net.
    if (!isOwnProfilePage(urlOf(), options.ownHandle)) {
      stopReason = 'navigation'
      break
    }

    scroll(window.innerHeight * 0.85)
    scrolls += 1

    // Cadence humaine, même mécanique log-normale que le governor : beaucoup de délais
    // courts, une queue longue, jamais deux identiques.
    await sleep(
      logNormalDelay(options.rng, limits.scrollDelayMs.min, limits.scrollDelayMs.max),
    )

    const added = harvest()
    emptyScrolls = added === 0 ? emptyScrolls + 1 : 0
    emitProgress()

    if (emptyScrolls >= limits.emptyScrollsBeforeStop) {
      // X n'expose aucun marqueur de fin de liste : l'absence de nouveauté est le seul
      // signal disponible.
      stopReason = 'fin-du-profil'
    }
  }

  emitProgress()
  const elapsedMs = options.clock.now() - startedAt

  log.info('collecte terminée', {
    collected: byPostId.size,
    scrolls,
    elapsedMs,
    stopReason,
  })

  return ok({
    posts: [...byPostId.values()],
    stopReason: stopReason ?? 'fin-du-profil',
    scrolls,
    elapsedMs,
  })
}

/** Message lisible pour l'UI. Une raison d'arrêt doit se comprendre sans lire le code. */
export function describeStopReason(reason: StopReason, collected: number): string {
  switch (reason) {
    case 'quota-atteint':
      return `${collected} posts collectés — quota atteint.`
    case 'fin-du-profil':
      return `${collected} posts collectés — fin du profil.`
    case 'limite-de-defilements':
      return `${collected} posts collectés — limite de défilements atteinte, relance pour continuer.`
    case 'limite-de-duree':
      return `${collected} posts collectés — limite de durée atteinte, relance pour continuer.`
    case 'interrompu':
      return `${collected} posts collectés avant interruption.`
    case 'navigation':
      return `${collected} posts collectés — arrêt : tu as quitté ton profil.`
  }
}
