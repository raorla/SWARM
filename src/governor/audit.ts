/**
 * Journal d'audit inaltérable — SPEC §2.4.
 *
 * « Append-only » ne suffit pas : une table où l'on ajoute peut aussi être modifiée par
 * quiconque a accès à IndexedDB, c'est-à-dire par l'extension elle-même. Le chaînage
 * par hash rend toute modification *détectable* — c'est le maximum atteignable en local,
 * et il faut être honnête sur la différence : on ne peut pas empêcher la falsification
 * côté client, on peut la rendre visible.
 *
 * Chaque entrée contient le hash de la précédente. Modifier ou supprimer une entrée
 * casse la chaîne à partir de là, et `verifyChain()` le signale.
 */
import type { ActionType, DenialReason } from './types'
import type { Clock } from '@/shared/time'

export type AuditEventType =
  | 'permit.granted'
  | 'permit.denied'
  | 'action.staged'
  | 'action.published'
  | 'action.abandoned'
  | 'killswitch.engaged'
  | 'killswitch.released'
  | 'budget.exhausted'
  | 'selector.broken'
  | 'critic.rejected'
  | 'config.changed'
  | 'mode.changed'

export interface AuditEntry {
  /** Position dans la chaîne, à partir de 1. */
  seq: number
  atMs: number
  type: AuditEventType
  /** Agent responsable, ou 'user' / 'system'. */
  actor: string
  actionType?: ActionType | undefined
  idempotencyKey?: string | undefined
  denialReason?: DenialReason | undefined
  /** Coût réel en tokens, lu dans la réponse du provider — jamais estimé (SPEC §3.2). */
  tokenCost?: { input: number; output: number; eur: number } | undefined
  detail?: string | undefined
  /** Hash de l'entrée précédente. `null` pour la première. */
  prevHash: string | null
  /** Hash de cette entrée, prevHash inclus. */
  hash: string
}

/** Champs fournis par l'appelant ; seq/hash/prevHash sont calculés par le journal. */
export type AuditInput = Omit<AuditEntry, 'seq' | 'prevHash' | 'hash' | 'atMs'>

export interface AuditStore {
  append(entry: AuditEntry): Promise<void>
  last(): Promise<AuditEntry | undefined>
  all(): Promise<readonly AuditEntry[]>
}

export function memoryAuditStore(): AuditStore {
  const rows: AuditEntry[] = []
  return {
    append: async (e) => void rows.push(e),
    last: async () => rows[rows.length - 1],
    all: async () => [...rows],
  }
}

/**
 * Sérialisation canonique : clés triées, `undefined` omis.
 * Indispensable — si la sérialisation varie (ordre des clés d'un objet littéral), le
 * hash varie et la chaîne se casse toute seule au premier recalcul.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Champs couverts par le hash. **Liste explicite, et c'est le point.**
 *
 * La version précédente hachait l'objet entier. Conséquence : dès que le journal est adossé à
 * Dexie, la table ajoute une clé primaire `id` auto-incrémentée à l'enregistrement relu — donc
 * le hash recalculé n'était jamais celui écrit, et `verifyChain()` déclarait la chaîne rompue
 * **à la première entrée**, toujours. Le journal « inaltérable » ne pouvait pas se vérifier une
 * seule fois en production, et seul un test en mémoire pouvait passer.
 *
 * Une liste fermée règle ça définitivement : un champ de stockage ajouté plus tard (index,
 * clé, marqueur de synchronisation) n'a aucun effet sur la chaîne, et un champ **de contenu**
 * ajouté ici sans être mis dans la liste ne serait pas protégé — d'où le test qui vérifie que
 * la liste couvre bien toutes les clés d'une entrée.
 */
export const HASHED_FIELDS = [
  'seq',
  'atMs',
  'type',
  'actor',
  'actionType',
  'idempotencyKey',
  'denialReason',
  'tokenCost',
  'detail',
  'prevHash',
] as const

export async function hashEntry(entry: Omit<AuditEntry, 'hash'>): Promise<string> {
  const subset: Record<string, unknown> = {}
  for (const field of HASHED_FIELDS) {
    const value = (entry as Record<string, unknown>)[field]
    if (value !== undefined) subset[field] = value
  }
  return sha256Hex(canonical(subset))
}

export class AuditLog {
  constructor(
    private readonly store: AuditStore,
    private readonly clock: Clock,
  ) {}

  async record(input: AuditInput): Promise<AuditEntry> {
    const prev = await this.store.last()
    const withoutHash: Omit<AuditEntry, 'hash'> = {
      ...input,
      seq: (prev?.seq ?? 0) + 1,
      atMs: this.clock.now(),
      prevHash: prev?.hash ?? null,
    }
    const hash = await hashEntry(withoutHash)
    const entry: AuditEntry = { ...withoutHash, hash }
    await this.store.append(entry)
    return entry
  }

  /**
   * Vérifie l'intégrité de la chaîne.
   * Renvoie l'index de la première rupture, ou `null` si la chaîne est intacte.
   */
  async verifyChain(): Promise<{ valid: boolean; brokenAtSeq: number | null }> {
    const rows = await this.store.all()
    let prevHash: string | null = null
    let expectedSeq = 1
    for (const row of rows) {
      const { hash, ...rest } = row
      if (row.seq !== expectedSeq || row.prevHash !== prevHash) {
        return { valid: false, brokenAtSeq: row.seq }
      }
      if ((await hashEntry(rest)) !== hash) {
        return { valid: false, brokenAtSeq: row.seq }
      }
      prevHash = hash
      expectedSeq += 1
    }
    return { valid: true, brokenAtSeq: null }
  }

  async entries(): Promise<readonly AuditEntry[]> {
    return this.store.all()
  }
}
