/**
 * Agent QUALIFIER — le triage de masse.
 *
 * C'est l'agent qui rend l'économie du produit possible : **200 posts pour moins de
 * 0,05 €** (DoD de la Phase 3). Trois décisions portent ce chiffre :
 *
 *  1. **Le lot.** 50 posts par appel, donc 4 appels pour 200. Le prompt système est payé
 *     4 fois au lieu de 200.
 *  2. **Le préfixe cachable.** Prompt + brief de niche sont identiques d'un lot à l'autre ;
 *     seuls les posts changent. C'est ce qui fait passer l'entrée à un dixième du tarif.
 *  3. **La sortie minimale.** Une ligne par post, `note` bornée à 40 caractères. La sortie
 *     est facturée trois à cinq fois l'entrée : c'est là que le coût se gagne ou se perd.
 *
 * Le modèle ne calcule **ni** portée, **ni** fraîcheur, **ni** saturation. Le code les mesure
 * exactement à partir des métriques du DOM, et il le fait mieux qu'une estimation. Le
 * QUALIFIER ne juge que ce qu'un modèle sait juger : la pertinence de niche et l'angle
 * disponible.
 */
import {
  NO_ANGLE_RELEVANCE_CAP,
  QualifierOutputSchema,
  QUALIFIER_BATCH_SIZE,
  type QualifierVerdict,
} from '../schemas/qualifier.io'
import { defineAgent, type Agent, type AgentContext, type AgentFailure } from '../agent'
import { err, ok, type Result } from '@/shared/result'
import type { LlmMessage } from '@/llm/types'
import type { NichePack } from '@/niches/pack.schema'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import type { AgentTrailStep } from '@/db/schema'
import { createLogger } from '@/shared/logger'

const log = createLogger('swarm:qualifier')

export interface QualifierInput {
  /** Lot de posts. Au plus `QUALIFIER_BATCH_SIZE`. */
  posts: readonly ExtractedPost[]
  pack: NichePack
}

export interface QualifiedPost {
  post: ExtractedPost
  relevance: number
  angle: string | null
  note: string
  /** Vrai si le verdict du modèle a été corrigé en aval. */
  corrected: boolean
}

export interface QualifierResult {
  qualified: QualifiedPost[]
  /** Posts pour lesquels le modèle n'a rendu aucun verdict. */
  missingVerdicts: number
}

/**
 * Brief de niche, cachable.
 *
 * Volontairement plus court que celui du WRITER : le QUALIFIER n'a pas besoin de savoir
 * *comment* bien écrire, seulement *de quoi* la niche parle. Chaque ligne superflue ici est
 * payée quatre fois par jour.
 */
export function buildQualifierNicheBlock(pack: NichePack): string {
  return [
    `## Niche : ${pack.label}`,
    '',
    pack.domainBrief,
    '',
    `### Angles autorisés\n${pack.allowedAngles.join(', ')}`,
    pack.keywords.length > 0
      ? `\n### Termes de la niche\n${pack.keywords.join(', ')}`
      : '',
    pack.negativeKeywords.length > 0
      ? `\n### Bruit connu, à écarter\n${pack.negativeKeywords.join(', ')}`
      : '',
    pack.additionalBlockedTopics.length > 0
      ? `\n### Sujets interdits dans cette niche\n${pack.additionalBlockedTopics.join(' ; ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Lot de posts, partie variable.
 *
 * Le texte est tronqué à 400 caractères. Un post de X en fait 280 dans l'immense majorité
 * des cas ; les longs sont des threads dépliés dont le début suffit à juger la pertinence.
 * Envoyer 4 000 caractères par post multiplierait le coût du triage par cinq pour un gain
 * de jugement nul.
 */
export function buildBatchBlock(posts: readonly ExtractedPost[]): string {
  const lines = ['## Posts à trier', '']
  for (const [index, post] of posts.entries()) {
    const text = post.text.length > 400 ? `${post.text.slice(0, 400)}…` : post.text
    lines.push(
      `--- id: ${index}`,
      `@${post.authorHandle}${post.hasMedia ? ' [média]' : ''}${post.isReply ? ' [réponse]' : ''}`,
      text || '(aucun texte)',
    )
  }
  lines.push('', `Renvoie exactement ${posts.length} verdicts.`)
  return lines.join('\n')
}

const qualifierAgent: Agent<QualifierInput, QualifierResult> = defineAgent({
  role: 'qualifier',
  promptId: 'qualifier',
  schema: QualifierOutputSchema,

  buildMessages: (input, promptContent): LlmMessage[] => [
    // Préfixe stable, payé une fois par lot puis mis en cache.
    { role: 'system', content: promptContent, cacheable: true },
    { role: 'system', content: buildQualifierNicheBlock(input.pack), cacheable: true },
    { role: 'user', content: buildBatchBlock(input.posts) },
  ],

  interpret: (raw, input): Result<QualifierResult, AgentFailure> => {
    const byId = new Map<string, QualifierVerdict>()
    for (const verdict of raw.verdicts) byId.set(verdict.id, verdict)

    const qualified: QualifiedPost[] = []
    let missing = 0

    for (const [index, post] of input.posts.entries()) {
      const verdict = byId.get(String(index))
      if (!verdict) {
        // Un post omis est traité comme non pertinent, et **compté**. Le taire ferait
        // disparaître des opportunités sans trace : le pire mode de défaillance pour un
        // module de triage, parce qu'il est invisible.
        missing += 1
        continue
      }

      // Contradiction fréquente : pertinence haute sans angle. Le prompt l'interdit, un
      // modèle le fait quand même. On tranche vers la prudence — pas d'angle signifie rien
      // à apporter.
      const needsCap =
        verdict.angle === null && verdict.relevance > NO_ANGLE_RELEVANCE_CAP
      const relevance = needsCap ? NO_ANGLE_RELEVANCE_CAP : verdict.relevance

      // Un angle hors de ceux autorisés par le pack est écarté : le laisser passer
      // produirait des patterns inexploitables en Phase 5.
      const angleAllowed =
        verdict.angle !== null &&
        (input.pack.allowedAngles as readonly string[]).includes(verdict.angle)

      qualified.push({
        post,
        relevance,
        angle: angleAllowed ? verdict.angle : null,
        note: verdict.note,
        corrected: needsCap || (verdict.angle !== null && !angleAllowed),
      })
    }

    if (qualified.length === 0) {
      return err({ kind: 'refused', reason: 'aucun verdict exploitable dans le lot' })
    }
    return ok({ qualified, missingVerdicts: missing })
  },

  label: (input) => `qualifier:${input.posts.length}`,
})

export { qualifierAgent }

/**
 * Découpe une liste de posts en lots.
 *
 * Exporté pour être testable : la taille du lot est le levier de coût le plus direct du
 * produit, et une régression ici ne se verrait que sur la facture.
 */
export function intoBatches<T>(items: readonly T[], size = QUALIFIER_BATCH_SIZE): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}

export interface QualifyAllResult {
  qualified: QualifiedPost[]
  trail: AgentTrailStep[]
  totalCostEur: number
  batches: number
  missingVerdicts: number
  /** Lots ayant échoué. Les posts concernés ne sont pas perdus, ils sont juste non triés. */
  failedBatches: number
}

/**
 * Trie une liste complète de posts, par lots.
 *
 * **Un lot en échec n'arrête pas les autres.** Sur 200 posts, perdre 50 opportunités parce
 * qu'un appel a échoué est acceptable ; perdre les 200 ne l'est pas. Les échecs sont comptés
 * et remontés plutôt que masqués.
 */
export async function qualifyAll(
  posts: readonly ExtractedPost[],
  pack: NichePack,
  ctx: AgentContext,
  batchSize = QUALIFIER_BATCH_SIZE,
): Promise<QualifyAllResult> {
  const batches = intoBatches(posts, batchSize)
  const qualified: QualifiedPost[] = []
  const trail: AgentTrailStep[] = []
  let missingVerdicts = 0
  let failedBatches = 0

  for (const batch of batches) {
    const result = await qualifierAgent.run({ posts: batch, pack }, ctx)
    if (!result.ok) {
      failedBatches += 1
      log.warn('lot de triage en échec', {
        size: batch.length,
        kind: result.error.kind,
      })
      continue
    }
    trail.push(result.value.step)
    qualified.push(...result.value.output.qualified)
    missingVerdicts += result.value.output.missingVerdicts
  }

  const totalCostEur = trail.reduce((sum, step) => sum + step.costEur, 0)

  log.info('triage terminé', {
    posts: posts.length,
    batches: batches.length,
    qualified: qualified.length,
    missingVerdicts,
    failedBatches,
    totalCostEur,
  })

  return {
    qualified,
    trail,
    totalCostEur,
    batches: batches.length,
    missingVerdicts,
    failedBatches,
  }
}
