/**
 * Onglet Flux — la file d'opportunités.
 *
 * C'est l'écran où l'utilisateur passe son temps (SPEC §6), ce qui impose deux choses :
 *
 *  1. **Une carte à la fois, pas une liste.** Une liste invite à parcourir ; le produit veut
 *     une décision par opportunité. Le compteur de position remplace le défilement.
 *  2. **Tout au clavier.** La souris ne doit jamais être nécessaire (SPEC §8).
 *
 * ## Ce que l'écran dit quand il est vide
 *
 * Une file vide a quatre causes très différentes — pas encore de triage, budget épuisé,
 * seuils trop stricts, ou tout simplement rien d'intéressant dans le fil. Les confondre
 * ferait chercher un bug là où il y a un réglage. L'écran vide affiche donc les statistiques
 * de file, qui distinguent les quatre.
 */
import { useCallback, useEffect, useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'
import type { QueueCard } from '@/background/queue.handler'
import type { QueueStats } from '@/db/repositories/opportunity.repo'
import { useFluxKeyboard, type FluxAction } from '../../hooks/useFluxKeyboard'
import { ScoreBreakdownPanel } from './ScoreBreakdown'
import { KeyboardHelp } from './KeyboardHelp'
import { DraftResult, type DraftState } from './DraftResult'

interface QueueResponse {
  cards: QueueCard[]
  expiredNow: number
}

export function FluxTab(): React.ReactElement {
  const [cards, setCards] = useState<QueueCard[]>([])
  const [stats, setStats] = useState<
    (QueueStats & { budgetRemainingEur: number }) | null
  >(null)
  const [index, setIndex] = useState(0)
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [draft, setDraft] = useState<DraftState>({ phase: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const current = cards[index] ?? null

  const refresh = useCallback(async () => {
    const [queue, statsResult] = await Promise.all([
      send(MSG.QUEUE_LIST, { limit: 30 }),
      send(MSG.QUEUE_STATS, {}),
    ])
    setLoading(false)

    if (!queue.ok) {
      if (queue.error.kind !== 'no-receiver') setError(describeSendError(queue.error))
      return
    }
    setError(null)
    const payload = queue.value as QueueResponse
    setCards(payload.cards)
    // On borne l'index plutôt que de le remettre à zéro : la file se rafraîchit en fond, et
    // renvoyer l'utilisateur en tête à chaque rafraîchissement lui ferait perdre sa place.
    setIndex((previous) => Math.min(previous, Math.max(0, payload.cards.length - 1)))
    if (statsResult.ok) {
      setStats(statsResult.value as QueueStats & { budgetRemainingEur: number })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* ── Actions ────────────────────────────────────────────────────────────── */

  const requestDraft = useCallback(
    async (hint?: string) => {
      if (!current) return
      setDraft({ phase: 'generating', opportunityId: current.id })

      const result = await send(
        MSG.OPPORTUNITY_DRAFT,
        hint === undefined
          ? { opportunityId: current.id }
          : { opportunityId: current.id, hint },
        // Deux appels LLM avec retry : le délai par défaut est trop court.
        { timeoutMs: 120_000 },
      )

      if (!result.ok) {
        setDraft({ phase: 'error', message: describeSendError(result.error) })
        return
      }
      const payload = result.value as Record<string, unknown>
      if (payload['ok'] !== true) {
        setDraft({ phase: 'error', message: String(payload['error'] ?? 'échec') })
        return
      }
      if (payload['decision'] === 'decline') {
        // Un veto est un résultat : l'opportunité quitte la file, et on avance.
        setDraft({
          phase: 'declined',
          message: String(payload['reasoning'] ?? ''),
          costEur: Number(payload['costEur'] ?? 0),
        })
        await refresh()
        return
      }
      setDraft({
        phase: 'result',
        variants: payload['variants'] as DraftState extends { variants: infer V }
          ? V
          : never,
        selectedIndex: Number(payload['selectedIndex'] ?? 0),
        costEur: Number(payload['costEur'] ?? 0),
        escalated: payload['escalated'] === true,
        evRank: Number(payload['evRank'] ?? 0),
      })
      await refresh()
    },
    [current, refresh],
  )

  const reject = useCallback(async () => {
    if (!current) return
    const result = await send(MSG.OPPORTUNITY_REJECT, { opportunityId: current.id })
    if (!result.ok) {
      setError(describeSendError(result.error))
      return
    }
    setDraft({ phase: 'idle' })
    await refresh()
  }, [current, refresh])

  const move = useCallback(
    (delta: number) => {
      setDraft({ phase: 'idle' })
      setShowBreakdown(false)
      setIndex((previous) => {
        const next = previous + delta
        if (next < 0) return 0
        if (next >= cards.length) return Math.max(0, cards.length - 1)
        return next
      })
    },
    [cards.length],
  )

  const onAction = useCallback(
    (action: FluxAction) => {
      switch (action) {
        case 'approve':
          void requestDraft()
          return
        case 'edit':
          // `E` ouvre la rédaction avec une consigne : le champ prend le focus, et les
          // raccourcis y sont inertes.
          setDraft({ phase: 'hinting', opportunityId: current?.id ?? 0 })
          return
        case 'reject':
          void reject()
          return
        case 'next':
          move(1)
          return
        case 'previous':
          move(-1)
          return
        case 'open':
          if (current) window.open(current.permalink, '_blank', 'noopener')
          return
        case 'toggleBreakdown':
          setShowBreakdown((v) => !v)
          return
        case 'help':
          setShowHelp((v) => !v)
          return
        case 'dismiss':
          if (showHelp) setShowHelp(false)
          else if (draft.phase !== 'idle') setDraft({ phase: 'idle' })
          else setShowBreakdown(false)
          return
      }
    },
    [current, draft.phase, move, reject, requestDraft, showHelp],
  )

  useFluxKeyboard({ enabled: !loading, onAction })

  /* ── Rendu ──────────────────────────────────────────────────────────────── */

  if (loading) {
    return <p className="p-4 text-[11px] text-x-muted">Chargement de la file…</p>
  }

  if (showHelp) {
    return (
      <div className="p-3">
        <KeyboardHelp onClose={() => setShowHelp(false)} />
      </div>
    )
  }

  if (!current) {
    return <EmptyQueue stats={stats} onRefresh={() => void refresh()} error={error} />
  }

  return (
    <div className="space-y-3 p-3">
      {/* Position dans la file, et non barre de défilement : une décision par carte. */}
      <div className="flex items-baseline justify-between text-[10px] text-x-muted">
        <span>
          {index + 1} / {cards.length}
          {index === 0 && cards.length > 1 && ' · tête de file'}
        </span>
        <span className="font-mono">
          EV {(current.evScore * 100).toFixed(0)} %
          {index < 10 && <span className="ml-1 text-x-accent">★ top-10</span>}
        </span>
      </div>

      <article className="rounded-lg border border-x-border bg-x-surface p-3">
        <header className="flex items-baseline justify-between gap-2">
          <a
            href={current.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-x-accent hover:underline"
          >
            @{current.authorHandle}
          </a>
          <span className="font-mono text-[10px] text-x-muted">
            {current.ageMinutes} min · {current.metrics.replies} rép ·{' '}
            {current.metrics.likes} ♥
          </span>
        </header>

        <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed">
          {current.text}
        </p>

        <div className="mt-2 flex flex-wrap gap-2">
          <button
            onClick={() => void requestDraft()}
            className="rounded-full bg-x-accent px-3 py-1.5 text-[11px] font-semibold text-white"
          >
            Rédiger <kbd className="ml-1 opacity-70">A</kbd>
          </button>
          <button
            onClick={() => setDraft({ phase: 'hinting', opportunityId: current.id })}
            className="rounded-full border border-x-border px-3 py-1.5 text-[11px] hover:bg-x-surface-2"
          >
            Consigne <kbd className="ml-1 opacity-70">E</kbd>
          </button>
          <button
            onClick={() => void reject()}
            className="rounded-full border border-x-border px-3 py-1.5 text-[11px] hover:bg-x-surface-2"
          >
            Rejeter <kbd className="ml-1 opacity-70">R</kbd>
          </button>
          <button
            onClick={() => move(1)}
            className="rounded-full border border-x-border px-3 py-1.5 text-[11px] hover:bg-x-surface-2"
          >
            Suivant <kbd className="ml-1 opacity-70">Espace</kbd>
          </button>
        </div>

        <button
          onClick={() => setShowBreakdown((v) => !v)}
          className="mt-2 text-[10px] text-x-muted underline decoration-dotted hover:text-x-text"
          aria-expanded={showBreakdown}
        >
          {showBreakdown ? 'Masquer' : 'Pourquoi ce score ?'} <kbd>D</kbd>
        </button>

        {showBreakdown && current.explanation && (
          <ScoreBreakdownPanel explanation={current.explanation} />
        )}
      </article>

      <DraftResult
        state={draft}
        onSubmitHint={(hint) => void requestDraft(hint)}
        onDismiss={() => setDraft({ phase: 'idle' })}
        onNext={() => move(1)}
      />

      {error && <p className="text-[11px] text-x-danger">{error}</p>}

      <p className="text-[10px] text-x-muted">
        <kbd>?</kbd> raccourcis · <kbd>J</kbd>/<kbd>K</kbd> naviguer · <kbd>O</kbd> ouvrir
        sur X
      </p>
    </div>
  )
}

/**
 * File vide — quatre causes très différentes.
 *
 * Les confondre ferait chercher un bug là où il y a un réglage. Les statistiques les
 * distinguent : rien de trié, tout rejeté au triage, tout rejeté par le CRITIC, ou budget
 * épuisé.
 */
function EmptyQueue(props: {
  stats: (QueueStats & { budgetRemainingEur: number }) | null
  onRefresh: () => void
  error: string | null
}): React.ReactElement {
  const { stats } = props

  const diagnosis = ((): string => {
    if (props.error !== null) return props.error
    if (!stats || stats.total === 0) {
      return 'Rien n’a encore été trié. Ouvre x.com : le scout observe ce que tu vois, et le triage se déclenche par lots.'
    }
    if (stats.budgetRemainingEur <= 0.001) {
      return 'Budget quotidien épuisé. La file se remplira à nouveau demain, ou relève le budget dans Config.'
    }
    if (stats.qualifierRejectedRate > 0.9) {
      return `${(stats.qualifierRejectedRate * 100).toFixed(0)} % des posts vus sont rejetés au triage. Le seuil EV du pack est peut-être trop strict, ou la niche mal décrite.`
    }
    if (stats.expiredRate > 0.5) {
      return `${(stats.expiredRate * 100).toFixed(0)} % des opportunités ont expiré avant traitement. La file produit plus que tu ne consommes — abaisse les plafonds ou passe plus souvent.`
    }
    if (stats.criticRejectedRate > 0.6) {
      return `Le CRITIC rejette ${(stats.criticRejectedRate * 100).toFixed(0)} % des brouillons. C’est son travail, mais un taux aussi haut mérite de vérifier le Voice Profile.`
    }
    return 'Rien d’intéressant dans le fil pour l’instant. C’est un résultat valide : le produit préfère se taire.'
  })()

  return (
    <div className="space-y-3 p-4">
      <h2 className="text-sm font-semibold">File vide</h2>
      <p className="text-[11px] leading-relaxed text-x-text/80">{diagnosis}</p>

      {stats && stats.total > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <Row label="Vues au total" value={String(stats.total)} />
          <Row
            label="Rejet au triage"
            value={`${(stats.qualifierRejectedRate * 100).toFixed(0)} %`}
          />
          <Row
            label="Veto du CRITIC"
            value={`${(stats.criticRejectedRate * 100).toFixed(0)} %`}
          />
          <Row label="Expirées" value={`${(stats.expiredRate * 100).toFixed(0)} %`} />
          <Row
            label="Budget restant"
            value={`${stats.budgetRemainingEur.toFixed(3)} €`}
          />
        </dl>
      )}

      <button
        onClick={props.onRefresh}
        className="rounded-full border border-x-border px-3 py-1.5 text-[11px] hover:bg-x-surface-2"
      >
        Rafraîchir
      </button>
    </div>
  )
}

function Row(props: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-x-muted">{props.label}</dt>
      <dd className="font-mono text-x-text/80">{props.value}</dd>
    </div>
  )
}
