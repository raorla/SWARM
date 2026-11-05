/**
 * Compteurs de plafonds — SPEC §2.1.
 *
 * On affiche aussi les plafonds à zéro (follow, DM) : leur présence visible est ce qui
 * rend l'engagement produit vérifiable par l'utilisateur, plutôt que promis dans un
 * fichier qu'il ne lira pas.
 */
const LABELS: Record<string, string> = {
  reply: 'Réponses',
  post: 'Posts',
  thread: 'Threads',
  like: 'Likes',
  bookmark: 'Bookmarks',
  follow: 'Follows',
  dm: 'DM',
}

export function CapCounters(props: {
  caps: Record<string, { used: number; cap: number }>
}): React.ReactElement {
  const rows = Object.entries(props.caps)
  if (rows.length === 0) return <></>

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-x-muted">
        Plafonds du jour
      </div>
      <ul className="space-y-1.5">
        {rows.map(([action, { used, cap }]) => {
          const disabled = cap === 0
          const ratio = cap > 0 ? Math.min(1, used / cap) : 0
          return (
            <li key={action} className="flex items-center gap-2 text-[11px]">
              <span className={`w-20 ${disabled ? 'text-x-muted/60' : 'text-x-text/80'}`}>
                {LABELS[action] ?? action}
              </span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-x-surface-2">
                <div
                  className={`h-full ${ratio >= 1 ? 'bg-x-warning' : 'bg-x-accent'}`}
                  style={{ width: `${ratio * 100}%` }}
                />
              </div>
              <span className="w-14 text-right font-mono text-x-muted">
                {disabled ? 'désactivé' : `${used}/${cap}`}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
