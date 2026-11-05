/**
 * Panneau Voice Profile de l'onglet Config.
 *
 * Ce panneau a une responsabilité qui dépasse l'affichage : **dire la vérité sur ce que le
 * produit sait faire**. Un profil faible ou largement écarté par les garde-fous doit être
 * lisible ici, sinon l'utilisateur attribuera au CRITIC des rejets qui viennent de son
 * corpus. C'est le seul endroit où `guardExcludedRatio` (MH-18) devient une information
 * actionnable plutôt qu'un champ de base.
 */
import { useCallback, useEffect, useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'

interface ProfileStatus {
  exists: boolean
  handle: string | null
  sampleSize: number
  passingGuard: number
  guardExcludedRatio: number
  confidence: number
  usable: boolean
  builtAtMs: number | null
  ageMs: number | null
  newPostsSinceBuild: number
  stale: boolean
  staleReason: string | null
  summary: string
}

interface CollectionProgress {
  collected: number
  scrolls: number
  elapsedMs: number
  stopReason: string | null
}

const DAY_MS = 86_400_000

export function VoiceProfilePanel(): React.ReactElement {
  const [status, setStatus] = useState<ProfileStatus | null>(null)
  const [progress, setProgress] = useState<CollectionProgress | null>(null)
  const [busy, setBusy] = useState<'none' | 'collecting' | 'rebuilding'>('none')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await send(MSG.VOICE_PROFILE_STATUS, {})
    if (!result.ok) {
      // Un service worker endormi se réveille au message suivant : ne pas alarmer.
      if (result.error.kind !== 'no-receiver') setError(describeSendError(result.error))
      return
    }
    setError(null)
    setStatus(result.value as ProfileStatus)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // La progression de collecte arrive en diffusion depuis le content script : une collecte
  // silencieuse serait indistinguable d'un scraper (SPEC §4.1).
  useEffect(() => {
    const listener = (raw: unknown): void => {
      const msg = raw as { type?: string; payload?: CollectionProgress }
      if (msg.type === MSG.COLLECTION_PROGRESS && msg.payload) setProgress(msg.payload)
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  const startCollection = useCallback(async () => {
    setBusy('collecting')
    setMessage(null)
    setProgress(null)

    // La collecte tourne dans l'onglet X, pas ici : il faut un onglet actif sur x.com.
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
      url: ['https://x.com/*', 'https://twitter.com/*'],
    })

    if (!tab?.id) {
      setBusy('none')
      setMessage(
        'Ouvre ton profil X dans l’onglet actif, puis relance. La collecte parcourt la page que tu vois.',
      )
      return
    }

    const result = await send(
      MSG.START_COLLECTION,
      {},
      { tabId: tab.id, timeoutMs: 300_000 },
    )
    setBusy('none')

    if (!result.ok) {
      setError(describeSendError(result.error))
      return
    }
    const payload = result.value as {
      started: boolean
      reason?: string
      message?: string
    }
    setMessage(
      payload.started
        ? (payload.message ?? 'Collecte terminée.')
        : (payload.reason ?? null),
    )
    await refresh()
  }, [refresh])

  const rebuild = useCallback(async () => {
    setBusy('rebuilding')
    const result = await send(MSG.VOICE_PROFILE_REBUILD, {})
    setBusy('none')
    if (!result.ok) {
      setError(describeSendError(result.error))
      return
    }
    const payload = result.value as { built: boolean; reason?: string }
    setMessage(
      payload.built
        ? 'Profil reconstruit.'
        : (payload.reason ?? 'Reconstruction impossible.'),
    )
    await refresh()
  }, [refresh])

  return (
    <section className="space-y-3 rounded-lg border border-x-border bg-x-surface p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold">Voice Profile</h3>
        <span className="text-[10px] text-x-muted">
          {status?.handle ? `@${status.handle}` : 'aucun handle'}
        </span>
      </div>

      {status && (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <Row label="Corpus" value={`${status.sampleSize} posts`} />
            <Row label="Exploitables" value={`${status.passingGuard} posts`} />
            <Row
              label="Confiance"
              value={`${(status.confidence * 100).toFixed(0)} %`}
              warn={status.confidence < 0.25}
            />
            <Row
              label="Écarté"
              value={`${(status.guardExcludedRatio * 100).toFixed(0)} %`}
              warn={status.guardExcludedRatio > 0.5}
            />
            {status.builtAtMs !== null && (
              <Row
                label="Construit"
                value={`il y a ${Math.max(0, Math.round((status.ageMs ?? 0) / DAY_MS))} j`}
                warn={status.staleReason === 'age'}
              />
            )}
            {status.newPostsSinceBuild > 0 && (
              <Row
                label="Nouveaux"
                value={`+${status.newPostsSinceBuild}`}
                warn={status.staleReason === 'nouveaux-posts'}
              />
            )}
          </dl>

          {/*
            Le diagnostic honnête. Un profil dont 90 % du corpus est écarté doit le dire :
            sinon l'utilisateur attribuera au CRITIC des rejets qui viennent de son corpus.
          */}
          {status.guardExcludedRatio > 0.5 && (
            <p className="rounded border border-x-warning/30 bg-x-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-x-warning">
              {(status.guardExcludedRatio * 100).toFixed(0)} % de ton corpus est écarté
              par les garde-fous du produit. La voix native de ce compte est largement non
              reproductible : SWARM écrira dans ton registre de forme, pas dans ton
              registre promotionnel.
            </p>
          )}

          {!status.usable && status.sampleSize > 0 && (
            <p className="rounded border border-x-warning/30 bg-x-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-x-warning">
              Profil insuffisant pour imiter un style. Le WRITER écrit en registre neutre
              et le CRITIC est plus sévère — c’est le comportement correct, pas un
              dysfonctionnement.
            </p>
          )}

          {status.stale && status.staleReason !== 'absent' && (
            <p className="text-[11px] leading-relaxed text-x-muted">
              Profil à reprendre :{' '}
              {status.staleReason === 'age'
                ? 'il a vieilli'
                : 'ta production récente n’y est pas'}
              .
            </p>
          )}
        </>
      )}

      {progress && busy === 'collecting' && (
        <div className="rounded bg-x-surface-2 px-2 py-1.5 text-[11px] font-mono text-x-muted">
          {progress.collected} posts · {progress.scrolls} défilements ·{' '}
          {Math.round(progress.elapsedMs / 1000)} s
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void startCollection()}
          disabled={busy !== 'none'}
          className="rounded-full bg-x-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
          title="Parcourt ton profil, borné et interruptible"
        >
          {busy === 'collecting' ? 'Collecte…' : 'Collecter mes posts'}
        </button>
        <button
          onClick={() => void rebuild()}
          disabled={busy !== 'none' || (status?.sampleSize ?? 0) === 0}
          className="rounded-full border border-x-border px-3 py-1.5 text-[11px] hover:bg-x-surface-2 disabled:opacity-50"
        >
          {busy === 'rebuilding' ? 'Reconstruction…' : 'Re-entraîner'}
        </button>
      </div>

      <p className="text-[10px] leading-relaxed text-x-muted">
        La collecte ne fonctionne que sur ton propre profil, et elle est bornée : 200
        posts, 60 défilements, 4 minutes. Elle s’arrête si tu quittes la page.
      </p>

      {message && <p className="text-[11px] text-x-text/80">{message}</p>}
      {error && <p className="text-[11px] text-x-danger">{error}</p>}
    </section>
  )
}

function Row(props: {
  label: string
  value: string
  warn?: boolean
}): React.ReactElement {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-x-muted">{props.label}</dt>
      <dd className={`font-mono ${props.warn ? 'text-x-warning' : 'text-x-text/80'}`}>
        {props.value}
      </dd>
    </div>
  )
}
