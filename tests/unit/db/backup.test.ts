import { describe, expect, it, afterEach } from 'vitest'
import { createDb, type SwarmDb } from '@/db'
import { buildBackup, decryptBackup, exportEncrypted, restoreBackup } from '@/db/backup'
import { purgeExpired, PURGED_MARKER } from '@/db/retention'
import { FakeClock, DAY } from '@/shared/time'

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
  const d = createDb(`${name}-${dbSeq++}`)
  opened.push(d)
  return d
}
afterEach(async () => {
  while (opened.length > 0) {
    const d = opened.pop()!
    d.close()
    await d.delete().catch(() => undefined)
  }
})

const PASSPHRASE = 'passphrase de sauvegarde'

async function seed(database: SwarmDb, clock: FakeClock): Promise<void> {
  await database.relationships.put({
    handle: 'someone',
    firstSeenMs: clock.now(),
    lastInteractionMs: clock.now(),
    interactionCount: 3,
    theirTopics: ['onchain'],
    ourTopics: ['liquidite'],
    warmth: 2,
    notes: 'repond souvent',
    ignoredCount: 0,
  })
  await database.patterns.add({
    dimension: 'angle',
    value: 'counterpoint',
    sampleSize: 12,
    avgEngagement: 4.2,
    avgAttributedFollows: 0.3,
    confidence: 0.6,
    updatedAtMs: clock.now(),
  })
}

describe('sauvegarde chiffree (MH-06)', () => {
  it('exporte les tables de valeur', async () => {
    const database = freshDb('backup-build')
    const clock = new FakeClock()
    await seed(database, clock)

    const payload = await buildBackup(database, clock, '0.1.0')
    expect(payload.formatVersion).toBe(1)
    expect(payload.tables['relationships']).toHaveLength(1)
    expect(payload.tables['patterns']).toHaveLength(1)
  })

  it('exclut les embeddings, recalculables localement pour zero euro', async () => {
    // Ils representent l'essentiel du volume et rien d'irremplacable (ADR 0002).
    const database = freshDb('backup-embed')
    const clock = new FakeClock()
    await database.embeddings.add({
      refType: 'opportunity',
      refId: '1',
      vector: new Array(384).fill(0.1),
      createdAtMs: clock.now(),
    })
    const payload = await buildBackup(database, clock, '0.1.0')
    expect(payload.tables['embeddings']).toBeUndefined()
  })

  it('fait un aller-retour chiffre', async () => {
    const database = freshDb('backup-roundtrip')
    const clock = new FakeClock()
    await seed(database, clock)

    const blob = await exportEncrypted(database, clock, '0.1.0', PASSPHRASE)
    const decrypted = await decryptBackup(blob, PASSPHRASE)
    expect(decrypted.ok).toBe(true)
    if (decrypted.ok) expect(decrypted.value.tables['relationships']).toHaveLength(1)
  })

  it('ne contient aucune donnee lisible en clair', async () => {
    const database = freshDb('backup-opaque')
    const clock = new FakeClock()
    await seed(database, clock)
    const blob = await exportEncrypted(database, clock, '0.1.0', PASSPHRASE)
    expect(JSON.stringify(blob)).not.toContain('someone')
    expect(JSON.stringify(blob)).not.toContain('counterpoint')
  })

  it('refuse une mauvaise passphrase', async () => {
    const database = freshDb('backup-wrongpass')
    const clock = new FakeClock()
    const blob = await exportEncrypted(database, clock, '0.1.0', PASSPHRASE)
    const r = await decryptBackup(blob, 'autre passphrase')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('wrong-passphrase')
  })

  it('rejette un fichier qui n est pas une sauvegarde SWARM', async () => {
    const r = await decryptBackup({ hello: 'world' }, PASSPHRASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('bad-format')
  })

  it('restaure en remplacant, pas en fusionnant', async () => {
    // Fusionner deux historiques produirait des doublons de idempotencyKey et des
    // patterns comptes deux fois : un etat incoherent est pire qu'un ecrasement assume.
    const source = freshDb('backup-src')
    const clock = new FakeClock()
    await seed(source, clock)
    const payload = await buildBackup(source, clock, '0.1.0')

    const target = freshDb('backup-dst')
    await target.relationships.put({
      handle: 'a-effacer',
      firstSeenMs: 0,
      lastInteractionMs: null,
      interactionCount: 99,
      theirTopics: [],
      ourTopics: [],
      warmth: 5,
      notes: '',
      ignoredCount: 0,
    })

    await restoreBackup(target, payload)
    const handles = (await target.relationships.toArray()).map((r) => r.handle)
    expect(handles).toEqual(['someone'])
  })
})

describe('purge de retention (MH-13)', () => {
  it('supprime les opportunites rejetees au-dela de la fenetre', async () => {
    const database = freshDb('purge-rejected')
    const clock = new FakeClock('2026-06-01T12:00:00.000Z')
    const old = clock.now() - 40 * DAY

    await database.opportunities.add({
      postId: '1000000000000000001',
      authorHandle: 'someone',
      authorFollowers: 500,
      text: 'contenu de tiers sans valeur conservee',
      lang: 'fr',
      metrics: { replies: 3, likes: 10, reposts: 1 },
      postedAtMs: old,
      observedAtMs: old,
      surface: 'timeline',
      evScore: 0.1,
      scoreBreakdown: null,
      status: 'rejected-qualifier',
      rejectionReason: 'hors niche',
      nichePackId: 'memecoin',
      nichePackVersion: '0.1.0',
      createdAtMs: old,
    })

    const report = await purgeExpired(database, clock, 30)
    expect(report.opportunitiesDeleted).toBe(1)
    expect(await database.opportunities.count()).toBe(0)
  })

  it('conserve la trace des opportunites abouties mais purge leur texte', async () => {
    // Le pattern appris est deja dans `patterns` ; le texte brut ne sert plus.
    const database = freshDb('purge-published')
    const clock = new FakeClock('2026-06-01T12:00:00.000Z')
    const old = clock.now() - 40 * DAY

    const id = await database.opportunities.add({
      postId: '1000000000000000002',
      authorHandle: 'someone',
      authorFollowers: 500,
      text: 'texte original a purger',
      lang: 'fr',
      metrics: { replies: 3, likes: 10, reposts: 1 },
      postedAtMs: old,
      observedAtMs: old,
      surface: 'timeline',
      evScore: 0.8,
      scoreBreakdown: null,
      status: 'published',
      rejectionReason: null,
      nichePackId: 'memecoin',
      nichePackVersion: '0.1.0',
      createdAtMs: old,
    })

    const report = await purgeExpired(database, clock, 30)
    expect(report.opportunitiesRedacted).toBe(1)
    const kept = await database.opportunities.get(id)
    expect(kept?.text).toBe(PURGED_MARKER)
    expect(kept?.evScore).toBe(0.8)
    expect(kept?.status).toBe('published')
  })

  it('ne touche pas a ce qui est dans la fenetre', async () => {
    const database = freshDb('purge-recent')
    const clock = new FakeClock('2026-06-01T12:00:00.000Z')
    await database.opportunities.add({
      postId: '1000000000000000003',
      authorHandle: 'someone',
      authorFollowers: 500,
      text: 'texte recent',
      lang: 'fr',
      metrics: { replies: 1, likes: 2, reposts: 0 },
      postedAtMs: clock.now(),
      observedAtMs: clock.now(),
      surface: 'timeline',
      evScore: 0.5,
      scoreBreakdown: null,
      status: 'rejected-critic',
      rejectionReason: 'redondant',
      nichePackId: 'memecoin',
      nichePackVersion: '0.1.0',
      createdAtMs: clock.now(),
    })
    const report = await purgeExpired(database, clock, 30)
    expect(report.opportunitiesDeleted).toBe(0)
    expect(await database.opportunities.count()).toBe(1)
  })

  it('est idempotente', async () => {
    const database = freshDb('purge-idem')
    const clock = new FakeClock('2026-06-01T12:00:00.000Z')
    const old = clock.now() - 40 * DAY
    await database.opportunities.add({
      postId: '1000000000000000004',
      authorHandle: 'x',
      authorFollowers: null,
      text: 'texte',
      lang: null,
      metrics: { replies: 0, likes: 0, reposts: 0 },
      postedAtMs: old,
      observedAtMs: old,
      surface: 'timeline',
      evScore: 0.6,
      scoreBreakdown: null,
      status: 'published',
      rejectionReason: null,
      nichePackId: 'generic',
      nichePackVersion: '0.1.0',
      createdAtMs: old,
    })
    await purgeExpired(database, clock, 30)
    const second = await purgeExpired(database, clock, 30)
    expect(second.opportunitiesRedacted).toBe(0)
  })
})
