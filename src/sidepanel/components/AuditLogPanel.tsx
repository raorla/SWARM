/**
 * Journal d'audit visible (Phase 4, SPEC §4.6 — « journal d'audit inaltérable »).
 *
 * Deux choix d'affichage qui portent la promesse :
 *
 *  1. **L'état de la chaîne est en tête**, pas en pied de page. « Inaltérable » n'a de sens
 *     que si la vérification est visible ; reléguée en bas, personne ne la lit et la propriété
 *     ne sert à rien.
 *  2. **Les refus sont affichés au même rang que les actions.** Un journal qui ne montrerait
 *     que ce qui a été fait cacherait le travail du governor — or c'est précisément ce que
 *     l'utilisateur a besoin de voir pour lui faire confiance : le plafond a coupé, le sujet
 *     a été écarté, la cadence a retardé.
 */
import { useCallback, useEffect, useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'
import type { AuditListing } from '@/background/audit.handler'
import type { AuditEntry, AuditEventType } from '@/governor/audit'

const EVENT_LABEL: Record<AuditEventType, string> = {
  'permit.granted': 'autorisation accordée',
  'permit.denied': 'action refusée',
  'action.staged': 'brouillon mis en scène',
  'action.published': 'publication constatée',
  'action.abandoned': 'brouillon abandonné',
  'killswitch.engaged': 'arrêt d’urgence',
  'killswitch.released': 'reprise',
  'budget.exhausted': 'budget épuisé',
  'selector.broken': 'sélecteur cassé',
  'critic.rejected': 'veto du CRITIC',
  'config.changed': 'réglage modifié',
  'mode.changed': 'mode modifié',
}

/** Les événements qui méritent l'œil : refus, arrêts, ruptures. */
const NOTABLE: ReadonlySet<AuditEventType> = new Set([
  'permit.denied',
  'killswitch.engaged',
  'budget.exhausted',
  'selector.broken',
])

export function AuditLogPanel(): React.ReactElement {
  const [listing, setListing] = useState<AuditListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const refresh = useCallback(async () => {
    const result = await send(MSG.AUDIT_LIST, { limit: 100 })
    if (!result.ok) {
      if (result.error.kind !== 'no-receiver') setError(describeSendError(result.error))
      return
    }
    setError(null)
    setListing(result.value as AuditListing)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const shown = expanded ? (listing?.entries ?? []) : (listing?.entries ?? []).slice(0, 8)

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[10px] uppercase tracking-wider text-x-muted">Journal d’audit</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-[10px] text-x-muted underline hover:text-x-text"
        >
          rafraîchir
        </button>
      </div>

      {error !== null && <p className="mt-1 text-xs text-x-danger">{error}</p>}

      {listing !== null && (
        <p
          className={`mt-1 text-xs ${listing.chain.valid ? 'text-x-muted' : 'text-x-danger'}`}
          role={listing.chain.valid ? undefined : 'alert'}
        >
          {listing.chainLabel}
        </p>
      )}

      <ol className="mt-2 space-y-1">
        {shown.map((entry) => (
          <AuditRow key={entry.hash} entry={entry} />
        ))}
      </ol>

      {(listing?.entries.length ?? 0) > 8 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-[11px] text-x-muted underline hover:text-x-text"
          aria-expanded={expanded}
        >
          {expanded
            ? 'réduire'
            : `voir les ${(listing?.entries.length ?? 0) - 8} entrées suivantes`}
        </button>
      )}
    </section>
  )
}

function AuditRow({ entry }: { entry: AuditEntry }): React.ReactElement {
  const notable = NOTABLE.has(entry.type)
  return (
    <li className="flex items-baseline gap-2 text-[11px]">
      <span className="w-11 shrink-0 tabular-nums text-x-muted">{formatTime(entry.atMs)}</span>
      <span className={`shrink-0 ${notable ? 'text-x-warning' : 'text-x-text'}`}>
        {EVENT_LABEL[entry.type] ?? entry.type}
      </span>
      <span className="truncate text-x-muted">
        {entry.actor}
        {entry.denialReason !== undefined && ` · ${entry.denialReason}`}
        {entry.detail !== undefined && ` · ${entry.detail}`}
        {entry.tokenCost !== undefined && ` · ${entry.tokenCost.eur.toFixed(4)} €`}
      </span>
    </li>
  )
}

/**
 * Heure locale, sans date.
 *
 * `Intl` plutôt qu'un formatage maison : le fuseau et le format 12/24 h viennent du système,
 * et un journal qui affiche une heure décalée fait douter de son contenu.
 */
export function formatTime(atMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(atMs))
}
