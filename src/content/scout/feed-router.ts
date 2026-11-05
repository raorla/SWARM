/**
 * Détection de la surface courante.
 *
 * La surface conditionne le scoring : un post vu dans les notifications nous concerne
 * déjà, un post de recherche est froid, un post de watchlist a une affinité auteur connue.
 * Confondre les deux fausserait l'EV.
 *
 * On lit l'URL plutôt que le DOM : l'URL est stable, le DOM change (SPEC §8).
 */

export type Surface = 'timeline' | 'search' | 'watchlist' | 'notifications' | 'bookmarks'

/** Surface non exploitable — on n'observe rien (réglages, messages privés, aide). */
export type Unsupported = 'unsupported'

export interface SurfaceContext {
  surface: Surface | Unsupported
  /** Handle du profil consulté, quand la surface est un profil. */
  profileHandle: string | null
  /** Requête de recherche, quand la surface est une recherche. */
  searchQuery: string | null
}

/**
 * Chemins où le produit ne doit rien faire, même passivement.
 *
 * `/messages` en fait partie et ce n'est pas un détail d'implémentation : SPEC §2.2
 * interdit toute lecture de DM. Ne pas observer une page est plus fort que filtrer ce
 * qu'on y a lu.
 */
const FORBIDDEN_PREFIXES = [
  '/messages',
  '/settings',
  '/i/keyboard_shortcuts',
  '/i/flow',
  '/login',
  '/logout',
  '/i/premium',
  '/account',
]

const RESERVED_HANDLES = new Set([
  'home',
  'explore',
  'notifications',
  'messages',
  'bookmarks',
  'settings',
  'search',
  'i',
  'compose',
  'intent',
  'hashtag',
  'topics',
  'lists',
])

export function detectSurface(
  url: URL,
  watchlist: readonly string[] = [],
): SurfaceContext {
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const none: SurfaceContext = {
    surface: 'unsupported',
    profileHandle: null,
    searchQuery: null,
  }

  if (FORBIDDEN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return none

  if (path === '/' || path === '/home') {
    return { surface: 'timeline', profileHandle: null, searchQuery: null }
  }
  if (path === '/notifications' || path.startsWith('/notifications/')) {
    return { surface: 'notifications', profileHandle: null, searchQuery: null }
  }
  if (path === '/i/bookmarks' || path.startsWith('/i/bookmarks')) {
    return { surface: 'bookmarks', profileHandle: null, searchQuery: null }
  }
  if (path === '/search') {
    return {
      surface: 'search',
      profileHandle: null,
      searchQuery: url.searchParams.get('q'),
    }
  }
  if (path === '/explore' || path.startsWith('/explore/')) {
    return { surface: 'search', profileHandle: null, searchQuery: null }
  }

  // Un fil de conversation : `/handle/status/123`. On le traite comme la surface d'origine
  // du parcours, c'est-à-dire la timeline — c'est là que l'utilisateur a cliqué.
  const statusMatch = path.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/)
  if (statusMatch) {
    const handle = statusMatch[1]!
    return {
      surface: watchlist.some((w) => eqHandle(w, handle)) ? 'watchlist' : 'timeline',
      profileHandle: handle,
      searchQuery: null,
    }
  }

  // Un profil : `/handle` ou `/handle/with_replies`.
  const profileMatch = path.match(
    /^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|highlights|media|likes))?$/,
  )
  if (profileMatch) {
    const handle = profileMatch[1]!
    if (RESERVED_HANDLES.has(handle.toLowerCase())) return none
    // Un profil hors watchlist reste observable, mais il compte comme de la recherche :
    // on n'a pas d'affinité établie avec ce compte.
    return {
      surface: watchlist.some((w) => eqHandle(w, handle)) ? 'watchlist' : 'search',
      profileHandle: handle,
      searchQuery: null,
    }
  }

  return none
}

export function eqHandle(a: string, b: string): boolean {
  return a.replace(/^@/, '').toLowerCase() === b.replace(/^@/, '').toLowerCase()
}

/** L'observation est-elle autorisée sur cette surface ? */
export function isObservable(
  ctx: SurfaceContext,
): ctx is SurfaceContext & { surface: Surface } {
  return ctx.surface !== 'unsupported'
}
