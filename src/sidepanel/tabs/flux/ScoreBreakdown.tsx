/**
 * Décomposé du score — SPEC §6 : « le score avec son décomposé (cliquable, explicable) ».
 *
 * L'exigence n'est pas décorative. Un score opaque ne se règle pas : l'utilisateur qui voit
 * passer un post qu'il aurait voulu traiter doit lire *quel* facteur l'a écarté, et corriger
 * le poids correspondant. Sans ce panneau, les curseurs de l'onglet Config sont décoratifs.
 */
import type { ExplainedScore } from '@/scoring/explain'

export function ScoreBreakdownPanel(props: {
  explanation: ExplainedScore
}): React.ReactElement {
  const { explanation } = props

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-x-border bg-x-bg p-2.5">
      <p className="text-[11px] leading-relaxed text-x-text/80">{explanation.headline}</p>

      <ul className="space-y-1.5">
        {explanation.factors.map((factor) => (
          <li key={factor.key} className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span
                className={
                  factor.isVeto
                    ? 'text-x-danger'
                    : factor.isLimiting
                      ? 'text-x-warning'
                      : 'text-x-muted'
                }
              >
                {factor.label}
                {factor.isVeto && ' — annule'}
                {!factor.isVeto && factor.isLimiting && ' — frein'}
              </span>
              <span className="font-mono tabular-nums text-x-text/70">
                {factor.valuePct} %
                <span className="ml-1 text-[10px] text-x-muted">
                  (poids {factor.sharePct} %)
                </span>
              </span>
            </div>

            {/* La barre montre la valeur, la graduation montre le poids : deux informations
                distinctes que l'utilisateur doit pouvoir lire séparément. */}
            <div className="relative h-1 overflow-hidden rounded-full bg-x-surface-2">
              <div
                className={`h-full ${
                  factor.isVeto
                    ? 'bg-x-danger'
                    : factor.isLimiting
                      ? 'bg-x-warning'
                      : 'bg-x-accent'
                }`}
                style={{ width: `${factor.valuePct}%` }}
              />
              <div
                className="absolute top-0 h-full w-px bg-x-muted/50"
                style={{ left: `${factor.sharePct}%` }}
                aria-hidden
              />
            </div>

            <p className="text-[10px] leading-snug text-x-muted">{factor.reason}</p>
          </li>
        ))}
      </ul>

      {explanation.tuningHint && (
        <p className="border-l-2 border-x-border pl-2 text-[10px] leading-relaxed text-x-muted">
          {explanation.tuningHint}
        </p>
      )}
    </div>
  )
}
