/**
 * Résultat de rédaction dans le Flux.
 *
 * Quatre états, et le plus important est `declined` : un veto du CRITIC est présenté comme
 * un **résultat**, pas comme une panne (SPEC §4.5). Le taux de rejet est une métrique du
 * produit ; l'afficher en rouge apprendrait à l'utilisateur à le voir comme un défaut.
 */
import { useEffect, useRef, useState } from 'react'
import { X_REPLY_LIMIT } from '@/swarm/schemas/quick-reply.io'
import type { DraftVariantWire } from '@/messaging/contract'

export type DraftState =
  | { phase: 'idle' }
  | { phase: 'hinting'; opportunityId: number }
  | { phase: 'generating'; opportunityId: number }
  | {
      phase: 'result'
      variants: DraftVariantWire[]
      selectedIndex: number
      costEur: number
      escalated: boolean
      evRank: number
    }
  | { phase: 'declined'; message: string; costEur: number }
  | { phase: 'error'; message: string }

export function DraftResult(props: {
  state: DraftState
  onSubmitHint: (hint: string) => void
  onDismiss: () => void
  onNext: () => void
}): React.ReactElement {
  const { state } = props
  const [activeIndex, setActiveIndex] = useState(0)
  const hintRef = useRef<HTMLInputElement | null>(null)

  // Le champ de consigne prend le focus dès son apparition : sans ça, l'utilisateur qui a
  // tapé « E » devrait attraper la souris, ce qui casse le pilotage clavier.
  useEffect(() => {
    if (state.phase === 'hinting') hintRef.current?.focus()
  }, [state.phase])

  useEffect(() => {
    if (state.phase === 'result') setActiveIndex(state.selectedIndex)
  }, [state])

  if (state.phase === 'idle') return <></>

  if (state.phase === 'hinting') {
    return (
      <section className="rounded-lg border border-x-border bg-x-surface p-3">
        <label className="block text-[10px] uppercase tracking-wider text-x-muted">
          Consigne pour le WRITER
        </label>
        <input
          ref={hintRef}
          type="text"
          placeholder="sois plus sec · demande une source · fais court"
          className="mt-1.5 w-full rounded border border-x-border bg-x-bg px-2 py-1.5 text-[12px]"
          onKeyDown={(event) => {
            // Les raccourcis du Flux sont inertes ici (voir `isTypingTarget`) : on gère donc
            // Entrée et Échap localement.
            if (event.key === 'Enter')
              props.onSubmitHint(event.currentTarget.value.trim())
            if (event.key === 'Escape') props.onDismiss()
          }}
        />
        <p className="mt-1.5 text-[10px] text-x-muted">
          Entrée pour rédiger · Échap pour annuler
        </p>
      </section>
    )
  }

  if (state.phase === 'generating') {
    return (
      <section className="rounded-lg border border-x-border bg-x-surface p-3">
        <p className="text-[11px] text-x-muted">Rédaction, puis relecture critique…</p>
      </section>
    )
  }

  if (state.phase === 'error') {
    return (
      <section className="rounded-lg border border-x-danger/30 bg-x-danger/10 p-3">
        <p className="text-[11px] text-x-danger">{state.message}</p>
      </section>
    )
  }

  if (state.phase === 'declined') {
    return (
      <section className="rounded-lg border border-x-border bg-x-surface p-3">
        <div className="text-[10px] uppercase tracking-wider text-x-muted">
          Veto du CRITIC
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-x-text/90">{state.message}</p>
        <p className="mt-1.5 text-[10px] leading-relaxed text-x-muted">
          Un refus motivé vaut mieux qu’une réponse creuse. Le taux de rejet est une
          métrique du produit, pas un défaut.
          {state.costEur > 0 && ` Ce refus a coûté ${state.costEur.toFixed(5)} €.`}
        </p>
        <button
          onClick={props.onNext}
          className="mt-2 rounded-full border border-x-border px-3 py-1.5 text-[11px] hover:bg-x-surface-2"
        >
          Suivant
        </button>
      </section>
    )
  }

  /* ── phase === 'result' ──────────────────────────────────────────────────── */

  const active = state.variants[Math.min(activeIndex, state.variants.length - 1)]
  if (!active) return <></>

  return (
    <section className="space-y-2 rounded-lg border border-x-border bg-x-surface p-3">
      <div className="flex items-baseline justify-between text-[10px] text-x-muted">
        <span>{state.variants.length} variantes</span>
        <span className="font-mono">
          {state.costEur.toFixed(5)} €
          {state.escalated && (
            <span className="ml-1 text-x-accent" title={`rang EV ${state.evRank}`}>
              ★ modèle fort
            </span>
          )}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Variantes">
        {state.variants.map((variant, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={i === activeIndex}
            onClick={() => setActiveIndex(i)}
            className={`rounded-full border px-2 py-0.5 text-[10px] ${
              i === activeIndex
                ? 'border-x-accent text-x-accent'
                : 'border-x-border text-x-muted hover:text-x-text'
            }`}
          >
            {i + 1}. {variant.angle}
            {i === state.selectedIndex && ' ★'}
          </button>
        ))}
      </div>

      <p className="whitespace-pre-wrap rounded bg-x-bg p-2 text-[12px] leading-relaxed">
        {active.text}
      </p>

      {active.overLimit && (
        <p className="rounded border border-x-warning/30 bg-x-warning/10 px-2 py-1 text-[10px] text-x-warning">
          {active.text.length}/{X_REPLY_LIMIT} — plus long que la limite de X,
          volontairement non tronqué.
        </p>
      )}

      <p className="text-[10px] leading-snug text-x-muted">{active.intent}</p>

      {active.criticScores && (
        <p className="font-mono text-[10px] text-x-muted">
          note {active.criticScores.overall.toFixed(2)} · voix{' '}
          {active.criticScores.voiceAuthenticity.toFixed(2)} · apport{' '}
          {active.criticScores.valueAdded.toFixed(2)}
          {active.criticScores.reputationRisk > 0.2 &&
            ` · risque ${active.criticScores.reputationRisk.toFixed(2)}`}
          {' · écart de forme '}
          {active.voiceDistance.toFixed(2)}
        </p>
      )}

      {active.criticScores?.note && (
        <p className="text-[10px] leading-snug text-x-muted">
          CRITIC : {active.criticScores.note}
        </p>
      )}

      <p className="border-l-2 border-x-border pl-2 text-[10px] leading-relaxed text-x-muted">
        Copie la variante et publie-la depuis X. Le produit ne publie jamais à ta place.
      </p>
    </section>
  )
}
