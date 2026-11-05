/**
 * Écran d'attente explicite.
 *
 * Préféré à un spinner ou une page blanche : pendant huit phases de développement, un
 * onglet vide fait douter du fonctionnement de l'extension. Un onglet qui annonce ce
 * qu'il fera et ce qui le bloque est un état honnête.
 */
export function PlaceholderTab(props: {
  title: string
  phase: string
  what: string
  blocked: string
}): React.ReactElement {
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">{props.title}</h2>
        <span className="rounded bg-x-surface-2 px-2 py-0.5 text-[10px] text-x-muted">
          {props.phase}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-x-text/80">{props.what}</p>
      <p className="border-l-2 border-x-border pl-3 text-[11px] leading-relaxed text-x-muted">
        {props.blocked}
      </p>
    </div>
  )
}
