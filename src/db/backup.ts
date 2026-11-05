/**
 * Export et import chiffrés — FEEDBACK MH-06.
 *
 * « Local-first » veut aussi dire « aucune sauvegarde ». Un profil Chrome corrompu, une
 * extension désinstallée par erreur, un `unlimitedStorage` évincé, et l'utilisateur perd
 * son Voice Profile, son CRM social et son historique de patterns — c'est-à-dire la
 * totalité de la valeur accumulée, qui est précisément ce qu'aucun concurrent ne peut lui
 * rendre. Un produit dont la valeur s'accumule localement doit être exportable dès le
 * premier jour, pas quand quelqu'un aura perdu ses données.
 *
 * La sauvegarde est chiffrée avec une passphrase distincte de celle du keystore : les
 * clés API ne sont **jamais** incluses dans un export. Un fichier de sauvegarde qui
 * traîne ne doit pas être un fichier de clés qui traîne.
 */
import type { SwarmDb } from './index'
import { z } from 'zod'
import { err, ok, type Result } from '@/shared/result'
import type { Clock } from '@/shared/time'
import { createLogger } from '@/shared/logger'

const log = createLogger('db:backup')

export const BACKUP_FORMAT_VERSION = 1

/** Tables incluses dans une sauvegarde. `auditLog` en fait partie : c'est une preuve. */
const BACKUP_TABLES = [
  'opportunities',
  'drafts',
  'actions',
  'outcomes',
  'relationships',
  'voiceProfile',
  'patterns',
  'config',
  'promptVersions',
  'nichePacks',
  'auditLog',
] as const

/**
 * `embeddings` est exclu volontairement : c'est du dérivé, recalculable localement pour
 * zéro euro (ADR 0002), et c'est de loin le plus volumineux. L'inclure multiplierait la
 * taille du fichier par dix sans rien sauvegarder d'irremplaçable.
 */
type BackupTable = (typeof BACKUP_TABLES)[number]

export const BackupPayloadSchema = z.object({
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  exportedAtMs: z.number().int().nonnegative(),
  appVersion: z.string(),
  tables: z.record(z.string(), z.array(z.unknown())),
})
export type BackupPayload = z.infer<typeof BackupPayloadSchema>

export const EncryptedBackupSchema = z.object({
  kind: z.literal('swarm-backup'),
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  salt: z.string(),
  iv: z.string(),
  ct: z.string(),
  iterations: z.number().int().positive(),
})
export type EncryptedBackup = z.infer<typeof EncryptedBackupSchema>

const ITERATIONS = 300_000

const toB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

const fromB64 = (s: string): Uint8Array => {
  const raw = atob(s)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function buildBackup(
  database: SwarmDb,
  clock: Clock,
  appVersion: string,
): Promise<BackupPayload> {
  const tables: Record<string, unknown[]> = {}
  for (const name of BACKUP_TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accès dynamique par nom de table, borné à BACKUP_TABLES
    tables[name] = await (database as any)[name].toArray()
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAtMs: clock.now(),
    appVersion,
    tables,
  }
}

export async function exportEncrypted(
  database: SwarmDb,
  clock: Clock,
  appVersion: string,
  passphrase: string,
): Promise<EncryptedBackup> {
  const payload = await buildBackup(database, clock, appVersion)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, ITERATIONS)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  return {
    kind: 'swarm-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
    iterations: ITERATIONS,
  }
}

export type RestoreError =
  | { kind: 'wrong-passphrase' }
  | { kind: 'bad-format'; detail: string }
  | { kind: 'version-mismatch'; found: number }

export async function decryptBackup(
  blob: unknown,
  passphrase: string,
): Promise<Result<BackupPayload, RestoreError>> {
  const parsedBlob = EncryptedBackupSchema.safeParse(blob)
  if (!parsedBlob.success) {
    return err({
      kind: 'bad-format',
      detail: 'ce fichier n’est pas une sauvegarde SWARM',
    })
  }
  try {
    const key = await deriveKey(
      passphrase,
      fromB64(parsedBlob.data.salt),
      parsedBlob.data.iterations,
    )
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(parsedBlob.data.iv) as unknown as BufferSource },
      key,
      fromB64(parsedBlob.data.ct) as unknown as BufferSource,
    )
    const payload = BackupPayloadSchema.safeParse(
      JSON.parse(new TextDecoder().decode(plain)),
    )
    if (!payload.success) {
      return err({
        kind: 'bad-format',
        detail: payload.error.issues[0]?.message ?? 'contenu illisible',
      })
    }
    return ok(payload.data)
  } catch {
    return err({ kind: 'wrong-passphrase' })
  }
}

/**
 * Restaure une sauvegarde. **Remplace** le contenu des tables sauvegardées.
 *
 * Volontairement destructif et explicite plutôt que fusionnant : fusionner deux
 * historiques d'actions produirait des doublons de `idempotencyKey` et des patterns
 * comptés deux fois — un état incohérent est pire qu'un écrasement assumé. L'appelant
 * doit confirmer auprès de l'utilisateur.
 */
export async function restoreBackup(
  database: SwarmDb,
  payload: BackupPayload,
): Promise<{ restored: Record<string, number> }> {
  const restored: Record<string, number> = {}
  await database.transaction('rw', database.tables, async () => {
    for (const name of BACKUP_TABLES) {
      const rows = payload.tables[name]
      if (!Array.isArray(rows)) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accès dynamique borné à BACKUP_TABLES
      const table = (database as any)[name as BackupTable]
      await table.clear()
      if (rows.length > 0) await table.bulkPut(rows)
      restored[name] = rows.length
    }
  })
  log.info('sauvegarde restaurée', restored)
  return { restored }
}
