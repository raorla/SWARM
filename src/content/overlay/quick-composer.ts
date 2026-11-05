/**
 * Fiche de rédaction rapide, insérée sous un post.
 *
 * Écrite en DOM natif dans une racine d'ombre. Trois états seulement — inactif, en cours,
 * résultat — parce que c'est un composant qui doit être compris en une seconde par
 * quelqu'un qui lit son fil.
 *
 * Le bouton d'action s'appelle « Ouvrir dans le composeur », jamais « Publier ». Le
 * vocabulaire de l'UI doit dire la vérité sur ce que fait le produit : c'est l'utilisateur
 * qui publie (SPEC §4.6).
 */
import { X_REPLY_LIMIT } from '@/swarm/schemas/quick-reply.io'

export interface ComposerCallbacks {
  /** Demande une génération. `hint` est la consigne libre éventuelle. */
  onGenerate(hint: string | undefined): Promise<void>
  /** Ouvre le composeur de X avec le texte courant. */
  onStage(text: string): Promise<void>
  onDismiss(): void
}

/** Une variante affichable, telle que reçue du service worker. */
export interface ComposerVariant {
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

export interface ComposerState {
  phase: 'idle' | 'generating' | 'result' | 'declined' | 'error'
  variants?: ComposerVariant[]
  /** Index initialement sélectionné — le choix du CRITIC. */
  selectedIndex?: number
  sharedContext?: string
  costEur?: number
  latencyMs?: number
  mode?: 'chain' | 'quick-reply'
  voiceConfidence?: number | null
  message?: string
}

export interface ComposerHandle {
  element: HTMLElement
  setState(state: ComposerState): void
  focusDraft(): void
  destroy(): void
}

export function createQuickComposer(
  shadow: ShadowRoot,
  callbacks: ComposerCallbacks,
): ComposerHandle {
  const doc = shadow.ownerDocument
  const card = doc.createElement('div')
  card.className = 'card'
  card.setAttribute('role', 'group')
  card.setAttribute('aria-label', 'SWARM — réponses assistées')

  let current: ComposerState = { phase: 'idle' }
  /** Variante affichée. Indépendante du choix du CRITIC dès que l'utilisateur navigue. */
  let activeIndex = 0
  let draftEl: HTMLTextAreaElement | null = null

  const mkButton = (
    label: string,
    className: string,
    onClick: () => void,
    title?: string,
  ): HTMLButtonElement => {
    const b = doc.createElement('button')
    b.className = className
    b.type = 'button'
    b.textContent = label
    if (title !== undefined) b.title = title
    b.addEventListener('click', onClick)
    return b
  }

  const mkRow = (children: readonly HTMLElement[]): HTMLElement => {
    const row = doc.createElement('div')
    row.className = 'row'
    for (const c of children) row.appendChild(c)
    return row
  }

  const render = (): void => {
    card.textContent = ''
    draftEl = null

    const title = doc.createElement('h4')
    title.textContent =
      current.mode === 'quick-reply' ? 'SWARM · référence one-shot' : 'SWARM'
    card.appendChild(title)

    if (current.phase === 'generating') {
      const p = doc.createElement('p')
      p.className = 'meta'
      p.textContent = 'Rédaction, puis relecture critique…'
      card.appendChild(p)
      card.appendChild(mkRow([mkButton('Annuler', 'ghost', callbacks.onDismiss)]))
      return
    }

    if (current.phase === 'error') {
      const p = doc.createElement('p')
      p.className = 'error'
      p.textContent = current.message ?? 'échec'
      card.appendChild(p)
      card.appendChild(
        mkRow([
          mkButton('Réessayer', 'primary', () => void callbacks.onGenerate(undefined)),
          mkButton('Fermer', 'ghost', callbacks.onDismiss),
        ]),
      )
      return
    }

    if (current.phase === 'declined') {
      // Un veto est présenté comme un résultat, pas comme une panne : c'est le comportement
      // voulu du produit, et l'utilisateur doit le lire comme tel (SPEC §4.5).
      const p = doc.createElement('p')
      p.className = 'meta'
      p.style.color = '#e7e9ea'
      p.textContent = current.message ?? 'Rien à apporter ici.'
      card.appendChild(p)

      const hint = doc.createElement('p')
      hint.className = 'meta'
      hint.textContent = 'Un refus motivé vaut mieux qu’une réponse creuse.'
      card.appendChild(hint)

      const row = [
        mkButton(
          'Insister',
          'ghost',
          () =>
            void callbacks.onGenerate('Trouve un angle même si l’apport est modeste.'),
        ),
        mkButton('Fermer', 'ghost', callbacks.onDismiss),
      ]
      card.appendChild(mkRow(row))

      if (current.costEur !== undefined && current.costEur > 0) {
        const cost = doc.createElement('p')
        cost.className = 'meta'
        // Un refus a coûté des appels : le taire donnerait une fausse impression de gratuité.
        cost.textContent = `Ce refus a coûté ${current.costEur.toFixed(5)} €.`
        card.appendChild(cost)
      }
      return
    }

    if (current.phase === 'idle' || !current.variants || current.variants.length === 0) {
      const p = doc.createElement('p')
      p.className = 'meta'
      p.textContent = 'Générer des réponses à ce post.'
      card.appendChild(p)
      card.appendChild(
        mkRow([
          mkButton('Générer', 'primary', () => void callbacks.onGenerate(undefined)),
          mkButton('Fermer', 'ghost', callbacks.onDismiss),
        ]),
      )
      return
    }

    /* ── phase === 'result' ───────────────────────────────────────────────── */

    const variants = current.variants
    activeIndex = Math.min(activeIndex, variants.length - 1)
    const active = variants[activeIndex]!

    // Onglets de variantes. Affichés même à une seule variante : sinon l'UI change de forme
    // selon le nombre de propositions, ce qui déroute plus que ça n'allège.
    const tabs = doc.createElement('div')
    tabs.className = 'row'
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('aria-label', 'Variantes proposées')

    for (const [i, variant] of variants.entries()) {
      const isActive = i === activeIndex
      const isCriticPick = i === current.selectedIndex
      const tab = mkButton(
        `${i + 1}. ${variant.angle}${isCriticPick ? ' ★' : ''}`,
        isActive ? 'btn busy' : 'btn',
        () => {
          activeIndex = i
          render()
        },
        isCriticPick ? 'Retenue par le CRITIC' : undefined,
      )
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(isActive))
      tabs.appendChild(tab)
    }
    card.appendChild(tabs)

    const draft = doc.createElement('textarea')
    draft.className = 'draft'
    draft.value = active.text
    draft.setAttribute('aria-label', `Variante ${activeIndex + 1}, modifiable`)
    draft.rows = 3
    draftEl = draft
    card.appendChild(draft)

    const counter = doc.createElement('span')
    counter.className = 'meta count'
    const updateCounter = (): void => {
      const len = draft.value.length
      counter.textContent = `${len}/${X_REPLY_LIMIT}`
      counter.classList.toggle('over', len > X_REPLY_LIMIT)
    }
    updateCounter()
    draft.addEventListener('input', updateCounter)

    if (active.overLimit) {
      const warn = doc.createElement('p')
      warn.className = 'warn'
      warn.textContent =
        'Plus long que la limite de X. Volontairement non tronqué : couper au caractère 280 amputerait la phrase.'
      card.appendChild(warn)
    }

    if (
      current.voiceConfidence !== null &&
      current.voiceConfidence !== undefined &&
      current.voiceConfidence < 0.25
    ) {
      const warn = doc.createElement('p')
      warn.className = 'warn'
      warn.textContent =
        'Profil de voix insuffisant : le style n’est pas fiable et le CRITIC a durci ses critères.'
      card.appendChild(warn)
    }

    card.appendChild(
      mkRow([
        mkButton(
          'Ouvrir dans le composeur',
          'primary',
          () => void callbacks.onStage(draft.value),
        ),
        mkButton('Regénérer', 'ghost', () => void callbacks.onGenerate(undefined)),
        mkButton('Fermer', 'ghost', callbacks.onDismiss),
        counter,
      ]),
    )

    // Diagnostic : l'intention déclarée, la notation du CRITIC, la distance de voix.
    const intent = doc.createElement('p')
    intent.className = 'meta'
    intent.style.marginTop = '6px'
    intent.textContent = active.intent
    card.appendChild(intent)

    const scores = active.criticScores
    const diag = doc.createElement('p')
    diag.className = 'meta'
    diag.textContent = [
      scores ? `note ${scores.overall.toFixed(2)}` : 'non relu (référence one-shot)',
      scores ? `voix ${scores.voiceAuthenticity.toFixed(2)}` : null,
      scores ? `apport ${scores.valueAdded.toFixed(2)}` : null,
      scores && scores.reputationRisk > 0.2
        ? `risque ${scores.reputationRisk.toFixed(2)}`
        : null,
      `écart de forme ${active.voiceDistance.toFixed(2)}`,
      current.costEur !== undefined ? `${current.costEur.toFixed(5)} €` : null,
      current.latencyMs !== undefined ? `${Math.round(current.latencyMs)} ms` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    card.appendChild(diag)

    if (scores?.note) {
      const note = doc.createElement('p')
      note.className = 'meta'
      note.textContent = `CRITIC : ${scores.note}`
      card.appendChild(note)
    }
  }

  /**
   * Navigation clavier.
   *
   * SPEC §8 exige une accessibilité clavier complète sur le Flux ; l'overlay applique la
   * même convention pour que les deux surfaces se pilotent pareil. `1`–`3` sélectionnent une
   * variante, mais **seulement hors zone de saisie** : sinon taper « 2 » dans le brouillon
   * changerait de variante et effacerait l'édition en cours.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (current.phase !== 'result' || !current.variants) return
    const target = event.target as HTMLElement | null
    if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') return

    const index = Number.parseInt(event.key, 10)
    if (Number.isInteger(index) && index >= 1 && index <= current.variants.length) {
      event.preventDefault()
      activeIndex = index - 1
      render()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      callbacks.onDismiss()
    }
  }
  card.addEventListener('keydown', onKeyDown)

  render()
  shadow.appendChild(card)

  return {
    element: card,
    setState(state: ComposerState): void {
      const isNewResult = state.phase === 'result' && current.phase !== 'result'
      current = state
      // On aligne sur le choix du CRITIC à l'arrivée d'un résultat, pas à chaque rendu :
      // sinon la navigation de l'utilisateur serait écrasée au moindre re-render.
      if (isNewResult) activeIndex = state.selectedIndex ?? 0
      render()
    },
    focusDraft(): void {
      draftEl?.focus()
      draftEl?.setSelectionRange(draftEl.value.length, draftEl.value.length)
    },
    destroy(): void {
      card.removeEventListener('keydown', onKeyDown)
      card.remove()
    },
  }
}

/** Bouton discret ajouté à la barre d'actions d'un post. */
export function createTriggerButton(
  shadow: ShadowRoot,
  onClick: () => void,
): { element: HTMLElement; setBusy(busy: boolean): void } {
  const doc = shadow.ownerDocument
  const btn = doc.createElement('button')
  btn.className = 'btn'
  btn.type = 'button'
  btn.textContent = 'SWARM'
  btn.setAttribute('aria-label', 'Générer une réponse avec SWARM')
  btn.addEventListener('click', (e) => {
    // X place des gestionnaires de clic sur tout l'article : sans ça, cliquer notre bouton
    // ouvrirait aussi le post en pleine page.
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return {
    element: btn,
    setBusy(busy: boolean): void {
      btn.classList.toggle('busy', busy)
      btn.disabled = busy
      btn.textContent = busy ? '…' : 'SWARM'
    },
  }
}
