/**
 * Kill switch — SPEC §2.3.
 *
 * Accessible en un clic, sans confirmation : une confirmation sur un bouton d'arrêt
 * d'urgence est une friction au pire moment. La confirmation est demandée à la
 * *reprise*, qui est l'action risquée.
 */
import { t } from '@/shared/i18n'

export function KillSwitchButton(props: {
  engaged: boolean
  onEngage: () => Promise<void>
  onRelease: () => Promise<void>
}): React.ReactElement {
  if (props.engaged) {
    return (
      <section className="rounded-lg border border-x-danger/40 bg-x-danger/10 p-3">
        <div className="text-xs font-medium text-x-danger">{t('killswitch.engaged')}</div>
        <button
          onClick={() => void props.onRelease()}
          className="mt-2 w-full rounded-full border border-x-border bg-x-surface px-3 py-2 text-xs font-medium hover:bg-x-surface-2"
        >
          Reprendre le swarm
        </button>
      </section>
    )
  }

  return (
    <button
      onClick={() => void props.onEngage()}
      className="w-full rounded-full bg-x-danger px-3 py-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
      title="Alt+Shift+K"
    >
      {t('killswitch.label')} · Alt+Shift+K
    </button>
  )
}
