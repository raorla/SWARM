/**
 * Agent QUICK-REPLY — le chemin rapide de la Phase 1.
 *
 * C'est **délibérément** la génération one-shot que fait la concurrence : un post entre,
 * une réponse sort. Elle existe pour deux raisons : elle atteint le DoD de la Phase 1
 * (« je peux répondre à un post avec l'IA sans quitter X »), et elle fournit la référence
 * contre laquelle mesurer ce que les Phases 2 à 5 ajoutent réellement. Sans point de
 * comparaison, « le swarm fait mieux » serait une affirmation invérifiable.
 *
 * Ce qui lui manque, et qui arrive plus tard : le Voice Profile construit (Phase 2), les
 * trois variantes et le veto du CRITIC (Phase 2), l'anti-répétition sémantique (Phase 6).
 */
import {
  QuickReplyOutputSchema,
  X_REPLY_LIMIT,
  type QuickReplyResult,
} from '../schemas/quick-reply.io'
import { loadPrompt } from '../prompts'
import type { LlmClient } from '@/llm/client'
import type { LlmMessage } from '@/llm/types'
import type { NichePack } from '@/niches/pack.schema'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import { err, ok, type Result } from '@/shared/result'
import { LlmError } from '@/llm/errors'

export interface QuickReplyInput {
  post: ExtractedPost
  pack: NichePack
  /** Exemples d'écriture de l'utilisateur, si déjà collectés. Vide en Phase 1. */
  voiceExamples?: readonly string[]
  /** Consigne libre de l'utilisateur (« sois plus sec », « demande une source »). */
  userHint?: string
}

/**
 * Construit les messages, avec le préfixe stable marqué `cacheable`.
 *
 * Le découpage n'est pas cosmétique : le prompt système et le brief de niche sont
 * identiques d'un appel à l'autre, le post ne l'est pas. Marquer la frontière au bon
 * endroit est ce qui fait passer le coût d'entrée de plein tarif à un dixième (SPEC §3.2,
 * règle 1) — soit la différence entre tenir 1 €/jour et le tripler.
 */
export async function buildQuickReplyMessages(
  input: QuickReplyInput,
): Promise<{ messages: LlmMessage[]; promptHash: string }> {
  const prompt = await loadPrompt('quick-reply')

  const nicheBrief = [
    `## Niche : ${input.pack.label}`,
    input.pack.domainBrief,
    '',
    '### Ce qui fait une bonne réponse ici',
    input.pack.promptFragments.whatGoodLooksLike || '(non renseigné)',
    '',
    '### Ce qui trahit un intrus dans cette communauté',
    input.pack.promptFragments.whatOutsidersGetWrong || '(non renseigné)',
    '',
    `### Angles autorisés\n${input.pack.allowedAngles.join(', ')}`,
    input.pack.lexicon.banned.length > 0
      ? `\n### Termes interdits\n${input.pack.lexicon.banned.join(', ')}`
      : '',
    input.pack.lexicon.preferred.length > 0
      ? `\n### Termes du registre\n${input.pack.lexicon.preferred.join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  const voiceBlock =
    input.voiceExamples && input.voiceExamples.length > 0
      ? `\n## Exemples d'écriture de l'utilisateur\n\n${input.voiceExamples
          .slice(0, 12)
          .map((e) => `- ${e}`)
          .join('\n')}`
      : "\n## Profil de voix\n\nPas encore construit (arrive en Phase 2). En attendant : registre neutre, phrases courtes, aucun emoji, aucune formule d'assistant."

  const ageMinutes = Math.max(
    0,
    Math.round((input.post.observedAtMs - input.post.postedAtMs) / 60_000),
  )

  const postBlock = [
    '## Post auquel répondre',
    '',
    `Auteur : @${input.post.authorHandle}`,
    `Âge : ${ageMinutes} min`,
    `Réponses existantes : ${input.post.replyCount ?? 'inconnu'}`,
    `Likes : ${input.post.likeCount ?? 'inconnu'}`,
    input.post.hasMedia ? 'Contient un média (que tu ne vois pas).' : '',
    input.post.isReply ? 'Ce post est lui-même une réponse dans un fil.' : '',
    '',
    '### Texte',
    input.post.text || '(aucun texte — le post est probablement une image seule)',
    input.userHint ? `\n### Consigne de l'utilisateur\n${input.userHint}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    promptHash: prompt.hash,
    messages: [
      // ── Préfixe stable : mis en cache d'un appel à l'autre.
      { role: 'system', content: prompt.content, cacheable: true },
      { role: 'system', content: `${nicheBrief}${voiceBlock}`, cacheable: true },
      // ── Partie variable : jamais mise en cache.
      { role: 'user', content: postBlock },
    ],
  }
}

export type QuickReplyError =
  { kind: 'llm'; error: LlmError } | { kind: 'declined'; reason: string }

export async function runQuickReply(
  client: LlmClient,
  input: QuickReplyInput,
): Promise<Result<QuickReplyResult, QuickReplyError>> {
  const { messages, promptHash } = await buildQuickReplyMessages(input)

  const response = await client.call({
    role: 'writer',
    messages,
    schema: QuickReplyOutputSchema,
    label: `quick-reply:${input.post.postId}`,
  })

  if (!response.ok) return err({ kind: 'llm', error: response.error })

  const data = response.value.data
  if (!data) {
    return err({
      kind: 'llm',
      error: new LlmError('invalid-json', 'réponse validée mais vide'),
    })
  }

  // Un refus n'est pas une erreur technique, mais il ne doit pas remonter comme un
  // succès : l'overlay affiche un message différent, et le motif est le contenu utile.
  if (data.decision === 'decline' || data.text.trim() === '') {
    return err({ kind: 'declined', reason: data.reasoning || 'aucun apport identifié' })
  }

  const text = data.text.trim()
  return ok({
    decision: 'reply',
    text,
    angle: data.angle,
    reasoning: data.reasoning,
    confidence: data.confidence,
    // On signale le dépassement, on ne tronque pas : couper une réponse au caractère 280
    // produit une phrase amputée, et c'est à l'utilisateur d'arbitrer.
    overLimit: text.length > X_REPLY_LIMIT,
    costEur: response.value.costEur,
    model: response.value.model,
    latencyMs: response.value.latencyMs,
    promptVersionHash: promptHash,
    repaired: response.value.repaired,
  })
}
