/**
 * Plafonds, cadence et fenêtre active (Phase 4).
 *
 * ## Le principe de cet écran : on peut resserrer, pas desserrer
 *
 * Les champs acceptent de descendre sous les valeurs par défaut et refusent de monter au-delà
 * des maximums de la spec. Ce n'est pas de la défiance envers l'utilisateur : c'est que la
 * valeur du produit repose sur ces bornes. Une extension qui laisse régler « 300 réponses par
 * jour » est un outil de spam avec un score EV, et le score ne rachète rien.
 *
 * Le service worker borne de nouveau à la réception (`settings.handler.ts`) : l'attribut
 * `max` d'un `<input>` n'est pas un contrôle, c'est une indication.
 */
import { useCallback, useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'
import type { SettingsStatus } from '@/background/settings.handler'
import { HARD_LIMITS } from '@/background/settings.handler'

export function GuardrailsPanel({
  status,
  onChanged,
}: {
  status: SettingsStatus | null
  onChanged: () => void
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const config = status?.config ?? null

  const apply = useCallback(
    async (patch: Record<string, number | string>) => {
      setBusy(true)
      const result = await send(MSG.SETTINGS_UPDATE, patch)
      setBusy(false)
      if (!result.ok) {
        setNote(describeSendError(result.error))
        return
      }
      const payload = result.value as { clamped: string[] }
      // Un réglage ramené silencieusement serait un mensonge d'interface : l'utilisateur
      // croirait avoir réglé ce qu'il a tapé.
      setNote(payload.clamped.length > 0 ? payload.clamped.join(' · ') : null)
      onChanged()
    },
    [onChanged],
  )

  if (config === null) {
    return (
      <section className="rounded-lg border border-x-border bg-x-surface p-3">
        <p className="text-sm text-x-muted">Lecture des réglages…</p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <h2 className="text-sm font-medium">Plafonds et cadence</h2>
      <p className="mt-1 text-xs text-x-muted">
        Ces valeurs peuvent être abaissées, jamais relevées au-delà du maximum. Les follows et
        les DM sont à zéro par conception : le produit ne les fait pas.
      </p>

      <div className="mt-3 space-y-3">
        <NumberField
          label="Réponses par jour"
          value={config.caps['reply'] ?? 25}
          min={0}
          max={HARD_LIMITS.reply}
          disabled={busy}
          onCommit={(v) => void apply({ capReply: v })}
        />
        <NumberField
          label="Posts par jour"
          value={config.caps['post'] ?? 3}
          min={0}
          max={HARD_LIMITS.post}
          disabled={busy}
          onCommit={(v) => void apply({ capPost: v })}
        />
        <NumberField
          label="Budget quotidien (€)"
          value={config.budget.dailyEur}
          min={0}
          max={HARD_LIMITS.budgetEur}
          step={0.5}
          disabled={busy}
          onCommit={(v) => void apply({ dailyBudgetEur: v })}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Cadence min (min)"
            value={config.cadence.minMinutes}
            min={HARD_LIMITS.cadenceMinMinutes}
            max={120}
            disabled={busy}
            onCommit={(v) => void apply({ cadenceMinMinutes: v })}
          />
          <NumberField
            label="Cadence max (min)"
            value={config.cadence.maxMinutes}
            min={config.cadence.minMinutes + 1}
            max={240}
            disabled={busy}
            onCommit={(v) => void apply({ cadenceMaxMinutes: v })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <TimeField
            label="Début de fenêtre"
            minutes={config.window.startMinute}
            disabled={busy}
            onCommit={(v) => void apply({ windowStartMinute: v })}
          />
          <TimeField
            label="Fin de fenêtre"
            minutes={config.window.endMinute}
            disabled={busy}
            onCommit={(v) => void apply({ windowEndMinute: v })}
          />
        </div>
        <NumberField
          label="Rétention du texte brut (jours)"
          value={config.retentionDays}
          min={1}
          max={365}
          disabled={busy}
          onCommit={(v) => void apply({ retentionDays: v })}
        />
        <NumberField
          label="Seuil de veto du CRITIC"
          value={config.criticVetoThreshold}
          min={0}
          max={1}
          step={0.05}
          disabled={busy}
          onCommit={(v) => void apply({ criticVetoThreshold: v })}
          hint="Plus haut = plus sévère. Un seuil trop haut refuse tout, un seuil trop bas ne protège de rien."
        />
      </div>

      <p className="mt-3 text-[11px] text-x-muted">
        Mode actuel : <strong>{config.mode}</strong>. Le passage en autopilote a son propre
        écran de consentement — il ne se règle pas ici.
      </p>

      {note !== null && (
        <p className="mt-2 text-xs text-x-warning" role="status">
          {note}
        </p>
      )}
    </section>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onCommit,
  hint,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  disabled: boolean
  onCommit: (value: number) => void
  hint?: string
}): React.ReactElement {
  const [draft, setDraft] = useState(String(value))

  return (
    <label className="block text-xs">
      <span className="flex items-baseline justify-between gap-2">
        {label}
        <span className="text-[10px] text-x-muted">max {max}</span>
      </span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        // Commit au `blur` et à Entrée, pas à chaque frappe : écrire en base à chaque
        // caractère produirait des valeurs intermédiaires absurdes (« 2 » en tapant « 25 »).
        onBlur={() => commit(draft, value, onCommit)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(draft, value, onCommit)
        }}
        className="mt-1 w-full rounded border border-x-border bg-x-bg px-2 py-1 text-sm tabular-nums"
      />
      {hint !== undefined && (
        <span className="mt-0.5 block text-[10px] text-x-muted">{hint}</span>
      )}
    </label>
  )
}

function commit(draft: string, current: number, onCommit: (v: number) => void): void {
  const parsed = Number(draft)
  if (!Number.isFinite(parsed) || parsed === current) return
  onCommit(parsed)
}

/** Minutes depuis minuit ↔ `HH:MM`. Un utilisateur pense en heures, le governor en minutes. */
function TimeField({
  label,
  minutes,
  disabled,
  onCommit,
}: {
  label: string
  minutes: number
  disabled: boolean
  onCommit: (minutes: number) => void
}): React.ReactElement {
  const [draft, setDraft] = useState(toHhMm(minutes))

  return (
    <label className="block text-xs">
      {label}
      <input
        type="time"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const parsed = fromHhMm(draft)
          if (parsed !== null && parsed !== minutes) onCommit(parsed)
        }}
        className="mt-1 w-full rounded border border-x-border bg-x-bg px-2 py-1 text-sm tabular-nums"
      />
    </label>
  )
}

export function toHhMm(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function fromHhMm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}
