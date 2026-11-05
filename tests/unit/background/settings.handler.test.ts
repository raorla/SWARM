/**
 * Réglages et coffre — l'écran sans lequel le produit ne démarre pas.
 *
 * Le test central de ce fichier : **aucun réglage ne peut relever un plafond**. Un champ de
 * saisie qui accepterait 300 réponses par jour rendrait décoratif tout le governor, et le
 * `max` d'un `<input>` n'est pas un contrôle — c'est une indication. La borne est donc
 * vérifiée là où elle est appliquée : côté service worker.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createDb, type SwarmDb } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { FakeClock } from '@/shared/time'

let dbSeq = 0
const opened: SwarmDb[] = []

async function setup(): Promise<{
  mod: typeof import('@/background/settings.handler')
  database: SwarmDb
  clock: FakeClock
}> {
  vi.resetModules()
  const database = createDb(`settings-${dbSeq++}`)
  opened.push(database)
  const clock = new FakeClock('2026-08-25T12:00:00.000Z')
  await new ConfigRepo(database, clock).get()

  vi.doMock('@/db', async () => {
    const actual = await vi.importActual<typeof import('@/db')>('@/db')
    return { ...actual, db: () => database }
  })
  const mod = await import('@/background/settings.handler')
  return { mod, database, clock }
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

describe('bornes des réglages', () => {
  it('REFUSE de relever un plafond au-delà du maximum', async () => {
    const { mod, clock } = await setup()
    const { config, clamped } = await mod.updateSettings({ capReply: 300 }, clock)
    expect(config.caps['reply']).toBe(mod.HARD_LIMITS.reply)
    // Le ramener en silence serait un mensonge d'interface : l'utilisateur croirait avoir
    // réglé ce qu'il a tapé.
    expect(clamped.join(' ')).toContain('réponses/jour')
  })

  it('accepte de resserrer', async () => {
    // Le produit autorise plus strict que ses défauts, et seulement dans ce sens.
    const { mod, clock } = await setup()
    const { config, clamped } = await mod.updateSettings({ capReply: 5 }, clock)
    expect(config.caps['reply']).toBe(5)
    expect(clamped).toEqual([])
  })

  it('garde follow et DM à zéro, quoi qu’on envoie', async () => {
    // Ces actions n'existent pas dans le produit (SPEC §4.6).
    const { mod, clock } = await setup()
    const { config } = await mod.updateSettings(
      { capReply: 10 } as Parameters<typeof mod.updateSettings>[0],
      clock,
    )
    expect(config.caps['follow']).toBe(0)
    expect(config.caps['dm']).toBe(0)
  })

  it('borne le budget quotidien', async () => {
    const { mod, clock } = await setup()
    const { config } = await mod.updateSettings({ dailyBudgetEur: 999 }, clock)
    expect(config.budget.dailyEur).toBe(mod.HARD_LIMITS.budgetEur)
  })

  it('empêche une cadence max inférieure à la cadence min', async () => {
    // Sinon la fenêtre de délai est vide et le tirage log-normal n'a plus de sens.
    const { mod, clock } = await setup()
    const { config } = await mod.updateSettings(
      { cadenceMinMinutes: 30, cadenceMaxMinutes: 5 },
      clock,
    )
    expect(config.cadence.maxMinutes).toBeGreaterThan(config.cadence.minMinutes)
  })

  it('refuse une cadence plus rapide que le plancher humain', async () => {
    const { mod, clock } = await setup()
    const { config } = await mod.updateSettings({ cadenceMinMinutes: 0 }, clock)
    expect(config.cadence.minMinutes).toBe(mod.HARD_LIMITS.cadenceMinMinutes)
  })

  it('ne modifie que ce qui est envoyé', async () => {
    // Un correctif partiel qui réinitialiserait le reste effacerait des réglages sans le dire.
    const { mod, clock } = await setup()
    await mod.updateSettings({ capReply: 7, retentionDays: 12 }, clock)
    const { config } = await mod.updateSettings({ capPost: 1 }, clock)
    expect(config.caps['reply']).toBe(7)
    expect(config.retentionDays).toBe(12)
    expect(config.caps['post']).toBe(1)
  })

  it('n’accepte pas de passer en autopilote par ce chemin', async () => {
    // Le passage en autopilote a son écran de consentement, avec une phrase à recopier. En
    // faire un champ de réglage ordinaire contournerait ce consentement — et l'autopilote
    // n'est de toute façon pas implémenté. La barrière est dans le contrat du message, donc
    // c'est lui qu'on vérifie : le handler n'est jamais atteint avec cette valeur.
    const { ConfigPatchSchema } = await import('@/messaging/contract')
    expect(ConfigPatchSchema.safeParse({ mode: 'autopilot' }).success).toBe(false)
    expect(ConfigPatchSchema.safeParse({ mode: 'copilot' }).success).toBe(true)
  })

  it('borne le seuil de veto dans [0, 1]', async () => {
    const { mod, clock } = await setup()
    const { config } = await mod.updateSettings({ criticVetoThreshold: 5 }, clock)
    expect(config.criticVetoThreshold).toBe(1)
  })
})

describe('coffre', () => {
  it('refuse une passphrase trop courte', async () => {
    const { mod } = await setup()
    const result = await mod.setProviderKey({
      providerId: 'openrouter',
      apiKey: 'sk-or-v1-fake-key-value',
      passphrase: 'court',
    })
    expect(result.stored).toBe(false)
    expect(result.error).toContain('trop courte')
  })

  it('refuse une clé vide sauf pour un endpoint local', async () => {
    // Un endpoint local n'a pas de clé : exiger une valeur bidon serait absurde.
    const { mod } = await setup()
    const remote = await mod.setProviderKey({
      providerId: 'openrouter',
      apiKey: '   ',
      passphrase: 'une passphrase correcte',
    })
    expect(remote.stored).toBe(false)

    const local = await mod.setProviderKey({
      providerId: 'openai-compatible',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      passphrase: 'une passphrase correcte',
    })
    expect(local.stored).toBe(true)
  })

  it('refuse un provider non implémenté au lieu d’échouer plus tard', async () => {
    const { mod } = await setup()
    const result = await mod.setProviderKey({
      providerId: 'gemini',
      apiKey: 'clé-quelconque',
      passphrase: 'une passphrase correcte',
    })
    expect(result.stored).toBe(false)
    expect(result.error).toContain('non implémenté')
  })

  it('crée le coffre puis déverrouille avec la même passphrase', async () => {
    const { mod } = await setup()
    const stored = await mod.setProviderKey({
      providerId: 'openrouter',
      apiKey: 'sk-or-v1-fake-key-value',
      passphrase: 'une passphrase correcte',
    })
    expect(stored.stored).toBe(true)

    const status = await mod.settingsStatus()
    expect(status.keystore.initialized).toBe(true)
    expect(status.keystore.providers).toContain('openrouter')

    // Verrouiller puis rouvrir : c'est le parcours réel après fermeture du navigateur.
    await mod.lockKeystore()
    const wrong = await mod.unlockKeystore('mauvaise passphrase')
    expect(wrong.unlocked).toBe(false)
    expect(wrong.error).toContain('refusée')

    const right = await mod.unlockKeystore('une passphrase correcte')
    expect(right.unlocked).toBe(true)
  })

  it('dit « aucun coffre » plutôt que « mauvaise passphrase »', async () => {
    // Envoyer l'utilisateur chercher le mauvais problème coûte une heure.
    const { mod } = await setup()
    const result = await mod.unlockKeystore('une passphrase correcte')
    expect(result.unlocked).toBe(false)
    expect(result.error).toContain('Aucun coffre')
  })

  it('ne renvoie jamais la passphrase ni la clé', async () => {
    // La règle rouge de ce module.
    const { mod } = await setup()
    await mod.setProviderKey({
      providerId: 'openrouter',
      apiKey: 'sk-or-v1-secret-a-ne-pas-fuiter',
      passphrase: 'une passphrase correcte',
    })
    const serialized = JSON.stringify(await mod.settingsStatus())
    expect(serialized).not.toContain('sk-or-v1-secret-a-ne-pas-fuiter')
    expect(serialized).not.toContain('une passphrase correcte')
  })
})
