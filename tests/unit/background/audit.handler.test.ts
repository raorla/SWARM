/**
 * Journal d'audit — lecture et vérification de chaîne.
 *
 * « Journal inaltérable » est une promesse creuse si personne ne vérifie la chaîne. Ces tests
 * portent donc sur la vérification et sur ce que l'écran en dit : une rupture doit être
 * **nommée**, pas seulement détectée, et surtout pas interprétée — une purge de rétention mal
 * faite la produit aussi bien qu'une modification malveillante.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createDb, type SwarmDb } from '@/db'
import { AuditLog, type AuditStore } from '@/governor/audit'
import { FakeClock } from '@/shared/time'

let dbSeq = 0
const opened: SwarmDb[] = []

async function setup(): Promise<{
  mod: typeof import('@/background/audit.handler')
  database: SwarmDb
  clock: FakeClock
  record: (type: Parameters<AuditLog['record']>[0]['type'], actor?: string) => Promise<void>
}> {
  vi.resetModules()
  const database = createDb(`audit-${dbSeq++}`)
  opened.push(database)
  const clock = new FakeClock('2026-08-25T12:00:00.000Z')

  const store: AuditStore = {
    append: async (entry) => {
      await database.auditLog.add(entry)
    },
    last: async () => database.auditLog.orderBy('seq').last(),
    all: async () => database.auditLog.orderBy('seq').toArray(),
  }
  const log = new AuditLog(store, clock)

  vi.doMock('@/db', async () => {
    const actual = await vi.importActual<typeof import('@/db')>('@/db')
    return { ...actual, db: () => database }
  })
  const mod = await import('@/background/audit.handler')

  return {
    mod,
    database,
    clock,
    record: async (type, actor = 'system') => {
      await log.record({ type, actor })
      clock.advance(60_000)
    },
  }
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(async () => {
  vi.doUnmock('@/db')
  while (opened.length > 0) {
    const d = opened.pop()!
    d.close()
    await d.delete().catch(() => undefined)
  }
})

describe('lecture du journal', () => {
  it('rend les entrées les plus récentes d’abord', async () => {
    // L'ordre de lecture d'un journal : ce qui vient de se passer est en haut.
    const { mod, record } = await setup()
    await record('permit.granted')
    await record('action.staged')
    await record('action.published')

    const listing = await mod.listAudit(10)
    expect(listing.total).toBe(3)
    expect(listing.entries[0]?.type).toBe('action.published')
    expect(listing.entries[2]?.type).toBe('permit.granted')
  })

  it('respecte la limite sans mentir sur le total', async () => {
    const { mod, record } = await setup()
    for (let i = 0; i < 12; i++) await record('permit.granted')
    const listing = await mod.listAudit(5)
    expect(listing.entries).toHaveLength(5)
    expect(listing.total).toBe(12)
  })

  it('vérifie la chaîne à chaque lecture', async () => {
    const { mod, record } = await setup()
    await record('permit.granted')
    await record('permit.denied')
    const listing = await mod.listAudit()
    expect(listing.chain.valid).toBe(true)
    expect(listing.chainLabel).toContain('vérifiée')
  })

  it('DÉTECTE une entrée modifiée', async () => {
    // Le cœur de la promesse : modifier une ligne en base doit se voir.
    const { mod, database, record } = await setup()
    await record('permit.granted')
    await record('action.staged')
    await record('action.published')

    const middle = await database.auditLog.orderBy('seq').offset(1).first()
    await database.auditLog.update(middle!.id!, { actor: 'quelqu’un d’autre' })

    const listing = await mod.listAudit()
    expect(listing.chain.valid).toBe(false)
    expect(listing.chain.brokenAtSeq).toBe(2)
    expect(listing.chainLabel).toContain('rompue')
  })

  it('DÉTECTE une entrée supprimée', async () => {
    // Une suppression casse la continuité des `seq` et des hashs précédents.
    const { mod, database, record } = await setup()
    await record('permit.granted')
    await record('action.staged')
    await record('action.published')

    const middle = await database.auditLog.orderBy('seq').offset(1).first()
    await database.auditLog.delete(middle!.id!)

    const listing = await mod.listAudit()
    expect(listing.chain.valid).toBe(false)
  })

  it('n’interprète pas une rupture', async () => {
    // Une purge de rétention mal faite ou un import partiel la produisent aussi. Accuser
    // quelqu'un serait faux la plupart du temps.
    const { mod } = await setup()
    const label = mod.describeChain({ valid: false, brokenAtSeq: 4 }, 10)
    expect(label).toContain('4')
    expect(label).toContain('purge')
    expect(label).not.toMatch(/attaque|malveillan/i)
  })

  it('distingue un journal vide d’une chaîne valide', async () => {
    // « Chaîne vérifiée : 0 entrée » se lirait comme une garantie sur rien.
    const { mod } = await setup()
    const listing = await mod.listAudit()
    expect(listing.total).toBe(0)
    expect(listing.chainLabel).toContain('vide')
  })

  it('accorde le libellé au singulier', async () => {
    const { mod, record } = await setup()
    await record('permit.granted')
    const listing = await mod.listAudit()
    expect(listing.chainLabel).toContain('1 entrée intacte')
  })
})
