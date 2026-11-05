import { describe, expect, it, afterEach } from 'vitest'
import { createDb, CURRENT_VERSION, MIGRATIONS, type SwarmDb } from '@/db'
import { ConfigRepo, defaultConfig } from '@/db/repositories/config.repo'
import { ActionRepo } from '@/db/repositories/action.repo'
import { FakeClock } from '@/shared/time'

/**
 * Compteur monotone de bases de test.
 *
 * `opened.length` ne convient PAS : le tableau est vidé après chaque test, donc tous les
 * tests rouvriraient la même base — et `fake-indexeddb` fait alors courir la suppression de
 * l'une avec l'ouverture de la suivante. Les échecs qui en résultent sont intermittents et
 * ne ressemblent pas à leur cause.
 */
let dbSeq = 0

const opened: SwarmDb[] = []

function freshDb(name: string): SwarmDb {
  const database = createDb(`${name}-${dbSeq++}`)
  opened.push(database)
  return database
}

afterEach(async () => {
  while (opened.length > 0) {
    const d = opened.pop()!
    d.close()
    await d.delete().catch(() => undefined)
  }
})

describe('migrations', () => {
  it('ouvre une base vide a la version courante', async () => {
    const database = freshDb('migrate-open')
    await database.open()
    expect(database.verno).toBe(CURRENT_VERSION)
  })

  it('declare toutes les tables de SPEC §5', async () => {
    const database = freshDb('migrate-tables')
    await database.open()
    const names = database.tables.map((t) => t.name).sort()
    for (const expected of [
      'actions',
      'auditLog',
      'config',
      'drafts',
      'embeddings',
      'nichePacks',
      'opportunities',
      'outcomes',
      'patterns',
      'promptVersions',
      'relationships',
      'voiceProfile',
    ]) {
      expect(names, `table ${expected} manquante`).toContain(expected)
    }
  })

  it('numerote les versions de facon strictement croissante', () => {
    // Regle du projet : une migration livree ne se modifie jamais, on en ajoute une.
    const versions = MIGRATIONS.map((m) => m.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('contraint l unicite de idempotencyKey (MH-07)', async () => {
    // L'unicite est garantie par la base, pas par une verification applicative qui
    // pourrait courir contre elle-meme apres un redemarrage de service worker.
    const database = freshDb('migrate-idem')
    const clock = new FakeClock()
    const repo = new ActionRepo(database, clock)

    const action = {
      idempotencyKey: 'post-1:draft-abc',
      type: 'reply' as const,
      opportunityId: null,
      draftId: null,
      content: 'texte',
      stagedAtMs: clock.now(),
      publishedAtMs: null,
      outcome: 'pending' as const,
      xPostId: null,
      agentTrail: [],
      totalCostEur: 0,
      promptVersionHash: 'abc',
      nichePackId: 'memecoin',
    }

    const first = await repo.stage(action)
    expect(first.ok).toBe(true)

    const second = await repo.stage({ ...action, content: 'autre texte' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.kind).toBe('duplicate')
  })

  it('l unicite de seq protege le journal d audit', async () => {
    const database = freshDb('migrate-audit')
    await database.auditLog.add({
      seq: 1,
      atMs: 1,
      type: 'permit.granted',
      actor: 'a',
      prevHash: null,
      hash: 'h1',
    })
    // Un doublon de sequence est en soi un signe de falsification : l'index le rend
    // impossible a creer par erreur.
    await expect(
      database.auditLog.add({
        seq: 1,
        atMs: 2,
        type: 'permit.granted',
        actor: 'b',
        prevHash: 'h1',
        hash: 'h2',
      }),
    ).rejects.toThrow()
  })
})

describe('ConfigRepo', () => {
  it('cree la config par defaut au premier appel', async () => {
    const database = freshDb('config-create')
    const repo = new ConfigRepo(database, new FakeClock())
    const config = await repo.get()
    expect(config.id).toBe('current')
    expect(config.installSeed).toHaveLength(32)
    expect(config.retentionDays).toBe(30)
    expect(config.consentAcceptedAtMs).toBeNull()
  })

  it('ne recree pas la config a chaque appel', async () => {
    const database = freshDb('config-stable')
    const repo = new ConfigRepo(database, new FakeClock())
    const a = await repo.get()
    const b = await repo.get()
    // La graine d'installation doit etre stable a vie : elle determine les jours off.
    expect(b.installSeed).toBe(a.installSeed)
  })

  it('le patch ne peut pas modifier la graine d installation', async () => {
    const database = freshDb('config-seed')
    const repo = new ConfigRepo(database, new FakeClock())
    const before = await repo.get()
    // @ts-expect-error — installSeed est exclu du type de patch, volontairement.
    await repo.update({ installSeed: 'autre-graine' })
    expect((await repo.get()).installSeed).toBe(before.installSeed)
  })

  it('enregistre le consentement horodate (MH-12)', async () => {
    const database = freshDb('config-consent')
    const clock = new FakeClock('2026-05-01T10:00:00.000Z')
    const repo = new ConfigRepo(database, clock)
    expect(await repo.hasConsented()).toBe(false)
    await repo.acceptConsent()
    expect(await repo.hasConsented()).toBe(true)
    expect((await repo.get()).consentAcceptedAtMs).toBe(clock.now())
  })

  it('demarre en mode simulation par defaut en developpement (MH-15)', () => {
    // Le developpement se fait sur un vrai compte : le defaut doit etre inerte.
    expect(defaultConfig(new FakeClock()).mode).toBe('simulation')
  })

  it('genere une graine differente par installation', () => {
    const clock = new FakeClock()
    const seeds = new Set(
      Array.from({ length: 50 }, () => defaultConfig(clock).installSeed),
    )
    expect(seeds.size).toBe(50)
  })
})
