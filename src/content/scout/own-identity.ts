/**
 * Détection du handle de l'utilisateur connecté.
 *
 * Confort d'onboarding : proposer le handle plutôt que le faire saisir. **On ne s'y fie
 * jamais seul** — l'utilisateur confirme dans l'UI. Un handle mal détecté ferait collecter
 * le corpus de quelqu'un d'autre et construirait un Voice Profile qui n'est pas le sien,
 * ce qui est pire qu'une saisie manuelle.
 *
 * Deux chemins de lecture, parce que X change régulièrement l'un ou l'autre : le lien de
 * profil de la barre latérale (le `href` est canonique) et le bouton de compte (dont le
 * texte contient `@handle`).
 */
import { SIDENAV_ACCOUNT, SIDENAV_PROFILE_LINK } from '../dom/x-selectors'
import { queryOne, type ReportSink, noopSink } from '../dom/query'

export interface DetectedIdentity {
  handle: string
  /** Comment le handle a été trouvé — affiché à l'utilisateur pour qu'il puisse juger. */
  source: 'profile-link' | 'account-button'
}

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/

/** Chemins qui ne sont pas des handles, même s'ils en ont la forme. */
const RESERVED = new Set([
  'home',
  'explore',
  'notifications',
  'messages',
  'bookmarks',
  'settings',
  'search',
  'i',
  'compose',
])

export function detectOwnHandle(
  root: ParentNode = document,
  report: ReportSink = noopSink,
): DetectedIdentity | null {
  // 1. Le href du lien de profil est la source la plus fiable : c'est un identifiant, pas
  //    un libellé traduisible.
  const link = queryOne<HTMLAnchorElement>(root, SIDENAV_PROFILE_LINK, report).el
  const fromHref = handleFromHref(link?.getAttribute('href'))
  if (fromHref) return { handle: fromHref, source: 'profile-link' }

  // 2. Repli : le texte du bouton de compte contient `@handle`.
  const account = queryOne(root, SIDENAV_ACCOUNT, report).el
  const fromText = (account?.textContent ?? '').match(/@([A-Za-z0-9_]{1,15})\b/)
  if (fromText?.[1]) return { handle: fromText[1], source: 'account-button' }

  return null
}

function handleFromHref(href: string | null | undefined): string | null {
  if (!href) return null
  const match = href.match(/^\/([A-Za-z0-9_]{1,15})(?:$|[/?])/)
  const handle = match?.[1]
  if (!handle || !HANDLE_RE.test(handle) || RESERVED.has(handle.toLowerCase()))
    return null
  return handle
}

/**
 * Sommes-nous sur le profil de `handle` ?
 *
 * Garde-fou du collecteur : il ne doit fonctionner que sur le profil de l'utilisateur
 * lui-même. Vérifier l'URL plutôt que faire confiance à l'appelant est ce qui empêche un
 * bug d'UI de transformer l'outil en collecteur de profils tiers.
 */
export function isOwnProfilePage(url: URL, handle: string): boolean {
  const normalized = handle.replace(/^@/, '').toLowerCase()
  const match = url.pathname.match(
    /^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|media|highlights))?\/?$/,
  )
  return match?.[1]?.toLowerCase() === normalized
}
