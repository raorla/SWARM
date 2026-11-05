/**
 * Contrat de messagerie inter-contextes — SPEC §8.
 *
 * Les quatre contextes MV3 (service worker, content script, side panel, offscreen) ne
 * partagent aucune mémoire : tout passe par `chrome.runtime.sendMessage`, qui accepte
 * n'importe quoi et ne garantit rien. C'est une frontière, donc elle est validée par
 * Zod aux deux bouts.
 *
 * Ce fichier est la source de vérité du protocole. Un message dont le type n'y figure
 * pas est rejeté, pas ignoré : un message silencieusement perdu est un bug qu'on
 * cherche pendant une heure.
 */
import { z } from 'zod'
import { HandleSchema, XPostIdSchema } from '@/shared/zod-helpers'

/** Sujets. Nommés par domaine pour garder le routage lisible. */
export const MSG = {
  // Diagnostic
  PING: 'ping',
  // Scout → orchestrateur
  POSTS_OBSERVED: 'scout/postsObserved',
  SELECTOR_BROKEN: 'scout/selectorBroken',
  // Overlay → orchestrateur (cas d'usage rapide, court-circuite le triage)
  MANUAL_REPLY_REQUEST: 'overlay/manualReplyRequest',
  // Content script → orchestrateur : diagnostic de santé du parsing
  SELECTOR_HEALTH: 'scout/selectorHealth',
  // Collecte du corpus de l'utilisateur (Phase 2)
  OWN_POSTS_COLLECTED: 'voice/ownPostsCollected',
  OWN_HANDLE_DETECTED: 'voice/ownHandleDetected',
  // File d'opportunités (Phase 3)
  QUEUE_LIST: 'flux/queueList',
  QUEUE_STATS: 'flux/queueStats',
  OPPORTUNITY_DRAFT: 'flux/opportunityDraft',
  OPPORTUNITY_REJECT: 'flux/opportunityReject',
  // Side panel → orchestrateur
  VOICE_PROFILE_STATUS: 'voice/profileStatus',
  VOICE_PROFILE_REBUILD: 'voice/profileRebuild',
  START_COLLECTION: 'voice/startCollection',
  COLLECTION_PROGRESS: 'voice/collectionProgress',
  // Orchestrateur → content script
  STAGE_DRAFT: 'actuator/stageDraft',
  // Side panel → orchestrateur
  KILL_SWITCH: 'control/killSwitch',
  RESUME: 'control/resume',
  LLM_SELFTEST: 'control/llmSelfTest',
  // Orchestrateur → side panel (diffusion d'état)
  SWARM_STATE: 'state/swarm',
  ANALYTICS_STATE: 'state/analytics',
  AUDIT_LIST: 'state/auditList',

  // Réglages et coffre. Les charges utiles portent des secrets : elles ne sont ni
  // journalisées ni renvoyées, et le logger redacte `passphrase`/`apiKey` par défaut.
  /** Consentement d'onboarding (MH-12). Sans lui, triage et rédaction restent bloqués. */
  CONSENT_ACCEPT: 'onboarding/consentAccept',
  SETTINGS_STATUS: 'settings/status',
  SETTINGS_UPDATE: 'settings/update',
  KEYSTORE_UNLOCK: 'keystore/unlock',
  KEYSTORE_LOCK: 'keystore/lock',
  KEYSTORE_SET_KEY: 'keystore/setKey',
  KEYSTORE_REMOVE_KEY: 'keystore/removeKey',
} as const

export type MsgType = (typeof MSG)[keyof typeof MSG]

/* ────────────────────────────── Charges utiles ───────────────────────────── */

export const PostSnapshotSchema = z.object({
  postId: XPostIdSchema,
  authorHandle: HandleSchema,
  authorFollowers: z.number().int().nonnegative().nullable(),
  text: z.string().max(10_000),
  lang: z.string().min(2).max(8).nullable(),
  createdAtMs: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative(),
  repostCount: z.number().int().nonnegative(),
  hasMedia: z.boolean(),
  isReply: z.boolean(),
  /** Source d'observation : sert au scoring et au diagnostic de couverture. */
  surface: z.enum(['timeline', 'search', 'watchlist', 'notifications', 'bookmarks']),
  observedAtMs: z.number().int().nonnegative(),
})
export type PostSnapshot = z.infer<typeof PostSnapshotSchema>

/**
 * Post extrait par l'overlay, envoyé au service worker pour rédaction.
 *
 * Distinct de `PostSnapshotSchema` : le scout collecte des instantanés destinés au triage,
 * l'overlay envoie un post unique déjà qualifié par le clic de l'utilisateur. Les fusionner
 * obligerait l'un des deux à porter des champs qui ne le concernent pas.
 */
export const ExtractedPostForReplySchema = z.object({
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
  isOwnPost: z.boolean(),
  surface: z.enum(['timeline', 'search', 'watchlist', 'notifications', 'bookmarks']),
  observedAtMs: z.number().int().positive(),
  permalink: z.string().min(1),
})
export type ExtractedPostForReply = z.infer<typeof ExtractedPostForReplySchema>

/** Une variante proposée, avec sa notation. */
export const DraftVariantWireSchema = z.object({
  text: z.string().min(1).max(600),
  angle: z.string(),
  intent: z.string(),
  /** Distance de forme mesurée mécaniquement, 0 = conforme au profil. */
  voiceDistance: z.number().min(0).max(1),
  overLimit: z.boolean(),
  criticScores: z
    .object({
      voiceAuthenticity: z.number(),
      valueAdded: z.number(),
      reputationRisk: z.number(),
      redundancy: z.number(),
      attentionCost: z.number(),
      overall: z.number(),
      note: z.string(),
    })
    .nullable(),
})
export type DraftVariantWire = z.infer<typeof DraftVariantWireSchema>

/**
 * Réponse du service worker à une demande de rédaction.
 *
 * Trois issues, et `decline` en est une **normale** : un veto du CRITIC n'est pas une panne
 * mais le résultat attendu dans une bonne partie des cas (SPEC §4.5). L'overlay l'affiche
 * comme un résultat, pas comme une erreur.
 */
export const ReplyGenerationSchema = z.union([
  z.object({
    ok: z.literal(true),
    decision: z.literal('reply'),
    variants: z.array(DraftVariantWireSchema).min(1).max(3),
    /** Index de la variante retenue par le CRITIC. */
    selectedIndex: z.number().int().nonnegative(),
    sharedContext: z.string(),
    costEur: z.number().nonnegative(),
    latencyMs: z.number().nonnegative(),
    promptVersionHash: z.string(),
    /** Chemin utilisé, pour que l'UI puisse comparer chaîne et référence. */
    mode: z.enum(['chain', 'quick-reply']),
    /** Confiance du Voice Profile employé, ou `null` s'il n'y en a pas. */
    voiceConfidence: z.number().min(0).max(1).nullable(),
  }),
  z.object({
    ok: z.literal(true),
    decision: z.literal('decline'),
    reasoning: z.string(),
    /** Coût réel du refus : un veto a consommé des appels (MH-05). */
    costEur: z.number().nonnegative().default(0),
    mode: z.enum(['chain', 'quick-reply']).default('chain'),
  }),
  z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() }),
])
export type ReplyGenerationResponse = z.infer<typeof ReplyGenerationSchema>

/**
 * Post de l'utilisateur, envoyé au service worker pour rejoindre le corpus.
 *
 * Distinct de `ExtractedPostForReply` : celui-ci n'a pas de surface d'observation ni de
 * métrique de saturation — on ne lui répond pas, on l'imite. Les fusionner obligerait l'un
 * des deux à porter des champs qui ne le concernent pas.
 */
export const OwnPostWireSchema = z.object({
  postId: XPostIdSchema,
  text: z.string().max(10_000),
  lang: z.string().min(2).max(8).nullable(),
  postedAtMs: z.number().int().positive(),
  likeCount: z.number().int().nonnegative().nullable(),
  replyCount: z.number().int().nonnegative().nullable(),
  repostCount: z.number().int().nonnegative().nullable(),
  hasMedia: z.boolean(),
  isReply: z.boolean(),
})
export type OwnPostWire = z.infer<typeof OwnPostWireSchema>

export const CollectionProgressSchema = z.object({
  collected: z.number().int().nonnegative(),
  scrolls: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  /** Renseigné seulement à la fin. */
  stopReason: z.string().nullable(),
})

export const StageDraftSchema = z.object({
  /** Identifie le brouillon de bout en bout, y compris après mort du service worker. */
  idempotencyKey: z.string().min(8).max(128),
  postId: XPostIdSchema,
  text: z.string().min(1).max(4_000),
  /** Jeton opaque émis par le governor. Le content script refuse d'agir sans lui. */
  permitToken: z.string().min(8),
})
export type StageDraft = z.infer<typeof StageDraftSchema>

export const SelectorBrokenSchema = z.object({
  selectorName: z.string().min(1),
  surface: z.string().min(1),
  consecutiveMisses: z.number().int().nonnegative(),
  /** Fragment DOM anonymisé (MH-14) : handles et textes déjà remplacés côté content. */
  anonymizedSnippet: z.string().max(20_000).optional(),
})
export type SelectorBroken = z.infer<typeof SelectorBrokenSchema>

export const ProviderIdSchema = z.enum([
  'openrouter',
  'anthropic',
  'openai',
  'gemini',
  'xai',
  'openai-compatible',
])

/**
 * Correctif de réglages.
 *
 * `mode` n'accepte pas `'autopilot'` : ce passage a son propre écran de consentement, et
 * l'autoriser ici en ferait un champ ordinaire — c'est-à-dire un contournement.
 */
export const ConfigPatchSchema = z.object({
  mode: z.enum(['simulation', 'copilot']).optional(),
  dailyBudgetEur: z.number().min(0).max(50).optional(),
  capReply: z.number().int().min(0).max(200).optional(),
  capPost: z.number().int().min(0).max(50).optional(),
  cadenceMinMinutes: z.number().int().min(1).max(240).optional(),
  cadenceMaxMinutes: z.number().int().min(1).max(480).optional(),
  windowStartMinute: z.number().int().min(0).max(1_439).optional(),
  windowEndMinute: z.number().int().min(1).max(1_440).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  criticVetoThreshold: z.number().min(0).max(1).optional(),
  draftMode: z.enum(['chain', 'quick-reply']).optional(),
  activeNichePackId: z.string().min(2).max(48).optional(),
})

export const SwarmStateSchema = z.object({
  mode: z.enum(['simulation', 'copilot', 'autopilot']),
  pipelineState: z.string(),
  governanceState: z.enum(['nominal', 'paused', 'degraded', 'halted']),
  activeAgent: z.string().nullable(),
  spentTodayEur: z.number().nonnegative(),
  budgetEur: z.number().nonnegative(),
  queueLength: z.number().int().nonnegative(),
  caps: z.record(z.string(), z.object({ used: z.number().int(), cap: z.number().int() })),
})
export type SwarmState = z.infer<typeof SwarmStateSchema>

/* ─────────────────────────── Union discriminée ────────────────────────────── */

export const MessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(MSG.PING), payload: z.object({ at: z.number() }) }),
  z.object({
    type: z.literal(MSG.POSTS_OBSERVED),
    payload: z.object({ posts: z.array(PostSnapshotSchema).max(200) }),
  }),
  z.object({ type: z.literal(MSG.SELECTOR_BROKEN), payload: SelectorBrokenSchema }),
  z.object({
    type: z.literal(MSG.MANUAL_REPLY_REQUEST),
    payload: z.object({
      post: ExtractedPostForReplySchema,
      /** Consigne libre de l'utilisateur (« sois plus sec », « demande une source »). */
      hint: z.string().max(500).optional(),
    }),
  }),
  z.object({
    type: z.literal(MSG.OWN_POSTS_COLLECTED),
    payload: z.object({
      posts: z.array(OwnPostWireSchema).max(250),
      stopReason: z.string(),
      scrolls: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal(MSG.OWN_HANDLE_DETECTED),
    payload: z.object({
      handle: HandleSchema,
      source: z.enum(['profile-link', 'account-button']),
    }),
  }),
  z.object({
    type: z.literal(MSG.QUEUE_LIST),
    payload: z.object({ limit: z.number().int().positive().max(100).optional() }),
  }),
  z.object({ type: z.literal(MSG.QUEUE_STATS), payload: z.object({}) }),
  z.object({
    type: z.literal(MSG.OPPORTUNITY_DRAFT),
    payload: z.object({
      opportunityId: z.number().int().positive(),
      hint: z.string().max(500).optional(),
    }),
  }),
  z.object({
    type: z.literal(MSG.OPPORTUNITY_REJECT),
    payload: z.object({
      opportunityId: z.number().int().positive(),
      reason: z.string().max(280).optional(),
    }),
  }),
  z.object({ type: z.literal(MSG.VOICE_PROFILE_STATUS), payload: z.object({}) }),
  z.object({ type: z.literal(MSG.VOICE_PROFILE_REBUILD), payload: z.object({}) }),
  z.object({
    type: z.literal(MSG.START_COLLECTION),
    payload: z.object({ maxPosts: z.number().int().positive().max(400).optional() }),
  }),
  z.object({
    type: z.literal(MSG.COLLECTION_PROGRESS),
    payload: CollectionProgressSchema,
  }),
  z.object({
    type: z.literal(MSG.SELECTOR_HEALTH),
    payload: z.object({
      hitRate: z.number().min(0).max(1),
      broken: z.array(z.string()).max(50),
      surface: z.string(),
    }),
  }),
  z.object({ type: z.literal(MSG.STAGE_DRAFT), payload: StageDraftSchema }),
  z.object({
    type: z.literal(MSG.KILL_SWITCH),
    payload: z.object({ reason: z.string().max(280).optional() }),
  }),
  z.object({ type: z.literal(MSG.RESUME), payload: z.object({}) }),
  z.object({
    type: z.literal(MSG.LLM_SELFTEST),
    payload: z.object({ prompt: z.string().min(1).max(2_000) }),
  }),
  z.object({ type: z.literal(MSG.SWARM_STATE), payload: SwarmStateSchema }),
  z.object({ type: z.literal(MSG.ANALYTICS_STATE), payload: z.object({}) }),
  z.object({
    type: z.literal(MSG.AUDIT_LIST),
    payload: z.object({ limit: z.number().int().positive().max(500).optional() }),
  }),
  z.object({ type: z.literal(MSG.CONSENT_ACCEPT), payload: z.object({}) }),
  z.object({ type: z.literal(MSG.SETTINGS_STATUS), payload: z.object({}) }),
  z.object({ type: z.literal(MSG.SETTINGS_UPDATE), payload: ConfigPatchSchema }),
  z.object({
    type: z.literal(MSG.KEYSTORE_UNLOCK),
    payload: z.object({ passphrase: z.string().min(1).max(512) }),
  }),
  z.object({ type: z.literal(MSG.KEYSTORE_LOCK), payload: z.object({}) }),
  z.object({
    type: z.literal(MSG.KEYSTORE_SET_KEY),
    payload: z.object({
      providerId: ProviderIdSchema,
      // Une clé vide est valide pour un endpoint local, qui n'en demande pas.
      apiKey: z.string().max(400),
      baseUrl: z.string().url().max(300).optional(),
      passphrase: z.string().min(8).max(512),
    }),
  }),
  z.object({
    type: z.literal(MSG.KEYSTORE_REMOVE_KEY),
    payload: z.object({
      providerId: ProviderIdSchema,
      passphrase: z.string().min(1).max(512),
    }),
  }),
])

export type Message = z.infer<typeof MessageSchema>

/** Réponse uniforme. Aucun handler ne renvoie une valeur nue : l'échec est une valeur. */
export const ResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() }),
])
export type MessageResponse = z.infer<typeof ResponseSchema>

/** Extrait la charge utile associée à un type — évite les casts dans les handlers. */
export type PayloadOf<T extends MsgType> = Extract<Message, { type: T }>['payload']
