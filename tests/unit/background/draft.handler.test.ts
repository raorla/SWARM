/**
 * Handler de la demande de rédaction.
 *
 * Ce que ces tests protègent :
 *
 *  1. **L'ordre des garde-fous.** Un clic de l'utilisateur autorise une rédaction, pas un
 *     contournement des interdits produit — répondre sur un deuil ou donner un signal de
 *     prix reste interdit, cliqué ou non (SPEC §2.2, MH-02).
 *  2. **Le chemin de référence reste atteignable.** La génération one-shot de la Phase 1
 *     coexiste avec la chaîne WRITER → CRITIC. Sans elle, « le swarm fait mieux » serait
 *     invérifiable.
 *  3. **Un veto est un résultat, pas une panne**, et son coût réel est remonté.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createDb, type SwarmDb } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { FakeClock } from '@/shared/time'
import type { ExtractedPostForReply } from '@/messaging/contract'

const post: ExtractedPostForReply = {
  postId: '1789456123456789012',
  authorHandle: 'aliceonchain',
  authorDisplayName: 'Alice Onchain',
  text: 'the bonding curve mechanics here are genuinely different',
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

/**
 * Compteur monotone de bases de test.
 *
 * `opened.length` ne convient PAS : le tableau est vidé après chaque test, donc tous les
 * tests rouvriraient la même base — et `fake-indexeddb` fait alors courir la suppression de
 * l'une avec l'ouverture de la suivante. Les échecs qui en résultent sont intermittents et
 * ne ressemblent pas à leur cause.
 */
let dbSeq = 0

const opened: SwarmDb[] = []

const CHAIN_VARIANTS = [
  { text: 'locked liquidity is table stakes now', angle: 'counterpoint', intent: 'i0' },
  { text: 'le float est le vrai signal ici', angle: 'data', intent: 'i1' },
]

interface SetupOptions {
  consented?: boolean
  keystoreInitialized?: boolean
  keystoreUnlocked?: boolean
  outcome?: 'reply' | 'decline' | 'error'
  draftMode?: 'chain' | 'quick-reply'
}

/**
 * Le handler utilise le singleton `db()` et les services du service worker. On les substitue
 * par module plutôt que de démonter le handler en morceaux injectables : ce qu'on veut
 * vérifier ici, c'est l'ORDRE des vérifications et le routage, pas les branchements.
 */
async function setup(options: SetupOptions): Promise<{
  handle: (typeof import('@/background/draft.handler'))['handleDraftRequest']
  runDraftChain: ReturnType<typeof vi.fn>
  runQuickReply: ReturnType<typeof vi.fn>
}> {
  vi.resetModules()

  const database = createDb(`handler-${dbSeq++}`)
  opened.push(database)
  const clock = new FakeClock('2026-08-25T12:00:00.000Z')

  const configRepo = new ConfigRepo(database, clock)
  await configRepo.get()
  if (options.consented !== false) await configRepo.acceptConsent()
  await configRepo.update({ draftMode: options.draftMode ?? 'chain' })

  vi.doMock('@/db', async () => {
    const actual = await vi.importActual<typeof import('@/db')>('@/db')
    return { ...actual, db: () => database }
  })

  const rateLimit = async (): Promise<Error> => {
    const { LlmError } =
      await vi.importActual<typeof import('@/llm/errors')>('@/llm/errors')
    return new LlmError('rate-limit', '429')
  }

  const runQuickReply = vi.fn(async () => {
    if (options.outcome === 'decline') {
      return {
        ok: false as const,
        error: { kind: 'declined' as const, reason: 'rien a ajouter' },
      }
    }
    if (options.outcome === 'error') {
      return {
        ok: false as const,
        error: { kind: 'llm' as const, error: await rateLimit() },
      }
    }
    return {
      ok: true as const,
      value: {
        decision: 'reply' as const,
        text: 'reponse one-shot de reference',
        angle: 'counterpoint',
        reasoning: 'contre-argument mecanique',
        confidence: 0.6,
        overLimit: false,
        costEur: 0.007,
        model: 'anthropic/claude-sonnet-5',
        latencyMs: 1200,
        promptVersionHash: 'abcdef0123456789',
        repaired: false,
      },
    }
  })

  const runDraftChain = vi.fn(async () => {
    if (options.outcome === 'decline') {
      return {
        ok: false as const,
        error: {
          kind: 'vetoed' as const,
          reason: 'aucune variante ne depasse le seuil',
          trail: [],
          totalCostEur: 0.013,
          scores: [],
        },
      }
    }
    if (options.outcome === 'error') {
      return {
        ok: false as const,
        error: {
          kind: 'agent' as const,
          stage: 'writer' as const,
          failure: { kind: 'llm' as const, error: await rateLimit() },
          trail: [],
        },
      }
    }
    return {
      ok: true as const,
      value: {
        variants: CHAIN_VARIANTS,
        critic: {
          verdict: 'pass' as const,
          selectedIndex: 1,
          selected: CHAIN_VARIANTS[1],
          rejectionReason: null,
          voiceDistances: [0.3, 0.2],
          overrodeModel: false,
          scores: [
            {
              index: 0,
              voiceAuthenticity: 0.7,
              valueAdded: 0.6,
              reputationRisk: 0.1,
              redundancy: 0.2,
              attentionCost: 0.3,
              overall: 0.65,
              note: 'correct',
            },
            {
              index: 1,
              voiceAuthenticity: 0.8,
              valueAdded: 0.8,
              reputationRisk: 0.1,
              redundancy: 0.1,
              attentionCost: 0.2,
              overall: 0.8,
              note: 'meilleur',
            },
          ],
        },
        selected: CHAIN_VARIANTS[1],
        voiceDistances: [0.3, 0.2],
        angleDiversity: 1,
        trail: [],
        totalCostEur: 0.0142,
        promptVersionHash: 'chain0123456789ab',
        sharedContext: 'le post parle de mecanique de liquidite',
      },
    }
  })

  vi.doMock('@/swarm/agents/quick-reply', () => ({ runQuickReply }))
  vi.doMock('@/swarm/chain/draft-chain', async () => {
    const actual = await vi.importActual<typeof import('@/swarm/chain/draft-chain')>(
      '@/swarm/chain/draft-chain',
    )
    return { ...actual, runDraftChain }
  })
  vi.doMock('@/background/services', () => ({
    restoreKeystore: async () => ({
      restore: async () => true,
      isInitialized: async () => options.keystoreInitialized !== false,
      isUnlocked: options.keystoreUnlocked !== false,
      credentials: () => ({ providerId: 'openrouter', apiKey: 'sk-or-v1-fake' }),
    }),
    buildLlmClient: async () => ({ call: vi.fn() }),
  }))

  const mod = await import('@/background/draft.handler')
  return { handle: mod.handleDraftRequest, runDraftChain, runQuickReply }
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(async () => {
  vi.doUnmock('@/db')
  vi.doUnmock('@/swarm/agents/quick-reply')
  vi.doUnmock('@/swarm/chain/draft-chain')
  vi.doUnmock('@/background/services')
  while (opened.length > 0) {
    const d = opened.pop()!
    d.close()
    await d.delete().catch(() => undefined)
  }
})

describe('ordre des garde-fous', () => {
  it('refuse avant tout si le consentement manque (MH-12)', async () => {
    const { handle, runDraftChain } = await setup({ consented: false })
    const res = await handle({ post })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('NO_CONSENT')
    // Rien n'a été dépensé : le consentement passe avant tout.
    expect(runDraftChain).not.toHaveBeenCalled()
  })

  it('refuse si aucune clé n est configurée', async () => {
    const { handle } = await setup({ keystoreInitialized: false })
    const res = await handle({ post })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('NO_KEY')
  })

  it('refuse si le coffre est verrouille', async () => {
    // Conséquence assumée de ne pas persister la passphrase : après la mort du service
    // worker, il faut redéverrouiller.
    const { handle } = await setup({ keystoreUnlocked: false })
    const res = await handle({ post })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('LOCKED')
  })

  it('ecarte un sujet interdit AVANT toute depense (MH-02)', async () => {
    // Le point central : cliquer n'autorise pas à répondre sur un sujet interdit.
    const { handle, runDraftChain } = await setup({})
    const res = await handle({
      post: { ...post, text: 'this is going 100x, guaranteed returns' },
    })
    expect(res.ok).toBe(true)
    if (res.ok && res.decision === 'decline') {
      expect(res.reasoning).toContain('garde-fou')
      expect(res.costEur).toBe(0)
    }
    expect(runDraftChain).not.toHaveBeenCalled()
  })

  it('ecarte un sujet sensible meme sur demande explicite', async () => {
    const { handle, runDraftChain } = await setup({})
    const res = await handle({
      post: { ...post, text: 'my father passed away last night' },
    })
    expect(res.ok).toBe(true)
    if (res.ok && res.decision === 'decline') expect(res.reasoning).toContain('garde-fou')
    expect(runDraftChain).not.toHaveBeenCalled()
  })
})

describe('chemin de production : chaine WRITER puis CRITIC', () => {
  it('renvoie toutes les variantes avec leurs notes', async () => {
    const { handle, runDraftChain } = await setup({})
    const res = await handle({ post })
    expect(res.ok).toBe(true)
    if (!res.ok || res.decision !== 'reply') throw new Error('attendu: reply')

    expect(res.mode).toBe('chain')
    expect(res.variants).toHaveLength(2)
    // Le CRITIC a retenu la seconde : l'index doit suivre, pas retomber sur 0.
    expect(res.selectedIndex).toBe(1)
    expect(res.variants[1]?.criticScores?.overall).toBe(0.8)
    expect(res.variants[0]?.voiceDistance).toBe(0.3)
    expect(res.promptVersionHash).toBe('chain0123456789ab')
    expect(runDraftChain).toHaveBeenCalledOnce()
  })

  it('expose les variantes NON retenues, pas seulement la gagnante', async () => {
    // L'utilisateur doit pouvoir contredire le CRITIC : c'est le taux d'abandon (MH-09),
    // et c'est un signal d'apprentissage gratuit.
    const { handle } = await setup({})
    const res = await handle({ post })
    if (!res.ok || res.decision !== 'reply') throw new Error('attendu: reply')
    expect(res.variants.map((v) => v.text)).toContain(
      'locked liquidity is table stakes now',
    )
  })

  it('un veto est un resultat, avec son cout reel (MH-05)', async () => {
    // Un veto a consommé deux appels. Ne pas les compter sous-estimerait la dépense.
    const { handle } = await setup({ outcome: 'decline' })
    const res = await handle({ post })
    expect(res.ok).toBe(true)
    if (res.ok && res.decision === 'decline') {
      expect(res.reasoning).toContain('seuil')
      expect(res.costEur).toBeCloseTo(0.013, 6)
    }
  })

  it('transmet une erreur d agent avec son etape et son code', async () => {
    const { handle } = await setup({ outcome: 'error' })
    const res = await handle({ post })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('writer')
      expect(res.code).toBe('rate-limit')
    }
  })

  it('transmet la consigne de l utilisateur a la chaine', async () => {
    const { handle, runDraftChain } = await setup({})
    await handle({ post, hint: 'sois plus sec' })
    expect(runDraftChain).toHaveBeenCalledWith(
      expect.objectContaining({ userHint: 'sois plus sec' }),
      expect.anything(),
    )
  })
})

describe('chemin de reference : one-shot de la Phase 1', () => {
  it('reste atteignable par reglage, et se distingue par l absence de CRITIC', async () => {
    const { handle, runQuickReply, runDraftChain } = await setup({
      draftMode: 'quick-reply',
    })
    const res = await handle({ post })
    expect(res.ok).toBe(true)
    if (!res.ok || res.decision !== 'reply') throw new Error('attendu: reply')

    expect(res.mode).toBe('quick-reply')
    expect(res.variants).toHaveLength(1)
    // Pas de CRITIC sur ce chemin : c'est exactement ce qui le distingue, et c'est ce qui
    // rend la comparaison possible.
    expect(res.variants[0]?.criticScores).toBeNull()
    expect(res.voiceConfidence).toBeNull()
    expect(runQuickReply).toHaveBeenCalledOnce()
    expect(runDraftChain).not.toHaveBeenCalled()
  })

  it('la distance de voix est inconnue, pas nulle', async () => {
    // Renvoyer 0 ferait croire que la réponse est parfaitement dans le style.
    const { handle } = await setup({ draftMode: 'quick-reply' })
    const res = await handle({ post })
    if (!res.ok || res.decision !== 'reply') throw new Error('attendu: reply')
    expect(res.variants[0]?.voiceDistance).toBe(0.5)
  })

  it('applique les memes garde-fous que la chaine', async () => {
    // Le chemin de référence n'est pas une porte de sortie des interdits produit.
    const { handle, runQuickReply } = await setup({ draftMode: 'quick-reply' })
    const res = await handle({ post: { ...post, text: 'to the moon, price target $4' } })
    expect(res.ok).toBe(true)
    if (res.ok && res.decision === 'decline') expect(res.reasoning).toContain('garde-fou')
    expect(runQuickReply).not.toHaveBeenCalled()
  })
})
