/**
 * DOM → `ExtractedPost`.
 *
 * Toutes les interrogations passent par `dom/query.ts`, donc chaque tentative alimente la
 * télémétrie de santé : quand X change son DOM, on sait *quel* champ a cessé de se lire,
 * pas seulement que « ça ne marche plus ».
 *
 * Principe d'écriture : préférer un échec explicite à une valeur inventée. Un post dont
 * l'auteur ne se lit pas est écarté ; il n'est jamais attribué à un handle deviné.
 */
import {
  ACTION_BAR,
  LIKE_BUTTON,
  POST_AUTHOR_BLOCK,
  POST_AUTHOR_LINK,
  POST_MEDIA,
  POST_PERMALINK,
  POST_QUOTE,
  POST_TEXT,
  POST_TIME,
  REPLY_BUTTON,
  REPOST_BUTTON,
} from '../dom/x-selectors'
import { exists, queryOne, readMetric, type ReportSink } from '../dom/query'
import {
  ExtractedPostSchema,
  type ExtractedPost,
  type ExtractionFailure,
} from '../dom/dom-schemas'
import type { Surface } from './feed-router'
import { err, ok, type Result } from '@/shared/result'
import type { Clock } from '@/shared/time'

export interface ExtractOptions {
  surface: Surface
  clock: Clock
  report: ReportSink
  /** Handle de l'utilisateur, pour marquer ses propres posts (Voice Profile, Phase 2). */
  ownHandle: string | null
}

/**
 * Un post sponsorisé n'est pas une opportunité : y répondre est du bruit, et le compte
 * annonceur n'a pas de relation à construire. On le détecte avant tout le reste, pour ne
 * pas polluer la télémétrie de santé avec des structures publicitaires atypiques.
 */
function isPromoted(article: Element): boolean {
  const text = article.textContent ?? ''
  if (/\b(Promoted|Sponsorisé|Ad\b)/i.test(text.slice(0, 400))) return true
  return article.querySelector('[data-testid="placementTracking"]') !== null
}

/** `/handle/status/1234567890` → `{ handle, postId }`. */
export function parsePermalink(href: string): { handle: string; postId: string } | null {
  const match = href.match(
    /^(?:https?:\/\/[^/]+)?\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/,
  )
  if (!match) return null
  return { handle: match[1]!, postId: match[2]! }
}

export function extractPost(
  article: Element,
  opts: ExtractOptions,
): Result<ExtractedPost, ExtractionFailure> {
  if (isPromoted(article)) {
    return err({ kind: 'promoted', detail: 'placement publicitaire' })
  }

  // 1. Lien permanent → identifiant et handle canonique. C'est la seule source fiable des
  //    deux : le texte affiché peut être un nom traduit ou décoré.
  const permalinkEl = queryOne<HTMLAnchorElement>(article, POST_PERMALINK, opts.report).el
  const href = permalinkEl?.getAttribute('href') ?? null
  const parsed = href ? parsePermalink(href) : null
  if (!parsed) {
    return err({
      kind: 'no-permalink',
      detail: href === null ? 'aucun lien /status/ trouvé' : `href non reconnu : ${href}`,
    })
  }

  // 2. Bloc auteur — présence requise ; le nom d'affichage reste optionnel.
  const authorBlock = queryOne(article, POST_AUTHOR_BLOCK, opts.report).el
  if (!authorBlock) {
    return err({ kind: 'no-author', detail: 'bloc auteur absent' })
  }
  const authorLink = queryOne<HTMLAnchorElement>(
    article,
    POST_AUTHOR_LINK,
    opts.report,
  ).el
  const displayName = readDisplayName(authorBlock)

  // Le handle du lien auteur prime sur celui du permalien : dans un fil, le permalien du
  // post racine peut appartenir à un autre compte que celui de la réponse affichée.
  const authorHandle = handleFromHref(authorLink?.getAttribute('href')) ?? parsed.handle

  // 3. Horodatage.
  const timeEl = queryOne<HTMLTimeElement>(article, POST_TIME, opts.report).el
  const datetime = timeEl?.getAttribute('datetime')
  const postedAtMs = datetime ? Date.parse(datetime) : NaN
  if (!Number.isFinite(postedAtMs)) {
    return err({
      kind: 'no-timestamp',
      detail:
        datetime === undefined || datetime === null
          ? 'attribut datetime absent'
          : `illisible : ${datetime}`,
    })
  }

  // 4. Texte. Un post peut légitimement n'être qu'une image : chaîne vide, pas échec.
  //    On ne renvoie une erreur que si le sélecteur lui-même a disparu ET qu'il n'y a
  //    aucun média — auquel cas le post n'a aucun contenu lisible, ce qui n'existe pas.
  const textEl = queryOne(article, POST_TEXT, opts.report).el
  const text = textEl?.textContent?.trim() ?? ''
  const hasMedia = exists(article, POST_MEDIA)
  if (textEl === null && !hasMedia) {
    return err({ kind: 'no-text', detail: 'ni texte ni média' })
  }

  // 5. Métriques, lues depuis la barre d'actions.
  const bar = queryOne(article, ACTION_BAR, opts.report).el ?? article
  const replyCount = readMetric(queryOne(bar, REPLY_BUTTON, opts.report).el)
  const likeCount = readMetric(queryOne(bar, LIKE_BUTTON, opts.report).el)
  const repostCount = readMetric(queryOne(bar, REPOST_BUTTON, opts.report).el)

  const candidate = {
    postId: parsed.postId,
    authorHandle,
    authorDisplayName: displayName,
    text,
    lang: textEl?.getAttribute('lang') ?? null,
    postedAtMs,
    replyCount,
    likeCount,
    repostCount,
    hasMedia,
    hasQuote: exists(article, POST_QUOTE),
    // « Replying to » / « En réponse à » précède le texte dans un fil.
    isReply: /(?:Replying to|En réponse à)/i.test(
      (article.textContent ?? '').slice(0, 300),
    ),
    isOwnPost:
      opts.ownHandle !== null &&
      authorHandle.toLowerCase() === opts.ownHandle.replace(/^@/, '').toLowerCase(),
    surface: opts.surface,
    observedAtMs: opts.clock.now(),
    permalink: `/${authorHandle}/status/${parsed.postId}`,
  }

  const validated = ExtractedPostSchema.safeParse(candidate)
  if (!validated.success) {
    return err({
      kind: 'schema',
      issues: validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    })
  }
  return ok(validated.data)
}

function handleFromHref(href: string | null | undefined): string | null {
  if (!href) return null
  const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:$|[/?])/)
  return m?.[1] ?? null
}

/**
 * Le nom d'affichage est le premier fragment de texte du bloc auteur, avant le `@handle`.
 * X y intercale des badges (vérification, abonnement) qui n'ont pas de texte, et parfois
 * le handle et l'horodatage dans le même conteneur — d'où la coupe au premier `@`.
 */
function readDisplayName(authorBlock: Element): string | null {
  const raw = authorBlock.textContent ?? ''
  const beforeHandle = raw.split('@')[0] ?? ''
  const cleaned = beforeHandle.replace(/\s+/g, ' ').trim()
  return cleaned === '' ? null : cleaned.slice(0, 200)
}
