/**
 * Schéma de persistance — SPEC §5.
 *
 * Les types portent les invariants de la boucle d'apprentissage :
 *  - `actions.promptVersionHash` (MH-04) : sans lui, corréler une performance mesurée à
 *    J+7 avec un prompt qui a changé entre-temps produit des conclusions confiantes et
 *    fausses. C'est le champ dont l'absence rendrait le différenciateur n°2 mensonger.
 *  - `actions.idempotencyKey` (MH-07) : unique, empêche le double staging après la mort
 *    du service worker.
 *  - `actions.outcome` distingue `published` de `abandoned` (MH-09) : en Copilote, c'est
 *    l'humain qui publie, et mesurer une action jamais publiée pollue l'apprentissage.
 */
import type { ActionType } from '@/governor/types'
import type { Angle } from '@/niches/pack.schema'
import type { AuditEntry } from '@/governor/audit'
import type { AgentRole } from '@/llm/types'

export type OpportunityStatus =
  | 'scouted'
  | 'qualified'
  | 'rejected-qualifier'
  | 'drafted'
  | 'rejected-critic'
  | 'queued'
  | 'staged'
  | 'published'
  | 'abandoned'
  | 'expired'

export interface ScoreBreakdown {
  reach: number
  nicheRelevance: number
  freshness: number
  saturation: number
  authorAffinity: number
  /** Produit pondéré final, dans [0, 1]. */
  ev: number
}

export interface Opportunity {
  id?: number
  postId: string
  authorHandle: string
  authorFollowers: number | null
  text: string
  lang: string | null
  metrics: { replies: number; likes: number; reposts: number }
  postedAtMs: number
  observedAtMs: number
  surface: string
  evScore: number
  scoreBreakdown: ScoreBreakdown | null
  status: OpportunityStatus
  rejectionReason: string | null
  /** Pack actif au moment de la qualification — un score n'est comparable qu'à pack égal. */
  nichePackId: string
  nichePackVersion: string
  createdAtMs: number
}

export interface DraftVariant {
  text: string
  angle: Angle
  /** Notes du CRITIC, dans [0, 1]. */
  criticScores?: {
    voiceAuthenticity: number
    valueAdded: number
    reputationRisk: number
    redundancy: number
    attentionCost: number
    overall: number
  }
  criticNotes?: string
}

export interface Draft {
  id?: number
  opportunityId: number
  variants: DraftVariant[]
  selectedIndex: number | null
  /** Verdict global du CRITIC. `false` = veto, l'opportunité est rejetée. */
  criticPassed: boolean | null
  criticRejectionReason: string | null
  /** Hash des prompts utilisés, par agent (MH-04). */
  promptVersions: Partial<Record<AgentRole, string>>
  createdAtMs: number
}

export interface AgentTrailStep {
  role: AgentRole
  model: string
  provider: string
  costEur: number
  tokens: { input: number; output: number }
  latencyMs: number
  repaired: boolean
  promptVersionHash: string
}

export interface Action {
  id?: number
  /** Unique — index contraint. Empêche le double staging (MH-07). */
  idempotencyKey: string
  type: ActionType
  opportunityId: number | null
  draftId: number | null
  content: string
  stagedAtMs: number
  /** Renseigné seulement si la publication a été *constatée* (MH-09). */
  publishedAtMs: number | null
  /** État de confirmation : l'humain a-t-il cliqué Publier ? */
  outcome: 'pending' | 'published' | 'abandoned'
  xPostId: string | null
  agentTrail: AgentTrailStep[]
  /** Coût cumulé de la chaîne d'agents, en euros. */
  totalCostEur: number
  /** Hash combiné des prompts de la chaîne (MH-04). */
  promptVersionHash: string
  nichePackId: string
}

export interface Outcome {
  id?: number
  actionId: number
  /** 1 ou 7 — la mesure est faite deux fois, pas en continu. */
  dayOffset: number
  checkedAtMs: number
  impressions: number | null
  likes: number
  replies: number
  reposts: number
  profileClicks: number | null
  /** Corrélationnel, pas causal — voir docs/risks-and-limits.md §4. */
  attributedFollows: number
}

export interface Relationship {
  handle: string
  firstSeenMs: number
  lastInteractionMs: number | null
  interactionCount: number
  theirTopics: string[]
  ourTopics: string[]
  /** Familiarité 0–5. Progresse lentement : l'intimité se gagne, elle ne se déclare pas. */
  warmth: number
  notes: string
  /** Ce compte a-t-il déjà ignoré nos réponses ? Signal utile au scoring d'affinité. */
  ignoredCount: number
}

/**
 * Post de l'utilisateur, collecté pour construire le Voice Profile.
 *
 * Table distincte de `opportunities` : ce ne sont pas des opportunités — on n'y répond pas,
 * on les imite. Les mélanger obligerait chaque requête de triage à filtrer sur `isOwnPost`,
 * et une seule requête oubliée ferait proposer à l'utilisateur de répondre à lui-même.
 */
export interface OwnPost {
  id?: number
  postId: string
  text: string
  lang: string | null
  postedAtMs: number
  collectedAtMs: number
  likeCount: number | null
  replyCount: number | null
  repostCount: number | null
  hasMedia: boolean
  isReply: boolean
  /** Vrai si le post passe le topic-guard — voir FEEDBACK MH-18. */
  passesGuard: boolean
  /** Catégories déclenchées si `passesGuard` est faux, pour le diagnostic. */
  guardCategories: string[]
}

/**
 * Statistiques de **forme**.
 *
 * Calculées sur le corpus entier, y compris les posts que le garde-fou écarte : la forme
 * d'un post promotionnel (longueur, rythme, retours à la ligne) reste la forme de
 * l'utilisateur. C'est son *registre* qui est filtré, pas sa manière d'écrire (MH-18).
 */
export interface VoiceFormStats {
  sampleSize: number
  avgLength: number
  medianLength: number
  p10Length: number
  p90Length: number
  avgSentencesPerPost: number
  avgWordLength: number
  /** Ratio type/occurrence : indice grossier de richesse lexicale. */
  lexicalDiversity: number
  emojiRate: number
  /** Emojis effectivement employés, les plus fréquents d'abord. */
  emojiInventory: string[]
  questionRate: number
  exclamationRate: number
  ellipsisRate: number
  emDashRate: number
  semicolonRate: number
  capitalizedStartRate: number
  lowercaseStartRate: number
  allCapsWordRate: number
  linkRate: number
  hashtagRate: number
  mentionRate: number
  lineBreakRate: number
  avgLinesPerPost: number
  replyRatio: number
  /** Part de chaque langue détectée, sommant à 1. */
  languageMix: Record<string, number>
}

export interface VoiceProfileRecord {
  id: 'current'
  builtAtMs: number
  handle: string
  /** Taille du corpus total, garde-fou compris. */
  sampleSize: number
  /** Nombre de posts écartés par le topic-guard (MH-18). */
  guardExcludedCount: number
  /**
   * Part du corpus non reproductible sous les garde-fous.
   * Élevée = la voix native du compte est largement interdite, et le produit doit le dire
   * plutôt que de produire une imitation dégradée en silence.
   */
  guardExcludedRatio: number
  stats: VoiceFormStats
  /** Ouvertures de phrase récurrentes — le signal le plus discriminant. */
  signatureOpeners: string[]
  /** N-grammes récurrents : les tics de langage. */
  signaturePhrases: string[]
  recurringTopics: string[]
  /**
   * Exemples canoniques. Tirés **uniquement** de posts qui passent le garde-fou (MH-18) :
   * ce sont eux qui vont dans le prompt du WRITER.
   */
  canonicalExamples: string[]
  doRules: string[]
  dontRules: string[]
  /**
   * Confiance dans [0, 1], fonction de la taille du corpus exploitable.
   * Sous ~50 posts utilisables, l'imitation est faible : le profil doit le dire et le
   * CRITIC doit durcir, plutôt que le produit prétendre savoir écrire comme l'utilisateur.
   */
  confidence: number
}

export interface Pattern {
  id?: number
  /** Dimension analysée : 'angle', 'length', 'hour', 'authorTier', 'format'. */
  dimension: string
  value: string
  sampleSize: number
  avgEngagement: number
  avgAttributedFollows: number
  /** Intervalle de confiance grossier — un pattern à n=3 ne doit pas piloter les prompts. */
  confidence: number
  updatedAtMs: number
}

export interface Embedding {
  id?: number
  refType: 'opportunity' | 'action' | 'ourPost' | 'topic'
  refId: string
  /** Vecteur normalisé, calculé localement (ADR 0002). */
  vector: number[]
  createdAtMs: number
}

export interface ConfigRecord {
  id: 'current'
  activeNichePackId: string
  mode: 'simulation' | 'copilot' | 'autopilot'
  installSeed: string
  caps: Record<string, number>
  cadence: { minMinutes: number; maxMinutes: number }
  window: {
    startMinute: number
    endMinute: number
    activeDays: number[]
    dayOffProbability: number
  }
  budget: { dailyEur: number; reserveFraction: number }
  locale: 'fr' | 'en'
  /** Consentement horodaté (MH-12). Sans lui, l'onboarding n'est pas terminé. */
  consentAcceptedAtMs: number | null
  /** Rétention du texte brut, en jours (MH-13). */
  retentionDays: number
  /** Handle de l'utilisateur, source du Voice Profile. */
  ownHandle: string | null
  /**
   * Chemin de rédaction.
   *
   * `chain` = WRITER → CRITIC (Phase 2). `quick-reply` = one-shot (Phase 1), conservé comme
   * **référence de comparaison** : sans lui, « le swarm fait mieux que la génération
   * one-shot » serait invérifiable, et c'est la thèse du produit.
   */
  draftMode: 'chain' | 'quick-reply'
  /** Seuil de veto du CRITIC. Calibré par mesure, pas deviné. */
  criticVetoThreshold: number
}

export interface PromptVersion {
  hash: string
  role: AgentRole
  content: string
  createdAtMs: number
}

export interface NichePackRecord {
  id: string
  version: string
  /** JSON du pack, validé par `NichePackSchema` à la lecture. */
  json: string
  installedAtMs: number
  isBundled: boolean
}

export type AuditRecord = AuditEntry & { id?: number }
