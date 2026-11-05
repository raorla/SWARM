/**
 * Saisie de clé et déverrouillage du coffre (Phase 8).
 *
 * ## Ce que cet écran doit dire, et pas seulement demander
 *
 * Un champ « clé API » sans explication obtient une clé principale sans plafond. L'écran
 * énonce donc trois choses avant le champ : que la clé est chiffrée localement, que ça ne
 * protège pas d'un attaquant qui contrôle déjà la machine, et qu'il faut une clé dédiée avec
 * un plafond de dépense côté fournisseur. C'est la seule atténuation réelle du risque
 * résiduel, et elle est chez le fournisseur, pas ici.
 *
 * ## L'ordre des opérations n'est pas négociable
 *
 * `chrome.permissions.request` exige un geste utilisateur : il doit partir du gestionnaire de
 * clic, pas du service worker. La permission d'hôte est donc demandée **ici**, avant
 * d'envoyer la clé au background. L'ordre inverse échoue sans message d'erreur.
 */
import { useCallback, useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'
import type { SettingsStatus } from '@/background/settings.handler'
import type { ProviderId } from '@/llm/types'

/** Motif d'hôte par provider — doit rester aligné sur `optional_host_permissions`. */
const ORIGIN: Partial<Record<ProviderId, string>> = {
  openrouter: 'https://openrouter.ai/*',
  anthropic: 'https://api.anthropic.com/*',
  'openai-compatible': 'http://localhost/*',
}

export function ProviderPanel({
  status,
  onChanged,
}: {
  status: SettingsStatus | null
  onChanged: () => void
}): React.ReactElement {
  const [provider, setProvider] = useState<ProviderId>('openrouter')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434/v1')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const initialized = status?.keystore.initialized ?? false
  const unlocked = status?.keystore.unlocked ?? false
  const needsBaseUrl = provider === 'openai-compatible'

  // Le champ est vidé dès que la clé est partie : la laisser dans l'état du composant la
  // garderait en mémoire du panel sans raison, et un panel reste ouvert des heures.
  const clearSecrets = useCallback(() => {
    setApiKey('')
    setPassphrase('')
  }, [])

  const save = useCallback(async () => {
    setBusy(true)
    setMessage(null)

    // 1. Permission d'hôte, depuis le clic. Obligatoirement avant l'envoi.
    const origin = ORIGIN[provider]
    if (origin !== undefined) {
      const alreadyGranted = await chrome.permissions.contains({ origins: [origin] })
      if (!alreadyGranted) {
        const accepted = await chrome.permissions.request({ origins: [origin] })
        if (!accepted) {
          setBusy(false)
          setMessage({
            tone: 'error',
            text: 'Permission refusée : sans accès à cet hôte, aucun appel n’est possible.',
          })
          return
        }
      }
    }

    // 2. Puis la clé.
    const result = await send(MSG.KEYSTORE_SET_KEY, {
      providerId: provider,
      apiKey,
      passphrase,
      ...(needsBaseUrl ? { baseUrl } : {}),
    })
    setBusy(false)

    if (!result.ok) {
      setMessage({ tone: 'error', text: describeSendError(result.error) })
      return
    }
    const payload = result.value as { stored: boolean; error: string | null }
    if (!payload.stored) {
      setMessage({ tone: 'error', text: payload.error ?? 'Enregistrement refusé.' })
      return
    }
    clearSecrets()
    setMessage({ tone: 'ok', text: 'Clé enregistrée et coffre déverrouillé.' })
    onChanged()
  }, [apiKey, baseUrl, clearSecrets, needsBaseUrl, onChanged, passphrase, provider])

  const unlock = useCallback(async () => {
    setBusy(true)
    const result = await send(MSG.KEYSTORE_UNLOCK, { passphrase })
    setBusy(false)
    if (!result.ok) {
      setMessage({ tone: 'error', text: describeSendError(result.error) })
      return
    }
    const payload = result.value as { unlocked: boolean; error: string | null }
    setPassphrase('')
    setMessage(
      payload.unlocked
        ? { tone: 'ok', text: 'Coffre déverrouillé.' }
        : { tone: 'error', text: payload.error ?? 'Déverrouillage refusé.' },
    )
    onChanged()
  }, [onChanged, passphrase])

  const lock = useCallback(async () => {
    await send(MSG.KEYSTORE_LOCK, {})
    clearSecrets()
    setMessage({ tone: 'ok', text: 'Coffre verrouillé.' })
    onChanged()
  }, [clearSecrets, onChanged])

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Provider et clé</h2>
        <span className={`text-[10px] ${unlocked ? 'text-x-success' : 'text-x-muted'}`}>
          {initialized ? (unlocked ? 'coffre déverrouillé' : 'coffre verrouillé') : 'aucun coffre'}
        </span>
      </div>

      <p className="mt-1 text-xs text-x-muted">
        La clé est chiffrée localement (AES-GCM, dérivée de ta passphrase par PBKDF2) et n’est
        envoyée qu’au provider que tu choisis. Elle n’est jamais journalisée ni placée dans une
        URL.
      </p>
      <p className="mt-1 text-xs text-x-warning">
        Utilise une clé <strong>dédiée</strong>, avec un plafond de dépense côté fournisseur. Le
        chiffrement protège du vol du profil Chrome, pas d’un attaquant qui contrôle déjà cette
        machine.
      </p>

      {initialized && !unlocked ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void unlock()
          }}
        >
          <label className="block text-xs">
            Passphrase
            <input
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="mt-1 w-full rounded border border-x-border bg-x-bg px-2 py-1 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={busy || passphrase.length === 0}
            className="rounded-full bg-x-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Déverrouiller
          </button>
        </form>
      ) : (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label className="block text-xs">
            Provider
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderId)}
              className="mt-1 w-full rounded border border-x-border bg-x-bg px-2 py-1 text-sm"
            >
              {(status?.available ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          {needsBaseUrl && (
            <label className="block text-xs">
              URL de base
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="mt-1 w-full rounded border border-x-border bg-x-bg px-2 py-1 text-sm"
              />
              <span className="mt-0.5 block text-[10px] text-x-muted">
                Endpoint local : dans cette configuration, aucune donnée ne quitte ta machine.
              </span>
            </label>
          )}

          <label className="block text-xs">
            Clé API{needsBaseUrl && ' (facultative pour un endpoint local)'}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="mt-1 w-full rounded border border-x-border bg-x-bg px-2 py-1 font-mono text-sm"
            />
          </label>

          <label className="block text-xs">
            Passphrase du coffre
            <input
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="mt-1 w-full rounded border border-x-border bg-x-bg px-2 py-1 text-sm"
            />
            <span className="mt-0.5 block text-[10px] text-x-muted">
              {initialized
                ? 'Celle du coffre existant.'
                : 'Choisis-la maintenant : elle n’est stockée nulle part et ne peut pas être récupérée.'}
            </span>
          </label>

          <button
            type="submit"
            disabled={busy || passphrase.length < 8}
            className="rounded-full bg-x-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            {initialized ? 'Enregistrer la clé' : 'Créer le coffre'}
          </button>
        </form>
      )}

      {message !== null && (
        <p
          className={`mt-2 text-xs ${message.tone === 'ok' ? 'text-x-success' : 'text-x-danger'}`}
          role={message.tone === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}

      {(status?.keystore.providers.length ?? 0) > 0 && (
        <p className="mt-2 text-[11px] text-x-muted">
          Configurés : {status?.keystore.providers.join(', ')}
        </p>
      )}

      {unlocked && (
        <button
          type="button"
          onClick={() => void lock()}
          className="mt-2 text-[11px] text-x-muted underline hover:text-x-text"
        >
          verrouiller maintenant
        </button>
      )}

      <p className="mt-2 text-[10px] text-x-muted">
        Le déverrouillage vaut pour la session du navigateur (8 h maximum) et disparaît à sa
        fermeture.
      </p>
    </section>
  )
}
