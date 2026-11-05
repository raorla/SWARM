/**
 * Montage de l'overlay : un bouton sous chaque post, une fiche à la demande.
 *
 * C'est le cas d'usage qui délivre la valeur immédiate (SPEC §6) et le DoD de la Phase 1.
 * Il court-circuite volontairement tout le pipeline : pas de triage, pas de file, pas de
 * gouvernance de cadence — l'utilisateur a cliqué, il attend une réponse maintenant.
 *
 * Le governor intervient quand même, mais pour ce qui le concerne ici : le sujet du post
 * (topic-guard) et le budget. Pas la cadence, qui n'a pas de sens sur une action demandée
 * explicitement.
 */
import { ACTION_BAR, OVERLAY_ANCHOR_ATTR, POST_CONTAINER } from '../dom/x-selectors'
import { queryAll, queryOne, type ReportSink } from '../dom/query'
import { extractPost } from '../scout/extract-post'
import { detectSurface, isObservable } from '../scout/feed-router'
import { createIsolatedSlot } from './shadow-root'
import {
  createQuickComposer,
  createTriggerButton,
  type ComposerState,
} from './quick-composer'
import { stageDraft, type StageError } from '../actuator/stage-draft'
import { REPLY_BUTTON } from '../dom/x-selectors'
import type { ExtractedPost } from '../dom/dom-schemas'
import { createLogger } from '@/shared/logger'
import type { Clock } from '@/shared/time'

const log = createLogger('content:overlay')

/** Résultat attendu du service worker. Validé côté appelant. */
export interface ReplyVariant {
  text: string
  angle: string
  intent: string
  voiceDistance: number
  overLimit: boolean
  criticScores: {
    voiceAuthenticity: number
    valueAdded: number
    reputationRisk: number
    redundancy: number
    attentionCost: number
    overall: number
    note: string
  } | null
}

export interface ReplyGeneration {
  ok: boolean
  decision?: 'reply' | 'decline'
  variants?: ReplyVariant[]
  selectedIndex?: number
  sharedContext?: string
  reasoning?: string
  costEur?: number
  latencyMs?: number
  mode?: 'chain' | 'quick-reply'
  voiceConfidence?: number | null
  error?: string
}

export interface OverlayOptions {
  clock: Clock
  report: ReportSink
  ownHandle: string | null
  /** Demande la génération au service worker — le content script n'a pas les clés. */
  requestReply(post: ExtractedPost, hint: string | undefined): Promise<ReplyGeneration>
  /** Ouvre le composeur de réponse de X pour ce post. */
  openReplyComposer?(article: Element): Promise<boolean>
}

export interface OverlayHandle {
  /** Attache le bouton aux posts non encore équipés sous `root`. */
  attachTo(root: ParentNode): number
  stop(): void
  attachedCount(): number
}

export function mountOverlay(options: OverlayOptions): OverlayHandle {
  let attached = 0
  const equipped = new WeakSet<Element>()
  let openCard: { destroy(): void; container: HTMLElement } | null = null

  /** Ouvre le composeur natif de X, faute de quoi le brouillon n'a nulle part à aller. */
  const openComposer =
    options.openReplyComposer ??
    (async (article: Element): Promise<boolean> => {
      const bar = queryOne(article, ACTION_BAR, options.report).el ?? article
      const replyBtn = queryOne<HTMLElement>(bar, REPLY_BUTTON, options.report).el
      if (!replyBtn) return false
      replyBtn.click()
      // X ouvre une fenêtre modale : on lui laisse un instant pour monter son éditeur.
      await new Promise((r) => setTimeout(r, 350))
      return true
    })

  function closeCard(): void {
    openCard?.destroy()
    openCard?.container.remove()
    openCard = null
  }

  function attachToArticle(article: Element): boolean {
    if (equipped.has(article) || article.hasAttribute(OVERLAY_ANCHOR_ATTR)) return false

    const bar = queryOne(article, ACTION_BAR, options.report).el
    if (!bar) return false

    equipped.add(article)
    article.setAttribute(OVERLAY_ANCHOR_ATTR, '1')

    const { container, shadow } = createIsolatedSlot(article.ownerDocument)
    container.style.display = 'inline-flex'
    container.style.width = 'auto'
    container.style.marginLeft = '4px'

    const trigger = createTriggerButton(shadow, () => void onTrigger(article, trigger))
    shadow.appendChild(trigger.element)
    bar.appendChild(container)

    attached += 1
    return true
  }

  async function onTrigger(
    article: Element,
    trigger: { setBusy(busy: boolean): void },
  ): Promise<void> {
    closeCard()

    const surfaceCtx = detectSurface(new URL(location.href))
    if (!isObservable(surfaceCtx)) {
      log.debug('surface non exploitable, overlay inactif')
      return
    }

    const extracted = extractPost(article, {
      surface: surfaceCtx.surface,
      clock: options.clock,
      report: options.report,
      ownHandle: options.ownHandle,
    })

    // La fiche est montée sous le post, dans sa propre racine d'ombre.
    const slot = createIsolatedSlot(article.ownerDocument)
    article.appendChild(slot.container)

    let composer: ReturnType<typeof createQuickComposer> | null = null

    const setState = (state: ComposerState): void => composer?.setState(state)

    const generate = async (hint: string | undefined): Promise<void> => {
      if (!extracted.ok) {
        setState({
          phase: 'error',
          message: `post illisible (${extracted.error.kind}) — le DOM de X a peut-être changé`,
        })
        return
      }
      trigger.setBusy(true)
      setState({ phase: 'generating' })

      const result = await options.requestReply(extracted.value, hint)
      trigger.setBusy(false)

      if (!result.ok) {
        setState({ phase: 'error', message: result.error ?? 'échec inconnu' })
        return
      }
      if (result.decision === 'decline') {
        setState({
          phase: 'declined',
          message: result.reasoning ?? 'Rien à apporter ici.',
          ...(result.costEur !== undefined ? { costEur: result.costEur } : {}),
          ...(result.mode !== undefined ? { mode: result.mode } : {}),
        })
        return
      }
      setState({
        phase: 'result',
        variants: result.variants ?? [],
        selectedIndex: result.selectedIndex ?? 0,
        ...(result.sharedContext !== undefined
          ? { sharedContext: result.sharedContext }
          : {}),
        ...(result.costEur !== undefined ? { costEur: result.costEur } : {}),
        ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
        ...(result.mode !== undefined ? { mode: result.mode } : {}),
        ...(result.voiceConfidence !== undefined
          ? { voiceConfidence: result.voiceConfidence }
          : {}),
      })
      composer?.focusDraft()
    }

    const stage = async (text: string): Promise<void> => {
      if (text.trim() === '') return
      const opened = await openComposer(article)
      if (!opened) {
        setState({
          phase: 'error',
          message: 'bouton Répondre introuvable — le DOM de X a peut-être changé',
        })
        return
      }
      // Le jeton d'overlay marque une action demandée explicitement par l'utilisateur. Il
      // n'ouvre aucun droit de publication : l'actuator ne soumet jamais (SPEC §4.6).
      const staged = await stageDraft({
        text,
        permitToken: 'overlay-manual-request',
        report: options.report,
      })
      if (!staged.ok) {
        setState({ phase: 'error', message: describeStageError(staged.error) })
        return
      }
      closeCard()
    }

    composer = createQuickComposer(slot.shadow, {
      onGenerate: generate,
      onStage: stage,
      onDismiss: closeCard,
    })

    openCard = { destroy: () => composer?.destroy(), container: slot.container }

    // Génération immédiate : l'utilisateur a cliqué « SWARM », il ne veut pas cliquer
    // « Générer » ensuite.
    await generate(undefined)
  }

  return {
    attachTo(root: ParentNode): number {
      const { els } = queryAll(root, POST_CONTAINER, options.report)
      let added = 0
      for (const article of els) if (attachToArticle(article)) added += 1
      return added
    },
    stop(): void {
      closeCard()
      for (const el of document.querySelectorAll(`[${OVERLAY_ANCHOR_ATTR}]`)) {
        el.removeAttribute(OVERLAY_ANCHOR_ATTR)
      }
    },
    attachedCount(): number {
      return attached
    },
  }
}

function describeStageError(e: StageError): string {
  switch (e.kind) {
    case 'no-editor':
      return 'zone de saisie introuvable — le composeur s’est-il ouvert ?'
    case 'write-failed':
      return `écriture refusée par l’éditeur (essayé : ${e.attempted.join(', ')})`
    case 'verification-failed':
      return 'le texte n’a pas tenu dans l’éditeur — copie-le à la main'
    case 'invalid-permit':
      return `action non autorisée : ${e.detail}`
  }
}
