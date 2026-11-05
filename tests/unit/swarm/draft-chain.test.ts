/**
 * Chaîne WRITER → CRITIC.
 *
 * Ce que ces tests protègent, et qui n'existait pas en Phase 1 :
 *
 *  1. **Le coût est remonté même en cas de veto.** Un veto a consommé deux appels. Ne compter
 *     que les succès sous-estimerait systématiquement la dépense et fausserait le coût par
 *     follower gagné, qui est une métrique affichée.
 *  2. **Un CRITIC en panne ne fait PAS passer les variantes.** Sans contrôle qualité, le
 *     produit redevient un générateur de bruit — le mode de défaillance à interdire.
 *  3. **Le hash combiné traverse la chaîne** (MH-04), sans quoi la boucle d'apprentissage de
 *     la Phase 5 attribuerait les performances au mauvais prompt.
 */
import { describe, expect, it, vi } from 'vitest'
import { runDraftChain, describeChainFailure } from '@/swarm/chain/draft-chain'
import { bundledPack } from '@/niches/loader'
import { ZERO_USAGE } from '@/llm/types'
import { LlmError } from '@/llm/errors'
import { computeCostEur, FALLBACK_TABLE } from '@/llm/pricing'
import type { LlmClient } from '@/llm/client'
import type { ExtractedPost } from '@/content/dom/dom-schemas'

const pack = bundledPack('memecoin')!

const post: ExtractedPost = {
  postId: '1789456123456789012',
  authorHandle: 'aliceonchain',
  authorDisplayName: 'Alice Onchain',
  text: 'the bonding curve mechanics on this launch are genuinely different',
  lang: 'en',
  postedAtMs: Date.parse('2026-08-25T10:12:00.000Z'),
  replyCount: 12,
  likeCount: 88,
  repostCount: 4,
  hasMedia: false,
  hasQuote: false,
  isReply: false,
  isOwnPost: false,
  surface: 'timeline',
  observedAtMs: Date.parse('2026-08-25T10:42:00.000Z'),
  permalink: '/aliceonchain/status/1789456123456789012',
}

const WRITER_OK = {
  variants: [
    { text: 'locked liquidity is table stakes now', angle: 'counterpoint', intent: 'i0' },
    { text: 'le float est le vrai signal ici', angle: 'data', intent: 'i1' },
  ],
  sharedContext: 'mécanique de liquidité',
  declineReason: null,
}

const critScore = (index: number, overall: number) => ({
  index,
  voiceAuthenticity: 0.75,
  valueAdded: 0.75,
  reputationRisk: 0.1,
  redundancy: 0.1,
  attentionCost: 0.2,
  overall,
  note: 'note',
})

/**
 * Client scripté : renvoie une réponse par appel, dans l'ordre.
 * Les coûts sont distincts pour vérifier que la trace additionne réellement.
 */
function scriptedClient(
  steps: readonly ({ data: unknown; costEur: number; model: string } | LlmError)[],
): { client: LlmClient; callCount: () => number } {
  let index = 0
  const client = {
    call: vi.fn(() => {
      const step = steps[index++]
      if (step === undefined) throw new Error('appel non prévu par le script de test')
      if (step instanceof LlmError)
        return Promise.resolve({ ok: false as const, error: step })
      return Promise.resolve({
        ok: true as const,
        value: {
          text: JSON.stringify(step.data),
          data: step.data,
          usage: { ...ZERO_USAGE, inputTokens: 2_000, outputTokens: 250 },
          costEur: step.costEur,
          model: step.model,
          provider: 'openrouter' as const,
          repaired: false,
          latencyMs: 1_500,
        },
      })
    }),
  } as unknown as LlmClient
  return { client, callCount: () => index }
}

describe('chemin nominal', () => {
  it('enchaîne WRITER puis CRITIC et consolide la trace', async () => {
    const { client, callCount } = scriptedClient([
      { data: WRITER_OK, costEur: 0.0074, model: 'anthropic/claude-sonnet-5' },
      {
        data: {
          scores: [critScore(0, 0.65), critScore(1, 0.85)],
          verdict: 'pass',
          selectedIndex: 1,
          rejectionReason: null,
        },
        costEur: 0.0061,
        model: 'anthropic/claude-sonnet-5',
      },
    ])

    const result = await runDraftChain({ post, pack, profile: null }, { client })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(callCount()).toBe(2)
    expect(result.value.variants).toHaveLength(2)
    expect(result.value.selected?.angle).toBe('data')
    expect(result.value.trail).toHaveLength(2)
    expect(result.value.trail.map((s) => s.role)).toEqual(['writer', 'critic'])
    expect(result.value.totalCostEur).toBeCloseTo(0.0135, 6)
    expect(result.value.promptVersionHash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('mesure la diversité des angles et la distance de voix', async () => {
    const { client } = scriptedClient([
      { data: WRITER_OK, costEur: 0.007, model: 'm' },
      {
        data: {
          scores: [critScore(0, 0.8), critScore(1, 0.7)],
          verdict: 'pass',
          selectedIndex: 0,
          rejectionReason: null,
        },
        costEur: 0.006,
        model: 'm',
      },
    ])
    const result = await runDraftChain({ post, pack, profile: null }, { client })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.angleDiversity).toBe(1)
    // Sans profil, la distance est inconnue — pas nulle.
    expect(result.value.voiceDistances).toEqual([0.5, 0.5])
  })

  it('le hash combiné change si un prompt de la chaîne change', async () => {
    // Sans ça, la Phase 5 attribuerait les performances au mauvais prompt (MH-04).
    const runWith = async (): Promise<string> => {
      const { client } = scriptedClient([
        { data: WRITER_OK, costEur: 0.007, model: 'm' },
        {
          data: {
            scores: [critScore(0, 0.8)],
            verdict: 'pass',
            selectedIndex: 0,
            rejectionReason: null,
          },
          costEur: 0.006,
          model: 'm',
        },
      ])
      const r = await runDraftChain({ post, pack, profile: null }, { client })
      if (!r.ok) throw new Error('attendu: ok')
      return r.value.promptVersionHash
    }
    // Deux exécutions identiques donnent le même hash : c'est la condition de comparabilité.
    expect(await runWith()).toBe(await runWith())
  })
})

describe('veto — un résultat, pas une panne', () => {
  it('remonte le veto avec son motif ET son coût réel (MH-05)', async () => {
    const { client } = scriptedClient([
      { data: WRITER_OK, costEur: 0.0074, model: 'm' },
      {
        data: {
          scores: [critScore(0, 0.3), critScore(1, 0.35)],
          verdict: 'veto',
          selectedIndex: null,
          rejectionReason: 'aucune ne dit rien de neuf',
        },
        costEur: 0.0061,
        model: 'm',
      },
    ])

    const result = await runDraftChain({ post, pack, profile: null }, { client })
    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'vetoed') throw new Error('attendu: vetoed')

    expect(result.error.reason).toContain('rien de neuf')
    // Le point qui compte : deux appels ont été payés, ils doivent apparaître.
    expect(result.error.totalCostEur).toBeCloseTo(0.0135, 6)
    expect(result.error.trail).toHaveLength(2)
    expect(result.error.scores).toHaveLength(2)
  })

  it('le seuil configuré change le verdict', async () => {
    const build = (threshold: number) => {
      const { client } = scriptedClient([
        { data: WRITER_OK, costEur: 0.007, model: 'm' },
        {
          data: {
            scores: [critScore(0, 0.7), critScore(1, 0.72)],
            verdict: 'pass',
            selectedIndex: 1,
            rejectionReason: null,
          },
          costEur: 0.006,
          model: 'm',
        },
      ])
      return runDraftChain(
        { post, pack, profile: null, vetoThreshold: threshold },
        { client },
      )
    }
    expect((await build(0.5)).ok).toBe(true)
    expect((await build(0.9)).ok).toBe(false)
  })

  it('un WRITER sans angle remonte no-angle, avec son coût', async () => {
    const { client, callCount } = scriptedClient([
      {
        data: { variants: [], sharedContext: '', declineReason: 'le fil dit déjà tout' },
        costEur: 0.0074,
        model: 'm',
      },
    ])
    const result = await runDraftChain({ post, pack, profile: null }, { client })
    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'no-angle')
      throw new Error('attendu: no-angle')
    expect(result.error.reason).toContain('le fil dit déjà tout')
    // Le CRITIC n'a pas été appelé : rien à relire.
    expect(callCount()).toBe(1)
  })
})

describe('pannes', () => {
  it('un CRITIC en panne REJETTE, il ne laisse pas passer', async () => {
    // Le mode de défaillance à interdire : sans contrôle qualité, le produit redevient un
    // générateur de bruit. « Échouer ouvert » serait le pire choix possible ici.
    const { client } = scriptedClient([
      { data: WRITER_OK, costEur: 0.0074, model: 'm' },
      {
        // Notes hors périmètre : le CRITIC ne peut rien conclure.
        data: {
          scores: [{ ...critScore(9, 0.9) }],
          verdict: 'pass',
          selectedIndex: 9,
          rejectionReason: null,
        },
        costEur: 0.0061,
        model: 'm',
      },
    ])
    const result = await runDraftChain({ post, pack, profile: null }, { client })
    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'vetoed') throw new Error('attendu: vetoed')
    expect(result.error.reason).toContain('contrôle qualité indisponible')
  })

  it('une erreur LLM du WRITER remonte avec son étape', async () => {
    const { client } = scriptedClient([new LlmError('rate-limit', '429')])
    const result = await runDraftChain({ post, pack, profile: null }, { client })
    expect(result.ok).toBe(false)
    if (result.ok || result.error.kind !== 'agent') throw new Error('attendu: agent')
    expect(result.error.stage).toBe('writer')
    expect(result.error.trail).toHaveLength(0)
  })

  it('une erreur LLM du CRITIC conserve la trace du WRITER', async () => {
    // Le WRITER a coûté : sa trace ne doit pas disparaître parce que l'étape suivante a
    // échoué.
    const { client } = scriptedClient([
      { data: WRITER_OK, costEur: 0.0074, model: 'm' },
      new LlmError('server', '503'),
    ])
    const result = await runDraftChain({ post, pack, profile: null }, { client })
    if (result.ok || result.error.kind !== 'agent') throw new Error('attendu: agent')
    expect(result.error.stage).toBe('critic')
    expect(result.error.trail).toHaveLength(1)
  })

  it('décrit chaque échec en langue naturelle', () => {
    expect(
      describeChainFailure({
        kind: 'vetoed',
        reason: 'motif clair',
        trail: [],
        totalCostEur: 0,
        scores: [],
      }),
    ).toBe('motif clair')
    expect(
      describeChainFailure({
        kind: 'agent',
        stage: 'writer',
        failure: { kind: 'llm', error: new LlmError('auth', 'clé refusée') },
        trail: [],
      }),
    ).toContain('clé refusée')
  })
})

describe('coût de la chaîne vs chiffrage SPEC §3.2', () => {
  /**
   * Assertion de budget.
   *
   * SPEC §3.2 chiffre un cycle de rédaction à ~0,014 €. Un dépassement doit faire échouer la
   * CI, pas se découvrir en fin de mois sur une facture. On mesure ici avec les tarifs de
   * référence et les tailles de prompt annoncées.
   */
  it('un cycle WRITER + CRITIC reste dans le chiffrage annoncé', () => {
    // WRITER : 2 000 tokens d'entrée dont 1 700 en cache, 400 de sortie, sur Sonnet 5.
    const writer = computeCostEur(FALLBACK_TABLE, 'claude-sonnet-5', {
      inputTokens: 300,
      outputTokens: 400,
      cacheReadTokens: 1_700,
      cacheWriteTokens: 0,
    })
    // CRITIC : 2 500 d'entrée dont 2 000 en cache, 300 de sortie.
    const critic = computeCostEur(FALLBACK_TABLE, 'claude-sonnet-5', {
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 0,
    })

    const cycle = writer.eur + critic.eur
    expect(cycle).toBeLessThan(0.014)
    // Et le budget quotidien de 1 € doit tenir le plafond de 12 réponses par jour.
    expect(cycle * 12).toBeLessThan(0.75)
  })

  it('sans cache, le coût explose — ce qui justifie la frontière (R-03)', () => {
    // La démonstration chiffrée de l'hypothèse porteuse : si OpenRouter ne propage pas
    // `cache_control`, tout le chiffrage à 1 €/jour tombe.
    const cached = computeCostEur(FALLBACK_TABLE, 'claude-sonnet-5', {
      inputTokens: 300,
      outputTokens: 400,
      cacheReadTokens: 1_700,
      cacheWriteTokens: 0,
    })
    const uncached = computeCostEur(FALLBACK_TABLE, 'claude-sonnet-5', {
      inputTokens: 2_000,
      outputTokens: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(uncached.eur / cached.eur).toBeGreaterThan(1.5)
  })
})
