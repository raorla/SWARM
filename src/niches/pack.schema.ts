/**
 * Niche Pack — FEEDBACK MH-10.
 *
 * Le compte pilote est memecoin, la clientèle ne l'est pas. Si la niche fuit dans le
 * TypeScript, chaque nouveau client devient un fork. Un pack déclaratif rend
 * l'agnosticisme *testable* — la CI fait tourner le même code sur plusieurs packs — au
 * lieu de simplement affirmé.
 *
 * Contrainte de sécurité du schéma : un pack peut **ajouter** des sujets bloqués, jamais
 * en retirer. Le noyau universel (santé, deuil, politique, crise, contenu financier)
 * vit dans governor/topic-guard.ts et n'est pas adressable depuis un pack.
 */
import { z } from 'zod'
import { HandleSchema } from '@/shared/zod-helpers'

/** Angles qu'un STRATEGIST peut choisir. Fermé volontairement : un angle inconnu ne
 *  serait mesurable par aucun pattern, donc invisible pour la boucle d'apprentissage. */
export const AngleSchema = z.enum([
  'counterpoint', // contre-argument étayé
  'data', // donnée chiffrée, source
  'anecdote', // expérience vécue
  'question', // relance qui ouvre
  'joke', // humour
  'resource', // ressource utile
  'amplify', // reformulation qui prolonge
])
export type Angle = z.infer<typeof AngleSchema>

/** Poids de la formule EV — SPEC §4.2. Réglables par pack et par utilisateur. */
export const EvWeightsSchema = z.object({
  reach: z.number().min(0).max(5).default(1),
  nicheRelevance: z.number().min(0).max(5).default(1.5),
  freshness: z.number().min(0).max(5).default(1),
  saturationPenalty: z.number().min(0).max(5).default(1),
  authorAffinity: z.number().min(0).max(5).default(1),
})
export type EvWeights = z.infer<typeof EvWeightsSchema>

export const NichePackSchema = z.object({
  /** Identifiant stable, sert de clé en base et de nom de fichier. */
  id: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9-]+$/, 'identifiant en kebab-case minuscule'),
  /** Version du contenu du pack, pour tracer quel pack a produit quel résultat. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver requis'),
  label: z.string().min(2).max(80),
  description: z.string().max(500).default(''),

  /** Décrit la niche au STRATEGIST et au WRITER, en langue naturelle. */
  domainBrief: z.string().min(20).max(2_000),

  languages: z.array(z.string().min(2).max(8)).min(1).default(['fr', 'en']),

  /** Termes qui rendent un post candidat. Non exclusifs : le QUALIFIER note, il ne filtre pas binairement. */
  keywords: z.array(z.string().min(2).max(60)).max(200).default([]),
  /** Termes disqualifiants — bruit connu de la niche. */
  negativeKeywords: z.array(z.string().min(2).max(60)).max(200).default([]),
  /** Comptes à suivre en priorité. */
  watchlist: z.array(HandleSchema).max(500).default([]),
  /** Comptes à ne jamais approcher (concurrents, comptes toxiques, ex-clients…). */
  blocklist: z.array(HandleSchema).max(500).default([]),

  /**
   * Sujets bloqués **en plus** du noyau universel. Additif uniquement — un pack ne peut
   * pas débloquer santé/deuil/politique/crise/finance.
   */
  additionalBlockedTopics: z.array(z.string().min(2).max(80)).max(100).default([]),

  /** Vocabulaire propre à la niche : ce qu'on peut dire, ce qu'on ne dit pas. */
  lexicon: z
    .object({
      preferred: z.array(z.string().max(60)).max(200).default([]),
      banned: z.array(z.string().max(60)).max(200).default([]),
    })
    .default({ preferred: [], banned: [] }),

  /** Angles autorisés dans cette niche, par ordre de préférence initiale. */
  allowedAngles: z
    .array(AngleSchema)
    .min(1)
    .default(['counterpoint', 'data', 'question']),

  evWeights: EvWeightsSchema.default({
    reach: 1,
    nicheRelevance: 1.5,
    freshness: 1,
    saturationPenalty: 1,
    authorAffinity: 1,
  }),

  /** Seuils de qualification, réglables par niche. */
  thresholds: z
    .object({
      /** Au-delà, la conversation est saturée : notre réponse ne sera pas lue. */
      maxReplyCount: z.number().int().positive().max(10_000).default(150),
      /** Au-delà, le post est mort : répondre coûte sans rapporter. */
      maxAgeMinutes: z.number().int().positive().max(10_080).default(90),
      /** En dessous, l'opportunité n'entre pas dans la file. */
      minEvScore: z.number().min(0).max(1).default(0.35),
    })
    .default({ maxReplyCount: 150, maxAgeMinutes: 90, minEvScore: 0.35 }),

  /** Fragments injectés dans les prompts. Le seul endroit où un pack « parle » au LLM. */
  promptFragments: z
    .object({
      /** Ce que la niche valorise dans une bonne réponse. */
      whatGoodLooksLike: z.string().max(1_500).default(''),
      /** Ce qui trahit un intrus dans cette communauté. */
      whatOutsidersGetWrong: z.string().max(1_500).default(''),
      /** Contraintes propres à la niche, reformulées pour le CRITIC. */
      criticExtraRules: z.string().max(1_500).default(''),
    })
    .default({ whatGoodLooksLike: '', whatOutsidersGetWrong: '', criticExtraRules: '' }),
})

export type NichePack = z.infer<typeof NichePackSchema>

/** Enveloppe d'export/import — permet de faire évoluer le format sans casser les packs. */
export const NichePackFileSchema = z.object({
  formatVersion: z.literal(1),
  pack: NichePackSchema,
})
export type NichePackFile = z.infer<typeof NichePackFileSchema>
