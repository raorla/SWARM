/**
 * Aide clavier.
 *
 * Générée depuis `FLUX_BINDINGS`, donc toujours exacte : une aide écrite à la main finit
 * toujours par mentir sur les raccourcis réels.
 */
import { keyboardHelp } from '../../hooks/useFluxKeyboard'

export function KeyboardHelp(props: { onClose: () => void }): React.ReactElement {
  return (
    <div className="rounded-lg border border-x-border bg-x-surface p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-semibold">Raccourcis</h3>
        <button
          onClick={props.onClose}
          className="text-[10px] text-x-muted hover:text-x-text"
          aria-label="Fermer l’aide"
        >
          Échap
        </button>
      </div>
      <dl className="space-y-1">
        {keyboardHelp().map((row) => (
          <div key={row.label} className="flex justify-between gap-3 text-[11px]">
            <dt className="font-mono text-x-accent">{row.keys}</dt>
            <dd className="text-x-muted">{row.label}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[10px] leading-relaxed text-x-muted">
        Les raccourcis sont inertes dans une zone de saisie : taper « r » dans une note ne
        rejette rien.
      </p>
    </div>
  )
}
