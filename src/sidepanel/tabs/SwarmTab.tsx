/**
 * Onglet Swarm — le cockpit (SPEC §6).
 *
 * Objectif de conception : « doit ressembler à un cockpit, pas à un spinner ». Ce qui est
 * affiché doit être exact — un cockpit qui montre des valeurs inventées est pire qu'un écran
 * vide, parce qu'on s'y fie.
 *
 * L'ordre suit ce qu'on regarde en cas de doute : où en est le swarm, combien il a dépensé,
 * combien de coups il lui reste, comment l'arrêter, et enfin ce qu'il a réellement fait — le
 * journal d'audit, avec l'état de sa chaîne de hashs.
 */
import { useCallback, useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'
import { t } from '@/shared/i18n'
import { useSwarmState } from '../hooks/useSwarmState'
import { KillSwitchButton } from '../components/KillSwitchButton'
import { BudgetGauge } from '../components/BudgetGauge'
import { CapCounters } from '../components/CapCounters'
import { LlmSelfTest } from '../components/LlmSelfTest'
import { AuditLogPanel } from '../components/AuditLogPanel'

const MODE_LABEL: Record<string, string> = {
  simulation: 'mode.simulation',
  copilot: 'mode.copilot',
  autopilot: 'mode.autopilot',
}

export function SwarmTab(): React.ReactElement {
  const { state, error, loading, refresh } = useSwarmState()
  const [actionError, setActionError] = useState<string | null>(null)

  const halted = state?.governanceState === 'halted'

  const onKill = useCallback(async () => {
    const r = await send(MSG.KILL_SWITCH, { reason: 'side panel' })
    setActionError(r.ok ? null : describeSendError(r.error))
    await refresh()
  }, [refresh])

  const onResume = useCallback(async () => {
    const r = await send(MSG.RESUME, {})
    setActionError(r.ok ? null : describeSendError(r.error))
    await refresh()
  }, [refresh])

  return (
    <div className="space-y-4 p-3">
      <section className="rounded-lg border border-x-border bg-x-surface p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-x-muted">État</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span
                aria-hidden
                className={`inline-block h-2 w-2 rounded-full ${
                  halted
                    ? 'bg-x-danger'
                    : state?.governanceState === 'nominal'
                      ? 'bg-x-success'
                      : 'bg-x-warning'
                }`}
              />
              <span className="text-sm font-medium">
                {loading ? '…' : (state?.pipelineState ?? 'inconnu')}
              </span>
            </div>
          </div>
          {state && (
            <span className="rounded bg-x-surface-2 px-2 py-1 text-[10px] text-x-muted">
              {t(MODE_LABEL[state.mode] ?? 'mode.copilot')}
            </span>
          )}
        </div>

        {state?.mode === 'simulation' && (
          <p className="mt-3 rounded border border-x-warning/30 bg-x-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-x-warning">
            Mode simulation : le governor refuse toute action réelle. C'est le défaut en
            développement — un opt-in explicite est requis pour agir sur un vrai compte.
          </p>
        )}
      </section>

      {state && (
        <BudgetGauge spentEur={state.spentTodayEur} budgetEur={state.budgetEur} />
      )}
      {state && <CapCounters caps={state.caps} />}

      <KillSwitchButton engaged={halted} onEngage={onKill} onRelease={onResume} />

      <LlmSelfTest />

      <AuditLogPanel />

      {(error ?? actionError) && (
        <p className="rounded border border-x-danger/30 bg-x-danger/10 px-2 py-1.5 text-[11px] text-x-danger">
          {error ?? actionError}
        </p>
      )}
    </div>
  )
}
