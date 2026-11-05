/**
 * Content script — point d'entrée sur x.com.
 *
 * Assemble les trois pièces de la Phase 1 : l'overlay (le cas d'usage rapide qui délivre
 * la valeur immédiate), le scout (lecture passive pour les phases suivantes), et la
 * télémétrie de santé des sélecteurs.
 *
 * Deux gardes ouvrent le fichier, et leur absence produit des bugs qu'on ne comprend pas :
 *
 *  1. **Injection unique.** Après une mise à jour, `lifecycle.ts` réinjecte le script dans
 *     les onglets ouverts. Sans marqueur, deux instances observent le même DOM et tout est
 *     compté deux fois.
 *  2. **Contexte invalidé.** Un content script survit au rechargement de son extension
 *     mais son `chrome.runtime` ne répond plus. Sans détection, chaque appel lance dans la
 *     console de X — sur la page de l'utilisateur, ce qui est inutile et visible.
 */
import { MSG, ReplyGenerationSchema } from '@/messaging/contract'
import { describeSendError, emit, send } from '@/messaging/send'
import { startScout, type ScoutHandle } from './scout/observer'
import { collectOwnPosts, describeStopReason } from './scout/collect-own-posts'
import { detectOwnHandle, isOwnProfilePage } from './scout/own-identity'
import { mountOverlay, type OverlayHandle, type ReplyGeneration } from './overlay/mount'
import { SelectorHealth } from './dom/selector-health'
import { captureBreakContext } from './dom/snapshot-on-break'
import { CRITICAL_SELECTORS, POST_CONTAINER } from './dom/x-selectors'
import { queryOne } from './dom/query'
import { detectSurface } from './scout/feed-router'
import type { ExtractedPost } from './dom/dom-schemas'
import { createLogger } from '@/shared/logger'
import { systemClock, MINUTE } from '@/shared/time'
import { cryptoRng } from '@/shared/rng'
import { createRouter } from '@/messaging/listen'

const MARKER = '__swarmContentScriptLoaded'
const log = createLogger('content')
const clock = systemClock

declare global {
  interface Window {
    [MARKER]?: boolean
  }
}

function isContextAlive(): boolean {
  try {
    return chrome.runtime?.id !== undefined
  } catch {
    return false
  }
}

/**
 * Télémétrie de santé, envoyée périodiquement.
 *
 * Pas à chaque post : ce serait réveiller le service worker en permanence. Pas seulement à
 * la rupture non plus — l'onglet Config doit pouvoir afficher un état de santé même quand
 * tout va bien, sinon l'utilisateur ne sait pas si le silence signifie « sain » ou
 * « plus rien ne tourne ».
 */
const HEALTH_REPORT_INTERVAL_MS = 5 * MINUTE

function bootstrap(): void {
  if (window[MARKER]) {
    log.debug('déjà injecté, seconde instance ignorée')
    return
  }
  window[MARKER] = true

  if (!isContextAlive()) {
    log.warn('contexte d’extension invalidé — recharge la page')
    return
  }

  const requiredNames = new Set(CRITICAL_SELECTORS.map((s) => s.name))

  const health = new SelectorHealth(
    clock,
    (event) => {
      // MH-14 : on capture le contexte DOM anonymisé, dans le content script, avant que
      // quoi que ce soit ne sorte de la page. Une alerte sans preuve oblige à reproduire
      // le bug à l'aveugle.
      const sample = queryOne(document, POST_CONTAINER).el
      const snippet = captureBreakContext(sample)
      log.warn('rupture de sélecteur — alerte envoyée', { name: event.selectorName })
      emit(MSG.SELECTOR_BROKEN, {
        selectorName: event.selectorName,
        surface: detectSurface(new URL(location.href)).surface,
        consecutiveMisses: event.consecutiveMisses,
        ...(snippet !== null ? { anonymizedSnippet: snippet } : {}),
      })
    },
    requiredNames,
  )

  /* ── Overlay : le chemin qui délivre la valeur immédiate ────────────────── */

  const overlay: OverlayHandle = mountOverlay({
    clock,
    report: health.sink,
    // Renseigné en Phase 2, à la construction du Voice Profile.
    ownHandle: null,
    requestReply: async (post: ExtractedPost, hint): Promise<ReplyGeneration> => {
      const result = await send(
        MSG.MANUAL_REPLY_REQUEST,
        hint === undefined ? { post } : { post, hint },
        // La chaîne traverse deux appels LLM avec retry : le délai par défaut est trop court.
        { timeoutMs: 120_000 },
      )
      if (!result.ok) return { ok: false, error: describeSendError(result.error) }

      const parsed = ReplyGenerationSchema.safeParse(result.value)
      if (!parsed.success) {
        return { ok: false, error: 'réponse du service worker hors contrat' }
      }
      if (!parsed.data.ok) return { ok: false, error: parsed.data.error }

      const { ok: _ok, ...rest } = parsed.data
      return { ok: true, ...rest }
    },
  })

  /* ── Scout : lecture passive, alimente les phases 3 et suivantes ────────── */

  const scout: ScoutHandle = startScout({
    clock,
    health,
    onBatch: (posts) => {
      emit(MSG.POSTS_OBSERVED, {
        posts: posts.map((p) => ({
          postId: p.postId,
          authorHandle: p.authorHandle,
          // Le nombre d'abonnés n'est pas dans le fil : il demande une visite de profil,
          // que le QUALIFIER décidera de faire ou non (Phase 3).
          authorFollowers: null,
          text: p.text,
          lang: p.lang,
          createdAtMs: p.postedAtMs,
          replyCount: p.replyCount ?? 0,
          likeCount: p.likeCount ?? 0,
          repostCount: p.repostCount ?? 0,
          hasMedia: p.hasMedia,
          isReply: p.isReply,
          surface: p.surface,
          observedAtMs: p.observedAtMs,
        })),
      })
      // Chaque lot de posts est aussi une occasion d'équiper les nouveaux articles.
      overlay.attachTo(document)
    },
    onExtractionFailure: (_article, reason) => {
      log.debug('extraction échouée', { reason })
    },
  })

  /* ── Attache initiale et rattrapage périodique ──────────────────────────── */

  overlay.attachTo(document)

  // Rattrapage : X remonte parfois des articles sans mutation observable sur `body`
  // (recyclage de nœuds existants). Un balayage peu fréquent coûte moins qu'un
  // MutationObserver plus large, qui se déclencherait sur chaque frappe de l'utilisateur.
  const catchUp = setInterval(() => overlay.attachTo(document), 4_000)

  const healthTimer = setInterval(() => {
    emit(MSG.SELECTOR_HEALTH, {
      hitRate: health.hitRate(),
      broken: health.brokenSelectors(),
      surface: detectSurface(new URL(location.href)).surface,
    })
  }, HEALTH_REPORT_INTERVAL_MS)

  /* ── Détection du handle et collecte du corpus (Phase 2) ────────────────── */

  // Proposé une fois au chargement. Le service worker ne l'enregistre que si aucun handle
  // n'est déjà configuré : une détection ne doit jamais écraser un choix confirmé.
  const detected = detectOwnHandle(document, health.sink)
  if (detected) {
    log.debug('handle détecté', { source: detected.source })
    emit(MSG.OWN_HANDLE_DETECTED, detected)
  }

  /**
   * Collecte déclenchée depuis le side panel.
   *
   * Un seul parcours à la fois : deux collectes concurrentes se battraient pour le
   * défilement et produiraient un corpus incohérent. `AbortController` permet au panel
   * d'interrompre.
   */
  let collecting: AbortController | null = null

  const collectionRouter = createRouter('content:collect')
  collectionRouter
    .on(MSG.START_COLLECTION, async (payload) => {
      if (collecting) {
        collecting.abort()
        collecting = null
        return { started: false, reason: 'collecte déjà en cours, interrompue' }
      }
      const controller = new AbortController()
      collecting = controller

      const config = await send(MSG.VOICE_PROFILE_STATUS, {})
      const handle =
        config.ok && typeof config.value === 'object' && config.value !== null
          ? ((config.value as { handle?: string | null }).handle ?? null)
          : null

      const result = await collectOwnPosts({
        ownHandle: handle,
        clock,
        rng: cryptoRng,
        report: health.sink,
        ...(payload.maxPosts !== undefined
          ? { limits: { maxPosts: payload.maxPosts } }
          : {}),
        signal: controller.signal,
        onProgress: (progress) => emit(MSG.COLLECTION_PROGRESS, progress),
      })
      collecting = null

      if (!result.ok) return { started: false, reason: result.error.detail }

      // On n'envoie que ce dont le corpus a besoin : la surface d'observation et les
      // métriques de saturation ne concernent pas ses propres posts.
      const posts = result.value.posts.map((p) => ({
        postId: p.postId,
        text: p.text,
        lang: p.lang,
        postedAtMs: p.postedAtMs,
        likeCount: p.likeCount,
        replyCount: p.replyCount,
        repostCount: p.repostCount,
        hasMedia: p.hasMedia,
        isReply: p.isReply,
      }))

      const ingested = await send(MSG.OWN_POSTS_COLLECTED, {
        posts,
        stopReason: result.value.stopReason,
        scrolls: result.value.scrolls,
      })

      return {
        started: true,
        collected: posts.length,
        stopReason: result.value.stopReason,
        message: describeStopReason(result.value.stopReason, posts.length),
        ingested: ingested.ok ? ingested.value : null,
      }
    })
    .start()

  const teardown = (): void => {
    collecting?.abort()
    clearInterval(catchUp)
    clearInterval(healthTimer)
    scout.flush()
    scout.stop()
    overlay.stop()
  }

  // `pagehide` plutôt que `beforeunload` : il se déclenche aussi à la mise en cache de la
  // page (retour arrière), là où `beforeunload` ne le fait pas.
  window.addEventListener('pagehide', teardown, { once: true })

  log.info('content script prêt', {
    path: location.pathname,
    surface: detectSurface(new URL(location.href)).surface,
    onOwnProfile:
      detected !== null && isOwnProfilePage(new URL(location.href), detected.handle),
  })
}

bootstrap()
