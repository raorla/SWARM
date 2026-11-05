/**
 * Construction et péremption du Voice Profile.
 *
 * La péremption est la partie qui compte : **un profil vieilli est plus dangereux qu'un
 * profil absent.** Le produit croit connaître un style qui a changé, et le CRITIC valide des
 * variantes qui ne ressemblent plus à l'utilisateur — sans que rien ne signale l'erreur.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createDb, type SwarmDb } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { OwnPostRepo, type OwnPostInput } from '@/db/repositories/own-post.repo'
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

let seq = 0
function input(text: string): OwnPostInput {
  seq += 1
  return {
    postId: `1789456000000${String(seq).padStart(6, '0')}`,
    text,
    lang: 'en',
    postedAtMs: 1_787_000_000_000 - seq * 3_600_000,
    likeCount: 8,
    replyCount: 1,
    repostCount: 0,
    hasMedia: false,
    isReply: false,
  }
}

const CLEAN_CORPUS = Array.from({ length: 12 }, (_, i) =>
  input(`locked liquidity note ${i} about the float and the holders here`),
)

const PROMO_CORPUS = Array.from({ length: 12 }, () =>
  input('MAXIMUM POTENTIAL, from microcap to legendary, 100x incoming'),
)

/**
 * Le handler utilise le singleton `db()`. On le substitue par module : ce qu'on vérifie ici
 * est le comportement de construction et de péremption, pas le branchement.
 */
async function setup(options: {
  ownHandle?: string | null
  corpus?: readonly OwnPostInput[]
  clockIso?: string
}): Promise<{
  mod: typeof import('@/background/voice-profile.handler')
  database: SwarmDb
  clock: FakeClock
}> {
  vi.resetModules()
  const database = createDb(`vp-${dbSeq++}`)
  opened.push(database)
  const clock = new FakeClock(options.clockIso ?? '2026-08-25T12:00:00.000Z')

  const configRepo = new ConfigRepo(database, clock)
  await configRepo.get()
  await configRepo.update({
    ownHandle: options.ownHandle === undefined ? 'ACMECTO' : options.ownHandle,
    activeNichePackId: 'memecoin',
  })

  if (options.corpus) {
    await new OwnPostRepo(database, clock).upsertMany(options.corpus)
  }

  vi.doMock('@/db', async () => {
    const actual = await vi.importActual<typeof import('@/db')>('@/db')
    return { ...actual, db: () => database }
  })

  const mod = await import('@/background/voice-profile.handler')
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

describe('construction', () => {
  it('refuse de construire sans handle', async () => {
    // Sans handle, impossible de savoir de qui est le corpus.
    const { mod, clock } = await setup({ ownHandle: null, corpus: CLEAN_CORPUS })
    const result = await mod.rebuildVoiceProfile({ clock })
    expect(result.built).toBe(false)
    expect(result.reason).toContain('handle')
  })

  it('refuse de construire sur un corpus vide', async () => {
    // Un profil vide serait pire qu'aucun profil : le WRITER croirait avoir une référence.
    const { mod, clock } = await setup({})
    const result = await mod.rebuildVoiceProfile({ clock })
    expect(result.built).toBe(false)
    expect(result.reason).toContain('corpus vide')
  })

  it('construit et persiste un profil exploitable', async () => {
    const { mod, database, clock } = await setup({ corpus: CLEAN_CORPUS })
    const result = await mod.rebuildVoiceProfile({ clock })
    expect(result.built).toBe(true)
    expect(result.profile?.sampleSize).toBe(12)
    expect(result.profile?.canonicalExamples).toBeGreaterThan(2)

    const stored = await database.voiceProfile.get('current')
    expect(stored?.handle).toBe('ACMECTO')
  })

  it('signale un corpus majoritairement écarté (MH-18)', async () => {
    // Diagnostic honnête : le produit dit « cette voix est largement non reproductible »
    // au lieu de produire une imitation dégradée en silence.
    const { mod, clock } = await setup({ corpus: [...PROMO_CORPUS, CLEAN_CORPUS[0]!] })
    const result = await mod.rebuildVoiceProfile({ clock })
    expect(result.built).toBe(true)
    expect(result.profile?.guardExcludedRatio).toBeGreaterThan(0.8)
    expect(result.profile?.usable).toBe(false)
    expect(result.profile?.summary).toContain('non reproductible')
  })

  it('requalifie le corpus avant de construire', async () => {
    // Si le pack a changé ses sujets bloqués depuis la collecte, `passesGuard` reflète des
    // règles périmées et le profil s'appuierait sur une qualification fausse.
    const { mod, database, clock } = await setup({ corpus: CLEAN_CORPUS })
    // On force une qualification fausse en base.
    await database.ownPosts.toCollection().modify({ passesGuard: false })

    const result = await mod.rebuildVoiceProfile({ clock })
    expect(result.built).toBe(true)
    // La requalification a rétabli la vérité : ces posts passent le garde-fou.
    expect(result.profile?.guardExcludedRatio).toBe(0)
  })
})

describe('ingestion', () => {
  it('qualifie à l’écriture et renvoie l’état du corpus', async () => {
    const { mod, clock } = await setup({})
    const result = await mod.ingestOwnPosts({
      posts: [...CLEAN_CORPUS.slice(0, 3), input('100x incoming, guaranteed returns')],
    }, { clock })
    expect(result.received).toBe(4)
    expect(result.corpusSize).toBe(4)
    expect(result.passingGuard).toBe(3)
    expect(result.excludedRatio).toBeCloseTo(0.25, 3)
  })

  it('l’ingestion est idempotente', async () => {
    const { mod, clock } = await setup({})
    await mod.ingestOwnPosts({ posts: CLEAN_CORPUS }, { clock })
    const second = await mod.ingestOwnPosts({ posts: CLEAN_CORPUS }, { clock })
    expect(second.corpusSize).toBe(12)
  })
})

describe('péremption — un profil vieilli est plus dangereux qu’un profil absent', () => {
  it('sans profil : état explicite, pas un null', async () => {
    const { mod, clock } = await setup({ corpus: CLEAN_CORPUS })
    const status = await mod.voiceProfileStatus({ clock })
    expect(status.exists).toBe(false)
    expect(status.stale).toBe(true)
    expect(status.staleReason).toBe('absent')
    expect(status.summary).toContain('12 posts collectés')
  })

  it('sans corpus : dit quoi faire', async () => {
    const { mod, clock } = await setup({})
    const status = await mod.voiceProfileStatus({ clock })
    expect(status.summary).toContain('collecte')
    expect(mod.describeStaleness(status)).toContain('registre neutre')
  })

  it('un profil frais n’est pas périmé', async () => {
    const { mod, clock } = await setup({ corpus: CLEAN_CORPUS })
    await mod.rebuildVoiceProfile({ clock })
    const status = await mod.voiceProfileStatus({ clock })
    expect(status.stale).toBe(false)
    expect(status.staleReason).toBeNull()
    expect(mod.describeStaleness(status)).toBeNull()
  })

  it('détecte la péremption par l’âge', async () => {
    const { mod, database, clock } = await setup({ corpus: CLEAN_CORPUS })
    await mod.rebuildVoiceProfile({ clock })

    // On vieillit le profil de 40 jours.
    const profile = await database.voiceProfile.get('current')
    await database.voiceProfile.put({ ...profile!, builtAtMs: clock.now() - 40 * DAY })

    const status = await mod.voiceProfileStatus({ clock })
    expect(status.stale).toBe(true)
    expect(status.staleReason).toBe('age')
    expect(mod.describeStaleness(status)).toContain('40 jours')
  })

  it('mesure l’âge avec l’horloge INJECTÉE, pas l’horloge système', async () => {
    // Régression : ce handler figeait `systemClock` au niveau du module alors que les autres
    // avaient été corrigés (MH-17). L'âge se calculait donc avec l'heure réelle contre un
    // `builtAtMs` écrit avec l'horloge injectée — faux dès que les deux diffèrent. Le test
    // précédent ne le voyait pas parce que sa date simulée valait la date du jour ; il a
    // échoué le lendemain. L'horloge est ici volontairement à des années de « maintenant ».
    const { mod, database, clock } = await setup({
      corpus: CLEAN_CORPUS,
      clockIso: '2031-03-04T08:00:00.000Z',
    })
    await mod.rebuildVoiceProfile({ clock })

    const profile = await database.voiceProfile.get('current')
    await database.voiceProfile.put({ ...profile!, builtAtMs: clock.now() - 40 * DAY })

    const status = await mod.voiceProfileStatus({ clock })
    expect(status.ageMs).toBe(40 * DAY)
    expect(mod.describeStaleness(status)).toContain('40 jours')
  })

  it('détecte la péremption par accumulation de nouveaux posts', async () => {
    const { mod, clock } = await setup({ corpus: CLEAN_CORPUS })
    await mod.rebuildVoiceProfile({ clock })

    // 50 nouveaux posts depuis la construction : le profil ignore la production récente.
    await mod.ingestOwnPosts({
      posts: Array.from({ length: 50 }, (_, i) =>
        input(`nouveau post ${i} sur le float`),
      ),
    })

    const status = await mod.voiceProfileStatus({ clock })
    expect(status.stale).toBe(true)
    expect(status.staleReason).toBe('nouveaux-posts')
    expect(status.newPostsSinceBuild).toBeGreaterThanOrEqual(40)
    expect(mod.describeStaleness(status)).toContain('production récente')
  })

  it('un changement de handle invalide le profil entièrement', async () => {
    // Ce n'est plus la même personne : conserver le profil serait imiter quelqu'un d'autre.
    const { mod, database, clock } = await setup({ corpus: CLEAN_CORPUS })
    await mod.rebuildVoiceProfile({ clock })
    await new ConfigRepo(database, new FakeClock()).update({ ownHandle: 'AUTRECOMPTE' })

    const status = await mod.voiceProfileStatus({ clock })
    expect(status.exists).toBe(false)
    expect(status.stale).toBe(true)
  })

  it('expose le taux d’exclusion dans l’état, pour l’UI', async () => {
    const { mod, clock } = await setup({
      corpus: [...PROMO_CORPUS, ...CLEAN_CORPUS.slice(0, 2)],
    })
    await mod.rebuildVoiceProfile({ clock })
    const status = await mod.voiceProfileStatus({ clock })
    expect(status.guardExcludedRatio).toBeGreaterThan(0.7)
    expect(status.usable).toBe(false)
  })
})
