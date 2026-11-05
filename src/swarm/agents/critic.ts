/**
 * Agent CRITIC — le veto.
 *
 * C'est lui qui empêche le produit d'être un générateur de bruit, donc sa qualité *est* la
 * qualité du produit. Trois choix de conception portent cette qualité :
 *
 *  1. **Le seuil est appliqué en code, pas seulement demandé au modèle.** Un juge LLM
 *     dérive : il dit `pass` en donnant une note de 0,4. On recalcule le verdict à partir
 *     des notes, et le désaccord est tracé plutôt que résolu en faveur du modèle.
 *  2. **Le risque réputationnel a son propre plafond.** Une moyenne masquerait exactement le
 *     cas qu'on veut attraper : excellente sur tout, risquée sur un point.
 *  3. **La distance de voix est calculée mécaniquement et fournie en entrée**, plutôt que
 *     laissée à l'appréciation du modèle. Un LLM juge mal la longueur et la ponctuation ;
 *     une statistique le fait exactement.
 */
import {
  CriticOutputSchema,
  DEFAULT_VETO_THRESHOLD,
  MAX_REPUTATION_RISK,
  type CriticScore,
} from '../schemas/critic.io'
import { defineAgent, type Agent, type AgentFailure } from '../agent'
import { err, ok, type Result } from '@/shared/result'
import type { LlmMessage } from '@/llm/types'
import type { NichePack } from '@/niches/pack.schema'
import type { VoiceProfileRecord } from '@/db/schema'
import type { WriterVariant } from '../schemas/writer.io'
import { computeVoiceDistance, describeDistance } from '@/memory/voice-distance'
import { isProfileUsable } from '@/memory/voice-profile'
import { angleDiversity } from './writer'

export interface CriticInput {
  postText: string
  variants: readonly WriterVariant[]
  pack: NichePack
  profile: VoiceProfileRecord | null
  /** Seuil de veto effectif. Configurable, calibré par mesure. */
  vetoThreshold?: number
}

export interface CriticResult {
  verdict: 'pass' | 'veto'
  scores: CriticScore[]
  selectedIndex: number | null
  selected: WriterVariant | null
  rejectionReason: string | null
  /** Distance de voix mesurée par variante — conservée pour l'UI et les analytics. */
  voiceDistances: number[]
  /**
   * Vrai si le code a infirmé le verdict du modèle. Métrique de calibration : un taux élevé
   * signifie que le prompt et le seuil ne disent pas la même chose.
   */
  overrodeModel: boolean
}

/** Bloc de référence pour juger la voix — cachable, il ne dépend pas des variantes. */
export function buildCriticVoiceBlock(profile: VoiceProfileRecord | null): string {
  if (!profile || profile.sampleSize === 0) {
    return [
      '## Voix de référence',
      '',
      "Aucun profil disponible. Tu ne peux pas juger l'authenticité de la voix : note",
      '`voiceAuthenticity` à 0,5 et fonde ton verdict sur les autres critères.',
    ].join('\n')
  }

  const lines = [
    '## Voix de référence',
    '',
    `Confiance du profil : ${(profile.confidence * 100).toFixed(0)} % sur ${profile.sampleSize} posts.`,
  ]

  if (!isProfileUsable(profile)) {
    lines.push(
      '',
      "**Profil faible.** On ne peut pas affirmer qu'un texte ressemble à un style qu'on",
      'connaît mal. Note `voiceAuthenticity` plus bas par défaut.',
    )
  }

  const s = profile.stats
  lines.push(
    '',
    '### Forme attendue',
    `- longueur : ${Math.round(s.p10Length)}–${Math.round(s.p90Length)} caractères`,
    `- ${s.avgSentencesPerPost.toFixed(1)} phrases par post`,
    `- emojis dans ${(s.emojiRate * 100).toFixed(0)} % des posts`,
    `- exclamations dans ${(s.exclamationRate * 100).toFixed(0)} %`,
  )

  if (profile.recurringTopics.length > 0) {
    lines.push(
      '',
      '### Sujets déjà traités par l’utilisateur',
      profile.recurringTopics.join(' · '),
      '',
      'Une variante qui reprend un de ces sujets sans rien y ajouter est redondante.',
    )
  }
  if (profile.signaturePhrases.length > 0) {
    lines.push('', '### Formulations habituelles', profile.signaturePhrases.join(' · '))
  }
  return lines.join('\n')
}

/** Bloc variable : les variantes, avec leur distance de voix mesurée. */
export function buildVariantsBlock(
  input: CriticInput,
  distances: readonly number[],
): string {
  const lines = [
    '## Post d’origine',
    '',
    input.postText || '(aucun texte)',
    '',
    '## Variantes à évaluer',
  ]

  for (const [i, variant] of input.variants.entries()) {
    const distance = distances[i]
    lines.push(
      '',
      `### Variante ${i}`,
      `- angle déclaré : ${variant.angle}`,
      `- intention déclarée : ${variant.intent}`,
      distance === undefined
        ? ''
        : `- distance de forme mesurée : ${distance.toFixed(2)} (0 = conforme au profil)`,
      '',
      variant.text,
    )
  }

  const diversity = angleDiversity(input.variants)
  if (input.variants.length > 1 && diversity < 1) {
    lines.push(
      '',
      '**Attention** : deux variantes ou plus déclarent le même angle. Vérifie si elles',
      "portent réellement des propositions distinctes ou si l'une est du remplissage.",
    )
  }

  if (input.pack.promptFragments.criticExtraRules) {
    lines.push(
      '',
      '## Règles propres à la niche',
      input.pack.promptFragments.criticExtraRules,
    )
  }
  return lines.filter((l) => l !== '').join('\n')
}

/**
 * Recalcule le verdict à partir des notes.
 *
 * On ne fait pas confiance au verdict déclaré : un juge LLM dit régulièrement `pass` avec
 * une note de 0,4. Résoudre le désaccord en faveur du modèle reviendrait à rendre le seuil
 * décoratif ; en faveur du code, à ignorer un jugement qualitatif. On applique le code — le
 * seuil est la règle du produit — et on **trace** le désaccord, qui est un signal de
 * calibration.
 */
export function applyThreshold(
  scores: readonly CriticScore[],
  threshold: number,
): { verdict: 'pass' | 'veto'; bestIndex: number | null; reason: string | null } {
  const eligible = scores.filter(
    (s) => s.overall >= threshold && s.reputationRisk <= MAX_REPUTATION_RISK,
  )

  if (eligible.length === 0) {
    const best = [...scores].sort((a, b) => b.overall - a.overall)[0]
    // Le motif nomme la contrainte qui a bloqué, pas « qualité insuffisante » : c'est ce qui
    // rend le rejet actionnable.
    if (best && best.reputationRisk > MAX_REPUTATION_RISK) {
      return {
        verdict: 'veto',
        bestIndex: null,
        reason: `risque réputationnel trop élevé (${best.reputationRisk.toFixed(2)}) : ${best.note || 'sans détail'}`,
      }
    }
    return {
      verdict: 'veto',
      bestIndex: null,
      reason: best
        ? `meilleure note ${best.overall.toFixed(2)} sous le seuil de ${threshold.toFixed(2)} : ${best.note || 'sans détail'}`
        : 'aucune variante évaluée',
    }
  }

  const best = eligible.reduce((a, b) => (b.overall > a.overall ? b : a))
  return { verdict: 'pass', bestIndex: best.index, reason: null }
}

export const criticAgent: Agent<CriticInput, CriticResult> = defineAgent({
  role: 'critic',
  promptId: 'critic',
  schema: CriticOutputSchema,

  buildMessages: (input, promptContent): LlmMessage[] => {
    const distances = input.profile
      ? input.variants.map(
          (v) => computeVoiceDistance(v.text, input.profile!.stats).distance,
        )
      : input.variants.map(() => 0.5)

    return [
      { role: 'system', content: promptContent, cacheable: true },
      { role: 'system', content: buildCriticVoiceBlock(input.profile), cacheable: true },
      { role: 'user', content: buildVariantsBlock(input, distances) },
    ]
  },

  interpret: (raw, input): Result<CriticResult, AgentFailure> => {
    const threshold = input.vetoThreshold ?? DEFAULT_VETO_THRESHOLD

    // Notes hors périmètre : un index qui ne désigne aucune variante rend la note
    // inexploitable, et l'ignorer silencieusement fausserait le verdict.
    const valid = raw.scores.filter(
      (s) => s.index >= 0 && s.index < input.variants.length,
    )
    if (valid.length === 0) {
      return err({ kind: 'refused', reason: 'aucune note exploitable' })
    }

    const computed = applyThreshold(valid, threshold)
    const overrodeModel = computed.verdict !== raw.verdict

    const distances = input.profile
      ? input.variants.map(
          (v) => computeVoiceDistance(v.text, input.profile!.stats).distance,
        )
      : input.variants.map(() => 0.5)

    if (computed.verdict === 'veto') {
      // Un veto est un `ok`, pas une erreur : c'est le résultat attendu du CRITIC dans une
      // grande partie des cas, et le remonter en erreur ferait alarmer sur un
      // fonctionnement normal (SPEC §4.5).
      return ok({
        verdict: 'veto',
        scores: valid,
        selectedIndex: null,
        selected: null,
        // Le motif du modèle est plus informatif que le nôtre quand les deux sont d'accord.
        rejectionReason:
          raw.verdict === 'veto' && raw.rejectionReason
            ? raw.rejectionReason
            : computed.reason,
        voiceDistances: distances,
        overrodeModel,
      })
    }

    const index = computed.bestIndex ?? 0
    return ok({
      verdict: 'pass',
      scores: valid,
      selectedIndex: index,
      selected: input.variants[index] ?? null,
      rejectionReason: null,
      voiceDistances: distances,
      overrodeModel,
    })
  },

  label: (input) => `critic:${input.variants.length}v`,
})

/**
 * Statistiques de calibration.
 *
 * Un CRITIC qui rejette 95 % ou 5 % est inutile, et c'est l'état par défaut d'un juge LLM
 * non calibré. Cette fonction alimente la tâche de calibration et l'onglet Analytics.
 */
export function calibrationStats(results: readonly CriticResult[]): {
  rejectionRate: number
  overrideRate: number
  avgOverall: number
  sample: number
} {
  if (results.length === 0) {
    return { rejectionRate: 0, overrideRate: 0, avgOverall: 0, sample: 0 }
  }
  const vetoes = results.filter((r) => r.verdict === 'veto').length
  const overrides = results.filter((r) => r.overrodeModel).length
  const allScores = results.flatMap((r) => r.scores.map((s) => s.overall))
  return {
    rejectionRate: vetoes / results.length,
    overrideRate: overrides / results.length,
    avgOverall:
      allScores.length === 0
        ? 0
        : allScores.reduce((a, b) => a + b, 0) / allScores.length,
    sample: results.length,
  }
}

export { describeDistance }
