/**
 * ENREGISTREUR D'ARCHIVE — la matière du backtest.
 *
 * ## Opt-in nommé, et pourquoi (MH-13)
 *
 * La rétention par défaut purge le texte brut à 30 jours. L'archive de backtest est l'exception
 * explicite : elle conserve du contenu de tiers pour pouvoir le rejouer. C'est donc un choix
 * séparé, avec sa propre durée de vie, et il doit être **nommé** — pas un effet de bord d'une
 * option « activer les statistiques ».
 */
import type { ArchivedPost, Archive, ArchiveMeta } from './replay'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import type { NichePack } from '@/niches/pack.schema'
import { DAY, type Clock } from '@/shared/time'

/** Durée de vie d'une archive, indépendante de la rétention générale. */
export const ARCHIVE_TTL_MS = 45 * DAY

/** Taille au-delà de laquelle l'archive cesse de grossir. */
export const MAX_ARCHIVE_POSTS = 5_000

export interface RecorderState {
  enabled: boolean
  posts: ArchivedPost[]
  startedAtMs: number | null
}

export function emptyRecorder(): RecorderState {
  return { enabled: false, posts: [], startedAtMs: null }
}

/**
 * Ajoute un post à l'archive, avec son verdict de pertinence.
 *
 * Le verdict est **obligatoire** : archiver un post sans lui reviendrait à devoir rappeler le
 * modèle au rejeu, ce qui détruirait le déterminisme — la seule propriété qui rend le backtest
 * utile.
 */
export function record(
  state: RecorderState,
  post: ExtractedPost,
  verdict: { relevance: number; angle: string | null },
  clock: Clock,
): RecorderState {
  if (!state.enabled) return state

  const archived: ArchivedPost = {
    postId: post.postId,
    authorHandle: post.authorHandle,
    // Le fil de X n'expose pas le nombre d'abonnés : l'archive le note comme inconnu plutôt
    // que d'inventer une valeur, ce qui rendrait le rejeu confiant et faux.
    authorFollowers: null,
    text: post.text,
    lang: post.lang,
    postedAtMs: post.postedAtMs,
    observedAtMs: post.observedAtMs,
    replyCount: post.replyCount,
    likeCount: post.likeCount,
    repostCount: post.repostCount,
    hasMedia: post.hasMedia,
    isReply: post.isReply,
    surface: post.surface,
    archivedRelevance: verdict.relevance,
    archivedAngle: verdict.angle,
  }

  // Déduplication : le scout revoit les mêmes posts, et les archiver plusieurs fois
  // surpondérerait ceux que l'utilisateur a le plus scrollés.
  const existing = state.posts.findIndex((p) => p.postId === archived.postId)
  const posts = [...state.posts]
  if (existing >= 0) posts[existing] = archived
  else posts.push(archived)

  return {
    ...state,
    startedAtMs: state.startedAtMs ?? clock.now(),
    // Fenêtre glissante : on garde les plus récents. Une archive plafonnée aux plus anciens
    // deviendrait progressivement non représentative du fil actuel.
    posts: posts.length > MAX_ARCHIVE_POSTS ? posts.slice(-MAX_ARCHIVE_POSTS) : posts,
  }
}

/** Retire les posts trop vieux pour l'archive. */
export function prune(state: RecorderState, clock: Clock): RecorderState {
  const cutoff = clock.now() - ARCHIVE_TTL_MS
  return { ...state, posts: state.posts.filter((p) => p.observedAtMs >= cutoff) }
}

export function seal(state: RecorderState, pack: NichePack): Archive {
  const posts = [...state.posts].sort((a, b) => a.observedAtMs - b.observedAtMs)
  const meta: ArchiveMeta = {
    formatVersion: 1,
    recordedFromMs: posts[0]?.observedAtMs ?? 0,
    recordedToMs: posts[posts.length - 1]?.observedAtMs ?? 0,
    postCount: posts.length,
    // Un verdict n'est comparable qu'à pack égal : rejouer une archive memecoin sous un pack
    // saas donnerait des chiffres sans signification.
    nichePackId: pack.id,
    nichePackVersion: pack.version,
  }
  return { meta, posts }
}

/** L'archive est-elle rejouable sous ce pack ? */
export function isCompatible(
  archive: Archive,
  pack: NichePack,
): { compatible: boolean; reason: string | null } {
  if (archive.meta.nichePackId !== pack.id) {
    return {
      compatible: false,
      reason: `archive enregistrée sous le pack « ${archive.meta.nichePackId} », pack actif « ${pack.id} » : les verdicts de pertinence ne sont pas comparables`,
    }
  }
  if (archive.meta.nichePackVersion !== pack.version) {
    // Une version différente change le brief de niche, donc les verdicts. On autorise, en
    // avertissant : refuser rendrait toute archive inutilisable au premier ajustement de pack.
    return {
      compatible: true,
      reason: `archive enregistrée sous la version ${archive.meta.nichePackVersion} du pack, active en ${pack.version} : les verdicts peuvent avoir dérivé`,
    }
  }
  return { compatible: true, reason: null }
}

export function describeArchive(archive: Archive): string {
  if (archive.posts.length === 0) return 'Archive vide.'
  const spanDays = Math.max(
    1,
    Math.round((archive.meta.recordedToMs - archive.meta.recordedFromMs) / DAY),
  )
  return `${archive.meta.postCount} posts sur ${spanDays} jours, pack ${archive.meta.nichePackId} v${archive.meta.nichePackVersion}.`
}
