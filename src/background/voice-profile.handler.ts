/**
 * Construction et entretien du Voice Profile, côté service worker.
 *
 * Le content script collecte, le service worker persiste et construit. La séparation n'est
 * pas cosmétique : le profil est écrit en base, et le content script n'a pas accès à
 * IndexedDB de l'extension.
 *
 * ## Péremption
 *
 * Un profil vieilli est plus dangereux qu'un profil absent : le produit croit connaître un
 * style qui a changé, et le CRITIC valide des variantes qui ne ressemblent plus à
 * l'utilisateur. On détecte donc deux formes d'obsolescence — l'âge, et l'écart entre le
 * corpus au moment de la construction et le corpus actuel.
 */
import { db } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { OwnPostRepo, type OwnPostInput } from '@/db/repositories/own-post.repo'
import {
  buildVoiceProfile,
  describeProfile,
  isProfileUsable,
} from '@/memory/voice-profile'
import { NichePackFileSchema, type NichePack } from '@/niches/pack.schema'
import { bundledPack, FALLBACK_PACK_ID } from '@/niches/loader'
import type { VoiceProfileRecord } from '@/db/schema'
import { DAY, systemClock, type Clock } from '@/shared/time'
import { createLogger } from '@/shared/logger'

const log = createLogger('background:voice-profile')

/**
 * Dépendances injectables — MH-17 appliqué au background.
 *
 * Ce module figeait `systemClock` au niveau du module, alors que `qualify.handler.ts` et
 * `queue.handler.ts` avaient déjà été corrigés : il était resté en dehors du passage. La
 * conséquence n'était pas seulement une gêne de test — la péremption du profil se calculait
 * avec l'horloge réelle contre un `builtAtMs` écrit avec l'horloge injectée, donc l'âge était
 * faux dès que les deux différaient.
 *
 * Le défaut s'est révélé au changement de date : le test passait parce que la date simulée
 * valait la date du jour, et il a échoué le lendemain. C'est exactement le genre de test qui
 * paraît instable et qui signale un vrai bug.
 */
export interface VoiceDeps {
  clock: Clock
}

const defaultDeps: VoiceDeps = { clock: systemClock }

/**
 * Au-delà, le profil est considéré vieilli.
 *
 * 30 jours : un style d'écriture évolue lentement, mais un compte qui change de sujet ou de
 * ton le fait en quelques semaines. Assez long pour ne pas harceler, assez court pour ne pas
 * imiter quelqu'un qui a changé.
 */
export const PROFILE_STALE_AFTER_MS = 30 * DAY

/** Nouveaux posts depuis la construction au-delà desquels le profil mérite une reprise. */
export const PROFILE_STALE_AFTER_NEW_POSTS = 40

async function loadActivePack(clock: Clock): Promise<NichePack> {
  const config = await new ConfigRepo(db(), clock).get()
  const record = await db().nichePacks.get(config.activeNichePackId)
  if (record) {
    const parsed = NichePackFileSchema.safeParse(JSON.parse(record.json))
    if (parsed.success) return parsed.data.pack
  }
  const fallback = bundledPack(config.activeNichePackId) ?? bundledPack(FALLBACK_PACK_ID)
  if (!fallback) throw new Error('aucun pack disponible')
  return fallback
}

/* ──────────────────────────── Ingestion du corpus ────────────────────────── */

export interface IngestResult {
  received: number
  corpusSize: number
  passingGuard: number
  excludedRatio: number
}

/**
 * Enregistre des posts collectés.
 *
 * La qualification par le garde-fou est faite ici, à l'écriture (MH-18) : le Voice Profile
 * la relira des dizaines de fois et le classifieur n'a pas à tourner en boucle.
 */
export async function ingestOwnPosts(
  payload: { posts: readonly OwnPostInput[] },
  deps: VoiceDeps = defaultDeps,
): Promise<IngestResult> {
  const { clock } = deps
  const pack = await loadActivePack(clock)
  const repo = new OwnPostRepo(db(), clock)

  await repo.upsertMany(payload.posts, pack.additionalBlockedTopics)
  const stats = await repo.stats()

  log.info('corpus enrichi', {
    received: payload.posts.length,
    total: stats.total,
    passing: stats.passingGuard,
  })

  return {
    received: payload.posts.length,
    corpusSize: stats.total,
    passingGuard: stats.passingGuard,
    excludedRatio: stats.excludedRatio,
  }
}

/* ────────────────────────── Construction du profil ───────────────────────── */

export interface BuildResult {
  built: boolean
  reason?: string
  profile?: {
    sampleSize: number
    guardExcludedRatio: number
    confidence: number
    canonicalExamples: number
    usable: boolean
    summary: string
  }
}

export async function rebuildVoiceProfile(deps: VoiceDeps = defaultDeps): Promise<BuildResult> {
  const { clock } = deps
  const configRepo = new ConfigRepo(db(), clock)
  const config = await configRepo.get()

  if (!config.ownHandle) {
    return {
      built: false,
      reason: 'aucun handle configuré — impossible de savoir de qui est le corpus',
    }
  }

  const repo = new OwnPostRepo(db(), clock)
  const posts = await repo.all()

  if (posts.length === 0) {
    // Un profil vide serait pire qu'aucun profil : le WRITER croirait avoir une référence.
    return { built: false, reason: 'corpus vide — lance une collecte depuis ton profil' }
  }

  const pack = await loadActivePack(clock)

  // Requalification avant construction : si le pack a changé ses sujets bloqués depuis la
  // dernière collecte, `passesGuard` reflète des règles périmées et le profil s'appuierait
  // sur une qualification fausse.
  const { changed } = await repo.requalify(pack.additionalBlockedTopics)
  const corpus = changed > 0 ? await repo.all() : posts

  const profile = buildVoiceProfile({
    handle: config.ownHandle,
    posts: corpus,
    pack,
    clock,
  })

  await db().voiceProfile.put(profile)

  log.info('Voice Profile reconstruit', {
    sampleSize: profile.sampleSize,
    excluded: profile.guardExcludedCount,
    confidence: profile.confidence,
    requalified: changed,
  })

  return {
    built: true,
    profile: {
      sampleSize: profile.sampleSize,
      guardExcludedRatio: profile.guardExcludedRatio,
      confidence: profile.confidence,
      canonicalExamples: profile.canonicalExamples.length,
      usable: isProfileUsable(profile),
      summary: describeProfile(profile),
    },
  }
}

/* ──────────────────────────────── Péremption ─────────────────────────────── */

export type StalenessReason = 'absent' | 'age' | 'nouveaux-posts' | 'pack-change' | null

export interface ProfileStatus {
  exists: boolean
  handle: string | null
  sampleSize: number
  passingGuard: number
  guardExcludedRatio: number
  confidence: number
  usable: boolean
  builtAtMs: number | null
  ageMs: number | null
  /** Posts ajoutés au corpus depuis la construction. */
  newPostsSinceBuild: number
  stale: boolean
  staleReason: StalenessReason
  summary: string
}

/**
 * État du profil, pour l'onglet Config.
 *
 * Renvoie toujours un objet exploitable, même sans profil : l'UI doit pouvoir afficher
 * « rien encore » sans traiter un `null`.
 */
export async function voiceProfileStatus(
  deps: VoiceDeps = defaultDeps,
): Promise<ProfileStatus> {
  const { clock } = deps
  const config = await new ConfigRepo(db(), clock).get()
  const repo = new OwnPostRepo(db(), clock)
  const corpusStats = await repo.stats()
  const profile: VoiceProfileRecord | undefined = await db().voiceProfile.get('current')

  if (!profile) {
    return {
      exists: false,
      handle: config.ownHandle,
      sampleSize: corpusStats.total,
      passingGuard: corpusStats.passingGuard,
      guardExcludedRatio: corpusStats.excludedRatio,
      confidence: 0,
      usable: false,
      builtAtMs: null,
      ageMs: null,
      newPostsSinceBuild: corpusStats.total,
      stale: true,
      staleReason: 'absent',
      summary:
        corpusStats.total === 0
          ? 'Aucun corpus. Va sur ton profil et lance une collecte.'
          : `${corpusStats.total} posts collectés, profil pas encore construit.`,
    }
  }

  const ageMs = clock.now() - profile.builtAtMs
  const newPosts = Math.max(0, corpusStats.total - profile.sampleSize)

  // Un handle qui a changé invalide le profil entièrement : ce n'est plus la même personne.
  const handleChanged =
    config.ownHandle !== null &&
    config.ownHandle.replace(/^@/, '').toLowerCase() !== profile.handle.toLowerCase()

  const staleReason: StalenessReason = handleChanged
    ? 'absent'
    : ageMs > PROFILE_STALE_AFTER_MS
      ? 'age'
      : newPosts >= PROFILE_STALE_AFTER_NEW_POSTS
        ? 'nouveaux-posts'
        : null

  return {
    exists: !handleChanged,
    handle: config.ownHandle,
    sampleSize: profile.sampleSize,
    passingGuard: corpusStats.passingGuard,
    guardExcludedRatio: profile.guardExcludedRatio,
    confidence: profile.confidence,
    usable: isProfileUsable(profile),
    builtAtMs: profile.builtAtMs,
    ageMs,
    newPostsSinceBuild: newPosts,
    stale: staleReason !== null,
    staleReason,
    summary: describeProfile(profile),
  }
}

/** Message lisible de péremption. Dit *pourquoi* reprendre, pas seulement qu'il faut. */
export function describeStaleness(status: ProfileStatus): string | null {
  switch (status.staleReason) {
    case null:
      return null
    case 'absent':
      return status.sampleSize === 0
        ? 'Aucun profil : le WRITER écrit en registre neutre et le CRITIC est plus sévère.'
        : 'Profil à construire depuis le corpus collecté.'
    case 'age':
      return `Profil construit il y a ${Math.round((status.ageMs ?? 0) / DAY)} jours. Un style évolue : re-entraîne pour éviter d’imiter quelqu’un qui a changé.`
    case 'nouveaux-posts':
      return `${status.newPostsSinceBuild} nouveaux posts depuis la construction. Le profil ignore ta production récente.`
    case 'pack-change':
      return 'Le pack de niche a changé : la qualification du corpus est à refaire.'
  }
}
