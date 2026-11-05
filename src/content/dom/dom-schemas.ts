/**
 * Validation Zod du DOM parsé — SPEC §8, « Zod à chaque frontière ».
 *
 * Le DOM de X est une frontière comme une autre : on n'en contrôle ni la forme ni la
 * stabilité. Un `replyCount` qui vaut `NaN` parce qu'un compteur a changé de format
 * traverserait tout le pipeline et produirait un score EV silencieusement faux — le pire
 * mode de défaillance pour un produit dont l'argument est la mesure.
 *
 * Ici, il échoue à l'extraction, avec un motif.
 */
import { z } from 'zod'
import { HandleSchema, XPostIdSchema } from '@/shared/zod-helpers'

export const SurfaceSchema = z.enum([
  'timeline',
  'search',
  'watchlist',
  'notifications',
  'bookmarks',
])

/**
 * Post extrait du DOM, avant tout traitement.
 *
 * Les métriques sont `nullable` et non `.default(0)` : « inconnu » et « zéro » sont deux
 * choses différentes pour le scoring de saturation, et les confondre ferait passer un post
 * à 2 000 réponses pour un post frais.
 */
export const ExtractedPostSchema = z.object({
  postId: XPostIdSchema,
  authorHandle: HandleSchema,
  authorDisplayName: z.string().max(200).nullable(),
  text: z.string().max(10_000),
  lang: z.string().min(2).max(8).nullable(),
  postedAtMs: z.number().int().positive(),
  replyCount: z.number().int().nonnegative().nullable(),
  likeCount: z.number().int().nonnegative().nullable(),
  repostCount: z.number().int().nonnegative().nullable(),
  hasMedia: z.boolean(),
  hasQuote: z.boolean(),
  isReply: z.boolean(),
  /** Vrai si le post est de l'utilisateur lui-même — sert à construire le Voice Profile. */
  isOwnPost: z.boolean(),
  surface: SurfaceSchema,
  observedAtMs: z.number().int().positive(),
  permalink: z.string().min(1),
})

export type ExtractedPost = z.infer<typeof ExtractedPostSchema>

/** Motifs d'échec d'extraction. Distingués pour que le diagnostic soit actionnable. */
export type ExtractionFailure =
  | { kind: 'no-permalink'; detail: string }
  | { kind: 'no-author'; detail: string }
  | { kind: 'no-timestamp'; detail: string }
  | { kind: 'no-text'; detail: string }
  | { kind: 'promoted'; detail: string }
  | { kind: 'schema'; issues: readonly string[] }

export function describeFailure(f: ExtractionFailure): string {
  switch (f.kind) {
    case 'no-permalink':
      return `lien permanent introuvable : ${f.detail}`
    case 'no-author':
      return `auteur introuvable : ${f.detail}`
    case 'no-timestamp':
      return `horodatage introuvable : ${f.detail}`
    case 'no-text':
      return `texte introuvable : ${f.detail}`
    case 'promoted':
      return 'post sponsorisé, écarté'
    case 'schema':
      return `hors schéma : ${f.issues.join(' · ')}`
  }
}
