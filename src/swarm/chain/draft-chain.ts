/**
 * Chaîne WRITER → CRITIC.
 *
 * C'est le premier endroit où le produit devient un *système* plutôt qu'un appel : deux
 * agents, une trace consolidée, et un veto qui peut annuler tout le travail en amont.
 *
 * ## Pourquoi QUICK-REPLY survit
 *
 * La chaîne ne remplace pas l'agent one-shot de la Phase 1, elle coexiste avec lui derrière
 * un réglage. C'est la seule façon de mesurer ce que la Phase 2 apporte : supprimer la
 * référence rendrait « le swarm fait mieux que la génération one-shot » invérifiable, et
 * c'est précisément la thèse du produit.
 */
import { angleDiversity, writerAgent, type WriterInput } from '../agents/writer'
import { criticAgent, type CriticResult } from '../agents/critic'
import { combinedHash } from '../prompts'
import { totalCost, type AgentContext, type AgentFailure } from '../agent'
import type { AgentTrailStep, VoiceProfileRecord } from '@/db/schema'
import type { WriterVariant } from '../schemas/writer.io'
import type { NichePack } from '@/niches/pack.schema'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import { computeVoiceDistance } from '@/memory/voice-distance'
import { err, ok, type Result } from '@/shared/result'
import { createLogger } from '@/shared/logger'

const log = createLogger('swarm:chain')

export interface DraftChainInput {
  post: ExtractedPost
  pack: NichePack
  profile: VoiceProfileRecord | null
  userHint?: string
  vetoThreshold?: number
}

export interface DraftChainResult {
  /** Toutes les variantes produites, y compris celles que le CRITIC n'a pas retenues. */
  variants: WriterVariant[]
  critic: CriticResult
  /** Variante retenue, ou `null` si le CRITIC a posé son veto. */
  selected: WriterVariant | null
  /** Distance de voix par variante, alignée sur `variants`. */
  voiceDistances: number[]
  angleDiversity: number
  trail: AgentTrailStep[]
  totalCostEur: number
  /** Hash combiné des prompts de la chaîne — MH-04. */
  promptVersionHash: string
  sharedContext: string
}

export type DraftChainFailure =
  /** Le CRITIC a rejeté toutes les variantes. Résultat attendu, pas panne. */
  | {
      kind: 'vetoed'
      reason: string
      trail: AgentTrailStep[]
      totalCostEur: number
      scores: CriticResult['scores']
    }
  /** Le WRITER n'a rien proposé. */
  | { kind: 'no-angle'; reason: string; trail: AgentTrailStep[]; totalCostEur: number }
  | {
      kind: 'agent'
      stage: 'writer' | 'critic'
      failure: AgentFailure
      trail: AgentTrailStep[]
    }

/**
 * Exécute la chaîne.
 *
 * La trace est accumulée à chaque étape et retournée **même en cas d'échec** : un veto a
 * coûté deux appels, et ce coût doit apparaître dans le budget comme dans les analytics.
 * Ne compter que les succès sous-estimerait systématiquement la dépense réelle — et
 * fausserait le coût par follower gagné, qui est une métrique affichée.
 */
export async function runDraftChain(
  input: DraftChainInput,
  ctx: AgentContext,
): Promise<Result<DraftChainResult, DraftChainFailure>> {
  const trail: AgentTrailStep[] = []

  /* ── 1. WRITER ────────────────────────────────────────────────────────── */
  const writerInput: WriterInput = {
    post: input.post,
    pack: input.pack,
    profile: input.profile,
    ...(input.userHint !== undefined ? { userHint: input.userHint } : {}),
  }
  const written = await writerAgent.run(writerInput, ctx)

  if (!written.ok) {
    if (written.error.kind === 'refused') {
      // Le WRITER n'a pas trouvé d'angle. Refus légitime : le préférer à une variante creuse
      // est le comportement voulu.
      return err({
        kind: 'no-angle',
        reason: written.error.reason,
        trail,
        totalCostEur: totalCost(trail),
      })
    }
    return err({ kind: 'agent', stage: 'writer', failure: written.error, trail })
  }

  trail.push(written.value.step)
  const variants = written.value.output.variants

  /* ── 2. CRITIC ────────────────────────────────────────────────────────── */
  const reviewed = await criticAgent.run(
    {
      postText: input.post.text,
      variants,
      pack: input.pack,
      profile: input.profile,
      ...(input.vetoThreshold !== undefined
        ? { vetoThreshold: input.vetoThreshold }
        : {}),
    },
    ctx,
  )

  if (!reviewed.ok) {
    // Un CRITIC en panne ne doit **pas** faire passer les variantes par défaut. Sans
    // contrôle qualité, le produit redevient un générateur de bruit : on rejette.
    if (reviewed.error.kind === 'refused') {
      return err({
        kind: 'vetoed',
        reason: `contrôle qualité indisponible : ${reviewed.error.reason}`,
        trail,
        totalCostEur: totalCost(trail),
        scores: [],
      })
    }
    return err({ kind: 'agent', stage: 'critic', failure: reviewed.error, trail })
  }

  trail.push(reviewed.value.step)
  const critic = reviewed.value.output

  const voiceDistances = input.profile
    ? variants.map((v) => computeVoiceDistance(v.text, input.profile!.stats).distance)
    : variants.map(() => 0.5)

  const promptVersionHash = await combinedHash(
    trail.map((step) => ({ role: step.role, hash: step.promptVersionHash })),
  )

  if (critic.verdict === 'veto') {
    log.info('opportunité rejetée par le CRITIC', {
      postId: input.post.postId,
      reason: critic.rejectionReason,
      variantsConsidered: variants.length,
      costEur: totalCost(trail),
    })
    return err({
      kind: 'vetoed',
      reason: critic.rejectionReason ?? 'aucune variante retenue',
      trail,
      totalCostEur: totalCost(trail),
      scores: critic.scores,
    })
  }

  if (critic.overrodeModel) {
    // Signal de calibration : le prompt et le seuil ne disent pas la même chose. Un taux
    // élevé demande de retoucher l'un des deux, pas d'ignorer le désaccord.
    log.info('verdict du CRITIC recalculé par le seuil', { postId: input.post.postId })
  }

  return ok({
    variants,
    critic,
    selected: critic.selected,
    voiceDistances,
    angleDiversity: angleDiversity(variants),
    trail,
    totalCostEur: totalCost(trail),
    promptVersionHash,
    sharedContext: written.value.output.sharedContext,
  })
}

/** Message lisible pour l'overlay. Un veto se dit comme un résultat, pas comme une panne. */
export function describeChainFailure(failure: DraftChainFailure): string {
  switch (failure.kind) {
    case 'vetoed':
      return failure.reason
    case 'no-angle':
      return failure.reason
    case 'agent':
      return failure.failure.kind === 'llm'
        ? failure.failure.error.message
        : failure.failure.reason
  }
}
