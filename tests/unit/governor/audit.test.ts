import { describe, expect, it } from 'vitest'
import {
  AuditLog,
  HASHED_FIELDS,
  hashEntry,
  memoryAuditStore,
  type AuditEntry,
  type AuditStore,
} from '@/governor/audit'
import { FakeClock } from '@/shared/time'

/** Store mutable, pour simuler une falsification. */
function mutableStore(): AuditStore & { rows: AuditEntry[] } {
  const rows: AuditEntry[] = []
  return {
    rows,
    append: async (e) => void rows.push(e),
    last: async () => rows[rows.length - 1],
    all: async () => rows,
  }
}

describe('AuditLog', () => {
  it('chaîne les entrées par hash', async () => {
    const log = new AuditLog(memoryAuditStore(), new FakeClock())
    const a = await log.record({ type: 'permit.granted', actor: 'publisher' })
    const b = await log.record({ type: 'action.staged', actor: 'publisher' })

    expect(a.seq).toBe(1)
    expect(a.prevHash).toBeNull()
    expect(b.seq).toBe(2)
    expect(b.prevHash).toBe(a.hash)
    expect(b.hash).not.toBe(a.hash)
  })

  it('valide une chaîne intacte', async () => {
    const log = new AuditLog(memoryAuditStore(), new FakeClock())
    for (let i = 0; i < 10; i++) {
      await log.record({ type: 'permit.granted', actor: `agent-${i}` })
    }
    expect(await log.verifyChain()).toEqual({ valid: true, brokenAtSeq: null })
  })

  it('détecte la modification d’une entrée', async () => {
    // C'est tout l'intérêt du chaînage : on ne peut pas empêcher la falsification en
    // local, on peut la rendre visible.
    const store = mutableStore()
    const log = new AuditLog(store, new FakeClock())
    await log.record({ type: 'permit.granted', actor: 'a' })
    await log.record({ type: 'permit.denied', actor: 'b', denialReason: 'cap-reached' })
    await log.record({ type: 'action.staged', actor: 'c' })

    store.rows[1]!.detail = 'modifié après coup'
    const result = await log.verifyChain()
    expect(result.valid).toBe(false)
    expect(result.brokenAtSeq).toBe(2)
  })

  it('détecte la suppression d’une entrée', async () => {
    const store = mutableStore()
    const log = new AuditLog(store, new FakeClock())
    for (let i = 0; i < 4; i++)
      await log.record({ type: 'permit.granted', actor: `a${i}` })

    store.rows.splice(1, 1)
    const result = await log.verifyChain()
    expect(result.valid).toBe(false)
    expect(result.brokenAtSeq).toBe(3)
  })

  it('produit un hash stable quel que soit l’ordre des clés à la construction', async () => {
    // Sans sérialisation canonique, la chaîne se casserait toute seule au premier
    // recalcul, ce qui rendrait la vérification inutilisable.
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const l1 = new AuditLog(memoryAuditStore(), clock)
    const l2 = new AuditLog(memoryAuditStore(), new FakeClock('2026-01-01T00:00:00.000Z'))

    const e1 = await l1.record({
      type: 'permit.granted',
      actor: 'x',
      detail: 'd',
      actionType: 'reply',
    })
    const e2 = await l2.record({
      actionType: 'reply',
      detail: 'd',
      actor: 'x',
      type: 'permit.granted',
    })
    expect(e1.hash).toBe(e2.hash)
  })

  it('omet les champs undefined du hash', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z')
    const l1 = new AuditLog(memoryAuditStore(), clock)
    const l2 = new AuditLog(memoryAuditStore(), new FakeClock('2026-01-01T00:00:00.000Z'))
    const e1 = await l1.record({ type: 'mode.changed', actor: 'user' })
    const e2 = await l2.record({ type: 'mode.changed', actor: 'user', detail: undefined })
    expect(e1.hash).toBe(e2.hash)
  })
})

describe('périmètre du hash', () => {
  /**
   * Ce test existe à cause d'un défaut réel : le hash portait sur l'objet entier, donc dès
   * que le journal a été adossé à Dexie — qui ajoute une clé primaire `id` à l'enregistrement
   * relu — la vérification déclarait la chaîne rompue **à la première entrée, toujours**. Le
   * journal « inaltérable » était invérifiable en production, et seul un test en mémoire
   * pouvait passer.
   */
  it('ignore les champs ajoutés par le stockage', async () => {
    const log = new AuditLog(memoryAuditStore(), new FakeClock('2026-08-25T12:00:00.000Z'))
    const entry = await log.record({ type: 'permit.granted', actor: 'publisher' })

    // Simule ce que fait Dexie : la ligne relue porte une clé primaire en plus.
    const { hash, ...rest } = { ...entry, id: 42 }
    expect(await hashEntry(rest as unknown as Omit<typeof entry, 'hash'>)).toBe(hash)
  })

  it('couvre TOUS les champs de contenu d’une entrée', async () => {
    // Un champ de contenu absent de la liste ne serait pas protégé par la chaîne : on
    // pourrait le modifier en base sans que la vérification bronche. Ce test échoue au moment
    // où un champ est ajouté à `AuditEntry` sans être ajouté à `HASHED_FIELDS`.
    const log = new AuditLog(memoryAuditStore(), new FakeClock('2026-08-25T12:00:00.000Z'))
    const entry = await log.record({
      type: 'permit.denied',
      actor: 'publisher',
      actionType: 'reply',
      idempotencyKey: 'clé-1',
      denialReason: 'cap-reached',
      tokenCost: { input: 10, output: 20, eur: 0.001 },
      detail: 'plafond atteint',
    })

    const contentFields = Object.keys(entry).filter((k) => k !== 'hash')
    expect([...contentFields].sort()).toEqual([...HASHED_FIELDS].sort())
  })

  it('un champ de contenu modifié change le hash', async () => {
    const log = new AuditLog(memoryAuditStore(), new FakeClock('2026-08-25T12:00:00.000Z'))
    const entry = await log.record({
      type: 'permit.denied',
      actor: 'publisher',
      denialReason: 'cap-reached',
    })
    const { hash, ...rest } = entry
    const tampered = await hashEntry({ ...rest, denialReason: 'blocked-topic' })
    expect(tampered).not.toBe(hash)
  })
})
