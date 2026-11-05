/**
 * Sauvegarde chiffrée et restauration (MH-06).
 *
 * ## Pourquoi cet écran est une fonction de sécurité et pas un confort
 *
 * « Local-first » veut aussi dire « aucune sauvegarde ailleurs ». Un profil Chrome corrompu,
 * une réinstallation, un disque changé : tout disparaît — corpus de voix, mesures, patterns,
 * journal d'audit. Il n'y a personne à qui le redemander. C'est le revers exact de l'absence
 * de serveur, et le seul remède est un export que l'utilisateur pense à faire.
 *
 * ## Deux choix d'implémentation
 *
 *  1. **L'export se fait dans le panel, pas dans le service worker.** Une sauvegarde complète
 *     pèse plusieurs mégaoctets ; la faire traverser `chrome.runtime.sendMessage` la
 *     sérialiserait deux fois pour rien. Le panel accède au même IndexedDB.
 *  2. **La restauration exige un mot recopié.** Elle est destructive par conception (voir
 *     `db/backup.ts` : fusionner deux historiques produirait des doublons et des patterns
 *     comptés deux fois). Un `confirm()` se clique sans lire.
 */
import { useCallback, useState } from 'react'
import { db } from '@/db'
import { decryptBackup, exportEncrypted, restoreBackup } from '@/db/backup'
import { systemClock } from '@/shared/time'
import { buildInfo } from '@/shared/env'

const RESTORE_WORD = 'REMPLACER'

export function BackupPanel(): React.ReactElement {
  const [passphrase, setPassphrase] = useState('')
  const [confirmWord, setConfirmWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const exportNow = useCallback(async () => {
    if (passphrase.length < 8) {
      setMessage({ tone: 'error', text: 'Passphrase de sauvegarde trop courte (8 minimum).' })
      return
    }
    setBusy(true)
    try {
      const blob = await exportEncrypted(db(), systemClock, buildInfo.version, passphrase)
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(blob)], { type: 'application/json' }),
      )
      const anchor = document.createElement('a')
      anchor.href = url
      // Nom horodaté : deux exports du même jour ne doivent pas s'écraser dans le dossier de
      // téléchargements.
      anchor.download = `swarm-backup-${stamp(systemClock.now())}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      setPassphrase('')
      setMessage({
        tone: 'ok',
        text: 'Export chiffré téléchargé. Sans cette passphrase, il est irrécupérable — note-la.',
      })
    } catch (e) {
      setMessage({ tone: 'error', text: `Export impossible : ${describe(e)}` })
    } finally {
      setBusy(false)
    }
  }, [passphrase])

  const importNow = useCallback(
    async (file: File) => {
      if (confirmWord.trim().toUpperCase() !== RESTORE_WORD) {
        setMessage({
          tone: 'error',
          text: `Recopie « ${RESTORE_WORD} » avant de restaurer : l’opération écrase les données actuelles.`,
        })
        return
      }
      if (passphrase.length === 0) {
        setMessage({ tone: 'error', text: 'Passphrase de la sauvegarde requise.' })
        return
      }

      setBusy(true)
      try {
        const parsed = JSON.parse(await file.text()) as unknown
        const decrypted = await decryptBackup(parsed, passphrase)
        if (!decrypted.ok) {
          setMessage({
            tone: 'error',
            text:
              decrypted.error.kind === 'wrong-passphrase'
                ? 'Passphrase refusée, ou fichier altéré — indistinguables.'
                : 'Fichier de sauvegarde illisible.',
          })
          return
        }
        const result = await restoreBackup(db(), decrypted.value)
        const total = Object.values(result.restored).reduce((a, b) => a + b, 0)
        setPassphrase('')
        setConfirmWord('')
        setMessage({
          tone: 'ok',
          text: `${total} enregistrements restaurés. Recharge le panel pour repartir sur cet état.`,
        })
      } catch (e) {
        setMessage({ tone: 'error', text: `Restauration impossible : ${describe(e)}` })
      } finally {
        setBusy(false)
      }
    },
    [confirmWord, passphrase],
  )

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <h2 className="text-sm font-medium">Sauvegarde chiffrée</h2>
      <p className="mt-1 text-xs text-x-muted">
        Rien n’est sauvegardé ailleurs : il n’y a pas de serveur. Un profil Chrome perdu efface
        tout — corpus de voix, mesures, patterns, journal d’audit. Les embeddings sont exclus de
        l’export (ils se recalculent) ; les clés API ne le sont pas.
      </p>

      <label className="mt-3 block text-xs">
        Passphrase de la sauvegarde
        <input
          type="password"
          autoComplete="off"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          className="mt-1 w-full rounded border border-x-border bg-x-bg px-2 py-1 text-sm"
        />
        <span className="mt-0.5 block text-[10px] text-x-muted">
          Indépendante de celle du coffre. Aucune récupération possible si tu l’oublies.
        </span>
      </label>

      <button
        type="button"
        disabled={busy}
        onClick={() => void exportNow()}
        className="mt-2 rounded-full bg-x-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
      >
        Exporter maintenant
      </button>

      <div className="mt-4 border-t border-x-border pt-3">
        <h3 className="text-xs font-medium text-x-danger">Restaurer (écrase tout)</h3>
        <label className="mt-2 block text-xs">
          Recopie « {RESTORE_WORD} »
          <input
            type="text"
            value={confirmWord}
            onChange={(e) => setConfirmWord(e.target.value)}
            className="mt-1 w-full rounded border border-x-border bg-x-bg px-2 py-1 text-sm"
          />
        </label>
        <label className="mt-2 block text-xs">
          Fichier de sauvegarde
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              // On vide la sélection : sans ça, choisir deux fois le même fichier après une
              // erreur ne déclencherait pas d'événement.
              e.target.value = ''
              if (file) void importNow(file)
            }}
            className="mt-1 w-full text-xs"
          />
        </label>
      </div>

      {message !== null && (
        <p
          className={`mt-2 text-xs ${message.tone === 'ok' ? 'text-x-success' : 'text-x-danger'}`}
          role={message.tone === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Horodatage de nom de fichier, en local, sans caractère interdit. */
export function stamp(atMs: number): string {
  const d = new Date(atMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}
