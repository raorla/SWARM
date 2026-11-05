/**
 * WRITER.
 *
 * Deux propriétés valent tous les autres tests de ce fichier :
 *
 *  1. **La frontière de cache est au bon endroit.** C'est elle qui fait passer le coût
 *     d'entrée de plein tarif à un dixième (SPEC §3.2). Un refactor qui déplacerait du
 *     contenu vers la partie variable triplerait le coût sans rien casser — d'où un test.
 *  2. **Le profil faible est annoncé au modèle.** Un modèle sans profil de voix qui ne le
 *     sait pas en invente un, et une voix inventée est pire qu'une absence de voix parce
 *     qu'elle est confiante.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  angleDiversity,
  buildNicheBlock,
  buildVoiceBlock,
  writerAgent,
} from '@/swarm/agents/writer'
import { buildVoiceProfile } from '@/memory/voice-profile'
import { bundledPack } from '@/niches/loader'
import { ZERO_USAGE } from '@/llm/types'
import type { LlmClient } from '@/llm/client'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import type { OwnPost, VoiceProfileRecord } from '@/db/schema'
import { FakeClock } from '@/shared/time'

const clock = new FakeClock('2026-08-25T12:00:00.000Z')
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

let seq = 0
function ownPost(text: string, passesGuard = true): OwnPost {
  seq += 1
  return {
    postId: `1789450000000${String(seq).padStart(6, '0')}`,
    text,
    lang: null,
    postedAtMs: clock.now() - seq * 3_600_000,
    collectedAtMs: clock.now(),
    likeCount: 8,
    replyCount: 1,
    repostCount: 0,
    hasMedia: false,
    isReply: false,
    passesGuard,
    guardCategories: [],
  }
}

function profileWith(posts: readonly OwnPost[]): VoiceProfileRecord {
  return buildVoiceProfile({ handle: 'ACMECTO', posts, pack, clock })
}

const STRONG_PROFILE = profileWith(
  Array.from({ length: 60 }, (_, i) =>
    ownPost(`locked liquidity note ${i} on the float signal`),
  ),
)
const WEAK_PROFILE = profileWith([ownPost('gm')])

function fakeClient(data: unknown): {
  client: LlmClient
  calls: Parameters<LlmClient['call']>[0][]
} {
  const calls: Parameters<LlmClient['call']>[0][] = []
  const client = {
    call: vi.fn((opts: Parameters<LlmClient['call']>[0]) => {
      calls.push(opts)
      return Promise.resolve({
        ok: true as const,
        value: {
          text: JSON.stringify(data),
          data,
          usage: { ...ZERO_USAGE, inputTokens: 2_000, outputTokens: 260 },
          costEur: 0.0074,
          model: 'anthropic/claude-sonnet-5',
          provider: 'openrouter' as const,
          repaired: false,
          latencyMs: 2_100,
        },
      })
    }),
  } as unknown as LlmClient
  return { client, calls }
}

const THREE_VARIANTS = {
  variants: [
    { text: 'locked liquidity is table stakes now', angle: 'counterpoint', intent: 'i0' },
    { text: 'le float est le vrai signal ici', angle: 'data', intent: 'i1' },
    { text: 'et le dev wallet, il dort ?', angle: 'question', intent: 'i2' },
  ],
  sharedContext: 'le post parle de mécanique de liquidité',
  declineReason: null,
}

describe('frontière de cache', () => {
  it('trois blocs cachables, un bloc variable', async () => {
    const { client, calls } = fakeClient(THREE_VARIANTS)
    await writerAgent.run({ post, pack, profile: STRONG_PROFILE }, { client })

    const messages = calls[0]?.messages ?? []
    expect(messages.filter((m) => m.cacheable === true)).toHaveLength(3)
    const variable = messages.filter((m) => m.cacheable !== true)
    expect(variable).toHaveLength(1)
    expect(variable[0]?.content).toContain('bonding curve')
  })

  it('le préfixe stable pèse l’essentiel de l’entrée', async () => {
    // Hypothèse du chiffrage à 1 €/jour (SPEC §3.2) : ~85 % de préfixe stable.
    const { client, calls } = fakeClient(THREE_VARIANTS)
    await writerAgent.run({ post, pack, profile: STRONG_PROFILE }, { client })

    const messages = calls[0]?.messages ?? []
    const cacheable = messages
      .filter((m) => m.cacheable === true)
      .reduce((n, m) => n + m.content.length, 0)
    const total = messages.reduce((n, m) => n + m.content.length, 0)
    expect(cacheable / total).toBeGreaterThan(0.85)
  })

  it('le préfixe est identique pour deux posts différents', async () => {
    // Condition nécessaire au cache : un octet de différence l'invalide entièrement.
    const prefixOf = async (p: ExtractedPost): Promise<string> => {
      const { client, calls } = fakeClient(THREE_VARIANTS)
      await writerAgent.run({ post: p, pack, profile: STRONG_PROFILE }, { client })
      return (calls[0]?.messages ?? [])
        .filter((m) => m.cacheable)
        .map((m) => m.content)
        .join('|')
    }
    const a = await prefixOf(post)
    const b = await prefixOf({
      ...post,
      postId: '1789999999999999999',
      text: 'autre chose',
    })
    expect(b).toBe(a)
  })

  it('la consigne utilisateur va dans la partie variable', async () => {
    // Dans le préfixe, elle invaliderait le cache à chaque changement de consigne.
    const { client, calls } = fakeClient(THREE_VARIANTS)
    await writerAgent.run(
      { post, pack, profile: STRONG_PROFILE, userHint: 'sois plus sec' },
      { client },
    )
    const variable = (calls[0]?.messages ?? []).find((m) => m.cacheable !== true)
    expect(variable?.content).toContain('sois plus sec')
  })
})

describe('bloc de voix', () => {
  it('annonce l’absence de profil au lieu de la taire', () => {
    // Un modèle sans profil qui ne le sait pas en invente un.
    const block = buildVoiceBlock(null)
    expect(block).toContain("N'invente pas de style")
    expect(block).toContain('registre neutre')
  })

  it('annonce un profil insuffisant', () => {
    const block = buildVoiceBlock(WEAK_PROFILE)
    expect(block).toContain('Profil insuffisant')
    expect(block).toContain('Ne compense pas en inventant')
  })

  it('n’annonce PAS d’insuffisance sur un profil solide', () => {
    expect(buildVoiceBlock(STRONG_PROFILE)).not.toContain('Profil insuffisant')
  })

  it('signale au modèle qu’une partie du corpus a été écartée (MH-18)', () => {
    // Il doit savoir que ce qu'il voit est la partie reproductible de la voix, et ne pas
    // essayer de deviner le reste.
    const mixed = profileWith([
      ...Array.from({ length: 5 }, (_, i) =>
        ownPost(`note ${i} sur le float et les holders`),
      ),
      ...Array.from({ length: 15 }, () =>
        ownPost('100x incoming maximum potential', false),
      ),
    ])
    const block = buildVoiceBlock(mixed)
    expect(block).toContain('écarté par les')
    expect(block).toContain("n'essaie pas de deviner")
  })

  it('transmet les statistiques de forme et les exemples', () => {
    const block = buildVoiceBlock(STRONG_PROFILE)
    expect(block).toContain('longueur')
    expect(block).toContain('Exemples réels')
    expect(block).toContain('locked liquidity note')
  })
})

describe('bloc de niche', () => {
  it('transmet le brief, les angles et les termes interdits', () => {
    const block = buildNicheBlock(pack)
    expect(block).toContain(pack.label)
    expect(block).toContain('Angles autorisés')
    expect(block).toContain('100x')
  })

  it('fonctionne sur n’importe quel pack — agnosticisme', () => {
    for (const id of ['memecoin', 'saas-b2b', 'generic']) {
      const p = bundledPack(id)!
      expect(buildNicheBlock(p), id).toContain(p.label)
    }
  })
})

describe('writerAgent', () => {
  it('renvoie les variantes et la trace', async () => {
    const { client } = fakeClient(THREE_VARIANTS)
    const result = await writerAgent.run(
      { post, pack, profile: STRONG_PROFILE },
      { client },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.output.variants).toHaveLength(3)
    expect(result.value.step.costEur).toBeCloseTo(0.0074, 6)
    expect(result.value.step.role).toBe('writer')
    expect(result.value.step.promptVersionHash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('un refus du WRITER est un refus, pas une panne', async () => {
    const { client } = fakeClient({
      variants: [],
      sharedContext: '',
      declineReason: 'rien à apporter que le fil ne contienne déjà',
    })
    const result = await writerAgent.run(
      { post, pack, profile: STRONG_PROFILE },
      { client },
    )
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'refused') {
      expect(result.error.reason).toContain('rien à apporter')
    }
  })

  it('écarte les variantes vides plutôt que de les propager', async () => {
    const { client } = fakeClient({
      variants: [
        { text: '   ', angle: 'data', intent: 'i0' },
        { text: 'une vraie variante ici', angle: 'question', intent: 'i1' },
      ],
      sharedContext: '',
      declineReason: null,
    })
    const result = await writerAgent.run(
      { post, pack, profile: STRONG_PROFILE },
      { client },
    )
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.output.variants).toHaveLength(1)
  })

  it('utilise le rôle writer, donc son routage et son budget', async () => {
    const { client, calls } = fakeClient(THREE_VARIANTS)
    await writerAgent.run({ post, pack, profile: null }, { client })
    expect(calls[0]?.role).toBe('writer')
  })

  it('propage le contexte d’escalade de modèle', async () => {
    // Le top EV passe sur le modèle fort : le contexte doit traverser l'agent.
    const { client, calls } = fakeClient(THREE_VARIANTS)
    await writerAgent.run(
      { post, pack, profile: null },
      { client, routeContext: { evRank: 3 } },
    )
    expect(calls[0]?.routeContext).toEqual({ evRank: 3 })
  })
})

describe('diversité des angles', () => {
  it('vaut 1 quand tous les angles diffèrent', () => {
    expect(
      angleDiversity([
        { text: 'a', angle: 'data', intent: '' },
        { text: 'b', angle: 'question', intent: '' },
        { text: 'c', angle: 'joke', intent: '' },
      ]),
    ).toBe(1)
  })

  it('chute quand le WRITER répète le même angle', () => {
    // Le mode de défaillance attendu : la même idée trois fois. On ne peut pas l'empêcher
    // par le schéma, mais on le mesure et on le remonte au CRITIC.
    expect(
      angleDiversity([
        { text: 'a', angle: 'data', intent: '' },
        { text: 'b', angle: 'data', intent: '' },
        { text: 'c', angle: 'data', intent: '' },
      ]),
    ).toBeCloseTo(1 / 3, 6)
  })

  it('gère une variante unique', () => {
    expect(angleDiversity([{ text: 'a', angle: 'data', intent: '' }])).toBe(1)
    expect(angleDiversity([])).toBe(0)
  })
})
