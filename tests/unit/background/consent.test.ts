/**
 * CONSENTEMENT (MH-12) — la porte qui bloquait tout.
 *
 * Défaut trouvé en préparant la première installation dans Chrome : `hasConsented()` gardait le
 * triage, la rédaction depuis la file et la rédaction depuis l'overlay, et **rien n'appelait
 * `acceptConsent()`**. Une extension fraîchement installée se chargeait correctement, affichait
 * ses quatre onglets, et refusait tout — sans message, puisque chaque garde renvoyait un refus
 * poliment formaté que personne n'affichait au bon endroit.
 *
 * Aucun test ne pouvait le voir : chaque garde était correcte, et les tests des handlers
 * appelaient `acceptConsent()` eux-mêmes dans leur préparation. C'est un défaut de câblage, pas
 * de logique — et il rendait le produit entièrement inerte.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createDb, type SwarmDb } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { FakeClock } from '@/shared/time'

let dbSeq = 0
const opened: SwarmDb[] = []

async function setup(): Promise<{
  settings: typeof import('@/background/settings.handler')
  database: SwarmDb
  clock: FakeClock
}> {
  vi.resetModules()
  const database = createDb(`consent-${dbSeq++}`)
  opened.push(database)
  const clock = new FakeClock('2026-08-26T09:00:00.000Z')
  await new ConfigRepo(database, clock).get()

  vi.doMock('@/db', async () => {
    const actual = await vi.importActual<typeof import('@/db')>('@/db')
    return { ...actual, db: () => database }
  })
  return {
    settings: await import('@/background/settings.handler'),
    database,
    clock,
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

describe('porte de consentement', () => {
  it('une installation neuve n’a PAS consenti', async () => {
    // L'état de départ, et celui dans lequel le produit restait bloqué.
    const { settings } = await setup()
    const status = await settings.settingsStatus()
    expect(status.config.consentAcceptedAtMs).toBeNull()
  })

  it('le consentement est enregistrable, et horodaté', async () => {
    // Le correctif : un chemin existe pour l'accorder.
    const { settings, clock } = await setup()
    const result = await settings.acceptConsent(clock)
    expect(result.accepted).toBe(true)
    expect(result.atMs).toBe(clock.now())

    const status = await settings.settingsStatus(clock)
    expect(status.config.consentAcceptedAtMs).toBe(clock.now())
  })

  it('accepter deux fois conserve la PREMIÈRE date', async () => {
    // C'est celle qui compte : elle dit quand l'utilisateur a été informé, pas quand il a
    // rouvert le panneau.
    const { settings, clock } = await setup()
    const first = await settings.acceptConsent(clock)
    clock.advance(3_600_000)
    const second = await settings.acceptConsent(clock)
    expect(second.atMs).toBe(first.atMs)
  })

  it('débloque le triage, qui refusait avant', async () => {
    // Le test de bout en bout de la porte : avant/après sur le même chemin réel.
    const { settings, database, clock } = await setup()
    const repo = new ConfigRepo(database, clock)

    expect(await repo.hasConsented()).toBe(false)
    await settings.acceptConsent(clock)
    expect(await repo.hasConsented()).toBe(true)
  })

  it('le message de consentement fait partie du contrat', async () => {
    // Sans entrée dans l'union discriminée, le message serait rejeté « hors contrat » et
    // l'écran resterait sans effet — exactement le genre de panne muette qu'on vient de
    // corriger.
    const { MessageSchema, MSG } = await import('@/messaging/contract')
    const parsed = MessageSchema.safeParse({ type: MSG.CONSENT_ACCEPT, payload: {} })
    expect(parsed.success).toBe(true)
  })
})
