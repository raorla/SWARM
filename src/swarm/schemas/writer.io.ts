/**
 * Contrat du WRITER.
 *
 * Deux contraintes portées par le schéma plutôt que par le prompt, parce qu'un prompt se
 * contourne et qu'un schéma se rejette :
 *
 *  - `angle` est un enum fermé. Un angle inventé ne serait mesurable par aucun pattern,
 *    donc invisible pour la boucle d'apprentissage de la Phase 5.
 *  - `variants` est borné à 3. Un modèle bavard en produirait dix, et l'utilisateur ne peut
 *    pas arbitrer dix propositions dans son fil.
 */
import { z } from 'zod'
import { AngleSchema } from '@/niches/pack.schema'

export const WriterVariantSchema = z.object({
  text: z.string().min(1).max(600),
  angle: AngleSchema,
  intent: z.string().max(300),
})

export const WriterOutputSchema = z
  .object({
    variants: z.array(WriterVariantSchema).max(3),
    sharedContext: z.string().max(500).default(''),
    declineReason: z.string().max(400).nullable().default(null),
  })
  .refine((o) => o.variants.length > 0 || o.declineReason !== null, {
    message: 'variants vide exige un declineReason',
  })
  .refine((o) => o.variants.length === 0 || o.declineReason === null, {
    // Un modèle qui remplit les deux n'a pas décidé. Trancher en aval serait deviner.
    message: 'variants et declineReason sont exclusifs',
  })

export type WriterOutput = z.infer<typeof WriterOutputSchema>
export type WriterVariant = z.infer<typeof WriterVariantSchema>
