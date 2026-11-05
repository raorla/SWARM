/**
 * Jauge de budget — SPEC §3.2 et §3.3.
 *
 * Affiche la réserve qualité comme une zone distincte, pas comme une simple fraction :
 * l'utilisateur doit voir que les derniers 25 % ne sont pas dépensables par le triage.
 * Un plafond invisible est un plafond qu'on croit avoir dépassé par erreur.
 */
import { t } from '@/shared/i18n'

const RESERVE_FRACTION = 0.25

export function BudgetGauge(props: {
  spentEur: number
  budgetEur: number
}): React.ReactElement {
  const budget = props.budgetEur > 0 ? props.budgetEur : 1
  const spentRatio = Math.min(1, props.spentEur / budget)
  const generalCeiling = 1 - RESERVE_FRACTION
  const overGeneral = spentRatio > generalCeiling

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-x-muted">
          {t('budget.today')}
        </span>
        <span className="font-mono text-xs">
          {props.spentEur.toFixed(4)} € / {props.budgetEur.toFixed(2)} €
        </span>
      </div>

      <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-x-surface-2">
        {/* Frontière de la réserve qualité, visible même à zéro dépensé. */}
        <div
          className="absolute top-0 z-10 h-full w-px bg-x-muted/60"
          style={{ left: `${generalCeiling * 100}%` }}
          aria-hidden
        />
        <div
          className={`h-full transition-all ${overGeneral ? 'bg-x-warning' : 'bg-x-accent'}`}
          style={{ width: `${spentRatio * 100}%` }}
        />
      </div>

      <div className="mt-1.5 flex justify-between text-[10px] text-x-muted">
        <span>
          {t('budget.reserved')} : {(budget * RESERVE_FRACTION).toFixed(2)} €
        </span>
        <span>
          {t('budget.remaining')} : {Math.max(0, budget - props.spentEur).toFixed(4)} €
        </span>
      </div>
    </section>
  )
}
