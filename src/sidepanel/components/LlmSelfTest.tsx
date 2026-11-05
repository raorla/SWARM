/**
 * Test d'appel LLM — c'est le DoD de la Phase 0 rendu cliquable.
 *
 * Il affiche `cacheRead` en évidence, et pas par souci d'exhaustivité : c'est la mesure
 * qui tranche FEEDBACK R-03. Deux appels successifs avec le même préfixe système doivent
 * faire monter ce compteur. S'il reste à zéro, OpenRouter ne propage pas le cache de
 * prompt, et tout le chiffrage à 1 €/jour doit être révisé — WRITER et CRITIC basculent
 * alors sur Anthropic en direct.
 */
import { useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'

interface SelfTestResult {
  ok: boolean
  text?: string
  costEur?: number
  usage?: { input: number; output: number; cacheRead: number }
  model?: string
  error?: string
}

export function LlmSelfTest(): React.ReactElement {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SelfTestResult | null>(null)

  const run = async (): Promise<void> => {
    setRunning(true)
    setResult(null)
    const r = await send(MSG.LLM_SELFTEST, {
      prompt: 'Confirme en une phrase que la connexion fonctionne.',
    })
    setRunning(false)
    setResult(
      r.ok
        ? (r.value as SelfTestResult)
        : { ok: false, error: describeSendError(r.error) },
    )
  }

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-x-muted">
          Test de connexion LLM
        </span>
        <button
          onClick={() => void run()}
          disabled={running}
          className="rounded-full border border-x-border px-2.5 py-1 text-[11px] hover:bg-x-surface-2 disabled:opacity-50"
        >
          {running ? 'Appel…' : 'Lancer'}
        </button>
      </div>

      {result?.ok && (
        <div className="space-y-2">
          <p className="rounded bg-x-surface-2 px-2 py-1.5 text-[11px] leading-relaxed">
            {result.text}
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-x-muted">
            <div className="flex justify-between">
              <dt>modèle</dt>
              <dd className="text-x-text/70">{result.model}</dd>
            </div>
            <div className="flex justify-between">
              <dt>coût</dt>
              <dd className="text-x-text/70">{result.costEur?.toFixed(6)} €</dd>
            </div>
            <div className="flex justify-between">
              <dt>in / out</dt>
              <dd className="text-x-text/70">
                {result.usage?.input} / {result.usage?.output}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>cache lu</dt>
              <dd
                className={
                  (result.usage?.cacheRead ?? 0) > 0 ? 'text-x-success' : 'text-x-warning'
                }
              >
                {result.usage?.cacheRead ?? 0}
              </dd>
            </div>
          </dl>
          {(result.usage?.cacheRead ?? 0) === 0 && (
            <p className="text-[10px] leading-relaxed text-x-muted">
              Cache à zéro : normal au premier appel. Relance pour vérifier qu'il monte —
              c'est ce qui tranche FEEDBACK R-03.
            </p>
          )}
        </div>
      )}

      {result && !result.ok && (
        <p className="text-[11px] leading-relaxed text-x-danger">{result.error}</p>
      )}
    </section>
  )
}
