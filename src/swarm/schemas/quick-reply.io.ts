/**
 * Contrat d'entrée/sortie de l'agent QUICK-REPLY.
 *
 * Le schéma de sortie est volontairement fermé sur `decision` : un modèle qui hésite doit
 * choisir `decline`, pas inventer une troisième voie. Un enum ouvert laisserait passer
 * « maybe », et il faudrait décider en aval ce que ça veut dire — c'est-à-dire deviner.
 */
import { z } from 'zod'
import { AngleSchema } from '@/niches/pack.schema'

export const QuickReplyOutputSchema = z.object({
  decision: z.enum(['reply', 'decline']),
  text: z.string().max(500),
  angle: AngleSchema,
  reasoning: z.string().max(400),
  confidence: z.number().min(0).max(1),
})

export type QuickReplyOutput = z.infer<typeof QuickReplyOutputSchema>

/**
 * Une réponse X fait 280 caractères. On accepte jusqu'à 500 dans le schéma pour ne pas
 * rejeter une sortie légèrement trop longue — qu'on tronquera proprement — mais on
 * signale le dépassement plutôt que de le masquer : c'est l'utilisateur qui décide de
 * couper, pas nous.
 */
export const X_REPLY_LIMIT = 280

export interface QuickReplyResult {
  decision: 'reply' | 'decline'
  text: string
  angle: string
  reasoning: string
  confidence: number
  /** Vrai si le texte dépasse la limite de X — affiché dans l'overlay. */
  overLimit: boolean
  costEur: number
  model: string
  latencyMs: number
  /** Hash du prompt qui a produit ce texte (MH-04). */
  promptVersionHash: string
  repaired: boolean
}
