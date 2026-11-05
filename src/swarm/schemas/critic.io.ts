/**
 * Contrat du CRITIC.
 *
 * Le schéma refuse les verdicts incohérents — `pass` sans variante retenue, `veto` avec une
 * variante retenue. C'est le genre d'incohérence qu'un modèle produit régulièrement, et la
 * résoudre en aval reviendrait à choisir à sa place : soit on publie une variante qu'il a
 * rejetée, soit on rejette une variante qu'il a validée. Les deux sont pires qu'un rejet
 * franc suivi d'une reprise.
 */
import { z } from 'zod'

export const CriticScoreSchema = z.object({
  index: z.number().int().nonnegative(),
  voiceAuthenticity: z.number().min(0).max(1),
  valueAdded: z.number().min(0).max(1),
  reputationRisk: z.number().min(0).max(1),
  redundancy: z.number().min(0).max(1),
  attentionCost: z.number().min(0).max(1),
  overall: z.number().min(0).max(1),
  note: z.string().max(400).default(''),
})

export const CriticOutputSchema = z
  .object({
    scores: z.array(CriticScoreSchema).min(1).max(3),
    verdict: z.enum(['pass', 'veto']),
    selectedIndex: z.number().int().nonnegative().nullable().default(null),
    rejectionReason: z.string().max(500).nullable().default(null),
  })
  .refine(
    (o) => (o.verdict === 'pass' ? o.selectedIndex !== null : o.selectedIndex === null),
    {
      message: 'pass exige selectedIndex, veto l’interdit',
    },
  )
  .refine(
    (o) =>
      o.verdict === 'veto' ? o.rejectionReason !== null : o.rejectionReason === null,
    { message: 'veto exige rejectionReason, pass l’interdit' },
  )

export type CriticOutput = z.infer<typeof CriticOutputSchema>
export type CriticScore = z.infer<typeof CriticScoreSchema>

/**
 * Seuil de veto par défaut sur `overall`. **Mesuré, plus deviné.**
 *
 * Calibré le 2026-08-26 sur les 18 réponses étiquetées à la main
 * (`npm run calibrate:critic`, rapport dans `docs/critic-calibration.md`). Ce que la mesure a
 * montré :
 *
 *  - le CRITIC discrimine nettement — les 6 réponses à publier notent 0,30 à 0,65, les 12 à
 *    rejeter notent 0,00 à 0,20 ;
 *  - **tout seuil entre 0,30 et 0,55 donne exactement le même résultat** : zéro faux positif,
 *    un seul faux négatif, 72 % de rejet ;
 *  - **l'ancien défaut de 0,6 était trop haut.** À 0,60, le rappel s'effondre de 83 % à 17 % :
 *    cinq bonnes réponses sur six auraient été rejetées. Le produit aurait paru fonctionner —
 *    aucun crash, aucune erreur — en refusant presque tout, et le diagnostic aurait été
 *    cherché du côté du WRITER.
 *
 * 0,45 est le milieu du plateau, pas son bord : même score mesuré, marge maximale de chaque
 * côté. Le seuil se règle sur des notes qui bougeront — mise à jour du modèle, prompt retouché
 * — et 0,55 était collé à la falaise.
 *
 * Réserve honnête : 18 échantillons, c'est indicatif. Le rapport le dit, et il faut viser 40+.
 */
export const DEFAULT_VETO_THRESHOLD = 0.45

/**
 * Plafond de risque réputationnel, indépendant du seuil global.
 *
 * Une variante excellente sur tous les autres axes mais risquée doit être rejetée : la
 * moyenne masquerait précisément le cas qu'on veut attraper.
 */
export const MAX_REPUTATION_RISK = 0.5
