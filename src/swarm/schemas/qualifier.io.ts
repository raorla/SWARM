/**
 * Contrat du QUALIFIER.
 *
 * Deux contraintes portées par le schéma :
 *
 *  - **`note` est bornée à 40 caractères.** Ce n'est pas de la coquetterie : la sortie du
 *    QUALIFIER est multipliée par 200 chaque jour, et c'est elle qui décide si le DoD de la
 *    Phase 3 (200 posts pour moins de 0,05 €) tient. Un champ libre de 400 caractères
 *    tripleraient le coût du triage.
 *  - **`angle` est nullable et l'enum est fermé.** Un angle inventé ne serait mesurable par
 *    aucun pattern, donc invisible pour la boucle d'apprentissage de la Phase 5.
 */
import { z } from 'zod'
import { AngleSchema } from '@/niches/pack.schema'

export const QualifierVerdictSchema = z.object({
  /** Index du post dans le lot, transmis en chaîne pour rester lisible côté modèle. */
  id: z.string().min(1).max(8),
  relevance: z.number().min(0).max(1),
  angle: AngleSchema.nullable().default(null),
  note: z.string().max(40).default(''),
})

/**
 * Forme **compacte** attendue du modèle : `[id, relevance, angle, note?]`.
 *
 * ## Pourquoi un tuple et pas un objet
 *
 * Mesuré le 2026-08-26 sur appels réels : la forme objet coûtait ~54 tokens de sortie par
 * verdict, dont une bonne moitié en noms de clés répétés cinquante fois par lot. Comme Haiku
 * facture la sortie **cinq fois** l'entrée, c'est cette verbosité — et rien d'autre — qui
 * faisait sauter le DoD de la Phase 3 : 0,065 € pour 200 posts au lieu de 0,05 €.
 *
 * Le tuple supprime les clés. Les noms de champs n'apportaient aucune information au modèle :
 * l'ordre est décrit une fois dans le prompt, qui est lui-même mis en cache.
 *
 * `note` est **optionnelle et attendue vide la plupart du temps** : elle sert à comprendre un
 * tri surprenant, pas à commenter chaque post. Cinquante notes de huit tokens, c'est 400 tokens
 * de sortie payés au tarif le plus cher pour du texte que personne ne lit.
 */
export const CompactVerdictSchema = z.tuple([
  // Le modèle renvoie parfois l'index en nombre malgré la consigne. Le refuser pour ça serait
  // perdre un lot entier sur une coquille de typage.
  z.union([z.string().min(1).max(8), z.number().int().nonnegative()]),
  z.number().min(0).max(1),
  /**
   * Angle **tolérant** : toute chaîne est acceptée, et celles hors de l'énumération deviennent
   * `null`.
   *
   * Mesuré le 2026-08-26 : sur chaque lot de 50, trois ou quatre verdicts inventaient un angle
   * (« insight », « clarification »…). Avec un enum strict, ces trois verdicts invalidaient le
   * lot entier et déclenchaient un appel de réparation — un aller-retour payé pour trois lignes.
   *
   * Un angle inconnu n'est pas une donnée corrompue : c'est un angle qu'on ne sait pas
   * exploiter. `null` est exactement ce que ça veut dire, et `interpret` écarte déjà les angles
   * hors du pack de la même façon. Refuser le verdict entier était plus strict sans être plus
   * juste.
   */
  z
    .union([z.string().max(40), z.null()])
    .transform((value) => {
      if (value === null) return null
      const parsed = AngleSchema.safeParse(value)
      return parsed.success ? parsed.data : null
    }),
  z.string().max(40).optional(),
])

/**
 * Sortie du QUALIFIER, tolérante aux deux formes.
 *
 * On accepte aussi la forme objet : un modèle y retombe régulièrement, et refuser un lot de 50
 * posts pour une question de mise en forme coûterait plus cher que l'accepter. La tolérance est
 * asymétrique et voulue — on **demande** le compact, on **accepte** le verbeux.
 */
export const QualifierOutputSchema = z
  .object({
    verdicts: z
      .array(z.union([CompactVerdictSchema, QualifierVerdictSchema]))
      .max(80),
  })
  .transform((raw) => ({
    verdicts: raw.verdicts.map((v): QualifierVerdict =>
      Array.isArray(v)
        ? {
            id: String(v[0]),
            relevance: v[1],
            angle: v[2],
            note: v[3] ?? '',
          }
        : v,
    ),
  }))

export type QualifierVerdict = z.infer<typeof QualifierVerdictSchema>
export type QualifierOutput = z.infer<typeof QualifierOutputSchema>

/**
 * Taille de lot.
 *
 * 50 posts par appel : c'est le chiffrage de SPEC §3.2 (4 appels pour 200 posts). Plus grand,
 * le modèle commence à survoler la fin du lot ; plus petit, le prompt système est payé trop
 * souvent — c'est lui qui domine le coût d'entrée.
 */
export const QUALIFIER_BATCH_SIZE = 50

/**
 * Contradiction à corriger en aval : une pertinence haute sans angle.
 *
 * Le prompt le dit, mais un modèle le fait quand même. On tranche en faveur de la prudence —
 * pas d'angle signifie rien à apporter, donc pertinence plafonnée.
 */
export const NO_ANGLE_RELEVANCE_CAP = 0.35
