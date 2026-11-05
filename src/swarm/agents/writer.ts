/**
 * Agent WRITER — trois variantes dans la voix de l'utilisateur.
 *
 * Ce qui décide de la qualité ici n'est pas le prompt mais **le découpage du contexte** : le
 * Voice Profile et le brief de niche sont identiques d'un appel à l'autre, le post ne l'est
 * pas. Marquer la frontière au bon endroit fait passer le coût d'entrée de plein tarif à un
 * dixième (SPEC §3.2, règle 1) — la différence entre tenir 1 €/jour et le tripler.
 */
import { WriterOutputSchema, type WriterVariant } from '../schemas/writer.io'
import { defineAgent, type Agent } from '../agent'
import { err, ok } from '@/shared/result'
import type { LlmMessage } from '@/llm/types'
import type { NichePack } from '@/niches/pack.schema'
import type { VoiceProfileRecord } from '@/db/schema'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import { isProfileUsable } from '@/memory/voice-profile'

export interface WriterInput {
  post: ExtractedPost
  pack: NichePack
  profile: VoiceProfileRecord | null
  /** Consigne libre de l'utilisateur. */
  userHint?: string
}

export interface WriterResult {
  variants: WriterVariant[]
  sharedContext: string
}

/**
 * Bloc de voix, destiné au préfixe cachable.
 *
 * Quand le profil est absent ou faible, on le **dit** au modèle au lieu de le taire. Un
 * modèle sans profil de voix qui ne le sait pas en invente un — et une voix inventée est
 * pire qu'une absence de voix, parce qu'elle est confiante.
 */
export function buildVoiceBlock(profile: VoiceProfileRecord | null): string {
  if (!profile || profile.sampleSize === 0) {
    return [
      '## Profil de voix',
      '',
      "Aucun profil disponible. N'invente pas de style : écris en registre neutre, phrases",
      "courtes, aucun emoji, aucune formule d'assistant. Le CRITIC en tiendra compte.",
    ].join('\n')
  }

  const s = profile.stats
  const lines = [
    '## Profil de voix',
    '',
    `Confiance : ${(profile.confidence * 100).toFixed(0)} % sur ${profile.sampleSize} posts collectés.`,
  ]

  if (!isProfileUsable(profile)) {
    lines.push(
      '',
      '**Profil insuffisant.** Trop peu de matière exploitable pour imiter un style avec',
      "assurance. Écris sobrement plutôt que d'extrapoler. Ne compense pas en inventant.",
    )
  }

  if (profile.guardExcludedRatio > 0.3) {
    lines.push(
      '',
      `Note : ${(profile.guardExcludedRatio * 100).toFixed(0)} % du corpus a été écarté par les`,
      'garde-fous du produit. Ce que tu vois est la partie reproductible de cette voix ;',
      "n'essaie pas de deviner le reste.",
    )
  }

  lines.push(
    '',
    '### Forme',
    `- longueur : ${Math.round(s.p10Length)}–${Math.round(s.p90Length)} caractères (médiane ${Math.round(s.medianLength)})`,
    `- ${s.avgSentencesPerPost.toFixed(1)} phrases par post en moyenne`,
    `- emojis : ${(s.emojiRate * 100).toFixed(0)} % des posts${s.emojiInventory.length > 0 ? ` (${s.emojiInventory.slice(0, 6).join(' ')})` : ''}`,
    `- questions : ${(s.questionRate * 100).toFixed(0)} % · exclamations : ${(s.exclamationRate * 100).toFixed(0)} %`,
    `- retours à la ligne : ${(s.lineBreakRate * 100).toFixed(0)} % des posts, ${s.avgLinesPerPost.toFixed(1)} lignes`,
    `- majuscule initiale : ${(s.capitalizedStartRate * 100).toFixed(0)} %`,
  )

  if (profile.doRules.length > 0) {
    lines.push('', '### À faire', ...profile.doRules.map((r) => `- ${r}`))
  }
  if (profile.dontRules.length > 0) {
    lines.push('', '### À ne pas faire', ...profile.dontRules.map((r) => `- ${r}`))
  }
  if (profile.signatureOpeners.length > 0) {
    lines.push('', `### Ouvertures récurrentes\n${profile.signatureOpeners.join(' · ')}`)
  }
  if (profile.signaturePhrases.length > 0) {
    lines.push('', `### Tics de langage\n${profile.signaturePhrases.join(' · ')}`)
  }
  if (profile.canonicalExamples.length > 0) {
    lines.push(
      '',
      '### Exemples réels de son écriture',
      ...profile.canonicalExamples.map((e) => `\n---\n${e}`),
    )
  }

  return lines.join('\n')
}

/** Brief de niche, également cachable : il ne change qu'au changement de pack. */
export function buildNicheBlock(pack: NichePack): string {
  return [
    `## Niche : ${pack.label}`,
    '',
    pack.domainBrief,
    '',
    '### Ce qui fait une bonne réponse ici',
    pack.promptFragments.whatGoodLooksLike || '(non renseigné)',
    '',
    '### Ce qui trahit un intrus dans cette communauté',
    pack.promptFragments.whatOutsidersGetWrong || '(non renseigné)',
    '',
    `### Angles autorisés\n${pack.allowedAngles.join(', ')}`,
    pack.lexicon.banned.length > 0
      ? `\n### Termes interdits\n${pack.lexicon.banned.join(', ')}`
      : '',
    pack.lexicon.preferred.length > 0
      ? `\n### Termes du registre\n${pack.lexicon.preferred.join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Bloc variable : le post et la consigne. Jamais mis en cache. */
export function buildPostBlock(input: WriterInput): string {
  const ageMinutes = Math.max(
    0,
    Math.round((input.post.observedAtMs - input.post.postedAtMs) / 60_000),
  )
  return [
    '## Post auquel répondre',
    '',
    `Auteur : @${input.post.authorHandle}`,
    `Âge : ${ageMinutes} min`,
    `Réponses existantes : ${input.post.replyCount ?? 'inconnu'}`,
    `Likes : ${input.post.likeCount ?? 'inconnu'}`,
    input.post.hasMedia ? 'Contient un média que tu ne vois pas.' : '',
    input.post.isReply ? 'Ce post est lui-même une réponse dans un fil.' : '',
    '',
    '### Texte',
    input.post.text || '(aucun texte — probablement une image seule)',
    input.userHint ? `\n### Consigne de l'utilisateur\n${input.userHint}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export const writerAgent: Agent<WriterInput, WriterResult> = defineAgent({
  role: 'writer',
  promptId: 'writer',
  schema: WriterOutputSchema,

  buildMessages: (input, promptContent): LlmMessage[] => [
    // ── Préfixe stable, mis en cache. Ordre du plus stable au moins stable : le prompt ne
    //    change qu'au déploiement, le pack au changement de niche, le profil au
    //    ré-entraînement. Un préfixe mal ordonné invalide le cache plus souvent.
    { role: 'system', content: promptContent, cacheable: true },
    { role: 'system', content: buildNicheBlock(input.pack), cacheable: true },
    { role: 'system', content: buildVoiceBlock(input.profile), cacheable: true },
    // ── Partie variable.
    { role: 'user', content: buildPostBlock(input) },
  ],

  interpret: (raw) => {
    if (raw.variants.length === 0) {
      // Le WRITER a le droit de ne rien proposer, et c'est un résultat, pas une panne.
      return err({
        kind: 'refused',
        reason: raw.declineReason ?? 'aucun angle identifié',
      })
    }
    const nonEmpty = raw.variants.filter((v) => v.text.trim().length > 0)
    if (nonEmpty.length === 0) {
      return err({ kind: 'refused', reason: 'variantes vides' })
    }
    return ok({ variants: nonEmpty, sharedContext: raw.sharedContext })
  },

  label: (input) => `writer:${input.post.postId}`,
})

/**
 * Mesure la diversité d'angles d'un jeu de variantes.
 *
 * Le mode de défaillance attendu du WRITER est de produire la même idée trois fois. On ne
 * peut pas l'empêcher par le schéma — trois angles différents peuvent porter la même
 * idée — mais on peut le mesurer et le remonter au CRITIC, qui décidera si c'est un vrai
 * choix ou du remplissage.
 */
export function angleDiversity(variants: readonly WriterVariant[]): number {
  if (variants.length <= 1) return variants.length
  return new Set(variants.map((v) => v.angle)).size / variants.length
}
