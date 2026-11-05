/**
 * Agent QUICK-REPLY.
 *
 * Deux propriétés comptent plus que les autres ici :
 *
 *  1. Le **découpage du cache** est au bon endroit. C'est lui qui fait passer le coût
 *     d'entrée de plein tarif à un dixième (SPEC §3.2), donc la différence entre tenir
 *     1 €/jour et le tripler. Un `cacheable` mal placé est une régression invisible.
 *  2. Un **refus** remonte comme un refus, pas comme un succès vide. Un `text: ''`
 *     traité comme une réponse produirait un brouillon blanc dans l'overlay.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildQuickReplyMessages, runQuickReply } from '@/swarm/agents/quick-reply'
import { bundledPack } from '@/niches/loader'
import { LlmError } from '@/llm/errors'
import { ZERO_USAGE } from '@/llm/types'
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

/** Client factice : renvoie ce que le test décide, et enregistre l'appel. */
function fakeClient(impl: () => Awaited<ReturnType<LlmClient['call']>>): {
  client: LlmClient
  calls: Parameters<LlmClient['call']>[0][]
} {
  const calls: Parameters<LlmClient['call']>[0][] = []
  const client = {
    call: vi.fn((opts: Parameters<LlmClient['call']>[0]) => {
      calls.push(opts)
      return Promise.resolve(impl())
    }),
  } as unknown as LlmClient
  return { client, calls }
}

const okResponse = (data: unknown) =>
  ({
    ok: true as const,
    value: {
      text: JSON.stringify(data),
      data,
      usage: { ...ZERO_USAGE, inputTokens: 1_800, outputTokens: 120 },
      costEur: 0.0072,
      model: 'anthropic/claude-sonnet-5',
      provider: 'openrouter' as const,
      repaired: false,
      latencyMs: 1_450,
    },
  }) as Awaited<ReturnType<LlmClient['call']>>

describe('buildQuickReplyMessages — frontière de cache', () => {
  it('marque le préfixe stable comme cachable et le post comme variable', async () => {
    const { messages } = await buildQuickReplyMessages({ post, pack })
    const cacheable = messages.filter((m) => m.cacheable === true)
    const variable = messages.filter((m) => m.cacheable !== true)

    // Le prompt système et le brief de niche sont identiques d'un appel à l'autre.
    expect(cacheable).toHaveLength(2)
    expect(cacheable.every((m) => m.role === 'system')).toBe(true)
    // Le post change à chaque appel : le mettre en cache invaliderait le préfixe.
    expect(variable).toHaveLength(1)
    expect(variable[0]?.role).toBe('user')
    expect(variable[0]?.content).toContain('bonding curve')
    expect(variable[0]?.content).toContain('@aliceonchain')
    // L'identifiant du post n'est pas transmis : il n'apporte rien au modèle et coûterait
    // des tokens sur chaque appel.
    expect(variable[0]?.content).not.toContain('1789456123456789012')
  })

  it('le préfixe stable pèse l’essentiel de l’entrée', async () => {
    // C'est l'hypothèse du chiffrage à 1 €/jour (SPEC §3.2) : ~85 % de préfixe stable.
    // Si un refactor déplaçait du contenu vers la partie variable, le coût triplerait
    // sans que rien ne casse — d'où ce test.
    const { messages } = await buildQuickReplyMessages({ post, pack })
    const cacheableChars = messages
      .filter((m) => m.cacheable === true)
      .reduce((n, m) => n + m.content.length, 0)
    const totalChars = messages.reduce((n, m) => n + m.content.length, 0)
    expect(cacheableChars / totalChars).toBeGreaterThan(0.8)
  })

  it('le préfixe est identique pour deux posts différents', async () => {
    // Condition nécessaire au cache : un octet de différence l'invalide entièrement.
    const a = await buildQuickReplyMessages({ post, pack })
    const b = await buildQuickReplyMessages({
      post: { ...post, postId: '1789999999999999999', text: 'un autre post' },
      pack,
    })
    const prefixOf = (m: typeof a.messages) =>
      m
        .filter((x) => x.cacheable)
        .map((x) => x.content)
        .join('|')
    expect(prefixOf(b.messages)).toBe(prefixOf(a.messages))
  })

  it('injecte le brief de niche, sans code spécifique à la niche', async () => {
    const { messages } = await buildQuickReplyMessages({ post, pack })
    const joined = messages.map((m) => m.content).join('\n')
    expect(joined).toContain(pack.label)
    expect(joined).toContain(pack.promptFragments.whatOutsidersGetWrong.slice(0, 30))
    // Les termes bannis du pack sont transmis au modèle : c'est la première ligne de
    // défense, avant le topic-guard.
    expect(joined).toContain('100x')
  })

  it('fonctionne sur n’importe quel pack — test d’agnosticisme', async () => {
    for (const id of ['memecoin', 'saas-b2b', 'generic']) {
      const p = bundledPack(id)!
      const { messages } = await buildQuickReplyMessages({ post, pack: p })
      expect(messages.length, id).toBe(3)
      expect(messages.map((m) => m.content).join('\n'), id).toContain(p.label)
    }
  })

  it('annonce l’absence de Voice Profile plutôt que de la taire', async () => {
    // Le modèle doit savoir qu'il travaille sans profil : sinon il en invente un.
    const { messages } = await buildQuickReplyMessages({ post, pack })
    expect(messages.map((m) => m.content).join('\n')).toContain('Phase 2')
  })

  it('inclut les exemples de voix quand ils existent', async () => {
    const { messages } = await buildQuickReplyMessages({
      post,
      pack,
      voiceExamples: ['un exemple de mon écriture', 'un autre exemple'],
    })
    const joined = messages.map((m) => m.content).join('\n')
    expect(joined).toContain('un exemple de mon écriture')
    expect(joined).not.toContain('Phase 2')
  })

  it('transmet la consigne de l’utilisateur dans la partie variable', async () => {
    // Une consigne dans le préfixe invaliderait le cache à chaque changement de consigne.
    const { messages } = await buildQuickReplyMessages({
      post,
      pack,
      userHint: 'sois plus sec',
    })
    const variable = messages.find((m) => m.cacheable !== true)
    expect(variable?.content).toContain('sois plus sec')
  })

  it('calcule l’âge du post en minutes', async () => {
    const { messages } = await buildQuickReplyMessages({ post, pack })
    expect(messages.map((m) => m.content).join('\n')).toContain('30 min')
  })

  it('signale une métrique inconnue au lieu d’écrire zéro', async () => {
    const { messages } = await buildQuickReplyMessages({
      post: { ...post, replyCount: null },
      pack,
    })
    expect(messages.map((m) => m.content).join('\n')).toContain('inconnu')
  })
})

describe('runQuickReply', () => {
  it('renvoie le brouillon rédigé', async () => {
    const { client } = fakeClient(() =>
      okResponse({
        decision: 'reply',
        text: 'locked liquidity is table stakes now, the float is the actual signal',
        angle: 'counterpoint',
        reasoning: 'contre-argument sur la mécanique, pas sur le prix',
        confidence: 0.62,
      }),
    )
    const result = await runQuickReply(client, { post, pack })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.text).toContain('locked liquidity')
    expect(result.value.angle).toBe('counterpoint')
    expect(result.value.costEur).toBeCloseTo(0.0072, 6)
    expect(result.value.promptVersionHash).toMatch(/^[0-9a-f]{16}$/)
    expect(result.value.overLimit).toBe(false)
  })

  it('remonte un refus comme un refus, pas comme un succès vide', async () => {
    // Un `text: ''` traité comme une réponse produirait un brouillon blanc dans l'overlay.
    const { client } = fakeClient(() =>
      okResponse({
        decision: 'decline',
        text: '',
        angle: 'question',
        reasoning: 'rien à ajouter que le fil ne contienne déjà',
        confidence: 0.1,
      }),
    )
    const result = await runQuickReply(client, { post, pack })
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'declined') {
      expect(result.error.reason).toContain('rien à ajouter')
    }
  })

  it('traite un texte vide comme un refus, même annoncé « reply »', async () => {
    // Défense contre un modèle incohérent : la décision utile est le contenu, pas
    // l'étiquette.
    const { client } = fakeClient(() =>
      okResponse({
        decision: 'reply',
        text: '   ',
        angle: 'question',
        reasoning: '',
        confidence: 0.5,
      }),
    )
    const result = await runQuickReply(client, { post, pack })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('declined')
  })

  it('signale un dépassement de longueur sans tronquer', async () => {
    // Couper au caractère 280 amputerait la phrase : c'est à l'utilisateur d'arbitrer.
    const long = 'x'.repeat(320)
    const { client } = fakeClient(() =>
      okResponse({
        decision: 'reply',
        text: long,
        angle: 'data',
        reasoning: 'r',
        confidence: 0.5,
      }),
    )
    const result = await runQuickReply(client, { post, pack })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.overLimit).toBe(true)
      expect(result.value.text).toHaveLength(320)
    }
  })

  it('remonte une erreur LLM telle quelle', async () => {
    const { client } = fakeClient(() => ({
      ok: false as const,
      error: new LlmError('budget-exhausted', 'plus de budget'),
    }))
    const result = await runQuickReply(client, { post, pack })
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'llm') {
      expect(result.error.error.kind).toBe('budget-exhausted')
    }
  })

  it('utilise le rôle writer, donc le routage et le budget du rédacteur', async () => {
    const { client, calls } = fakeClient(() =>
      okResponse({
        decision: 'reply',
        text: 'ok',
        angle: 'question',
        reasoning: 'r',
        confidence: 0.5,
      }),
    )
    await runQuickReply(client, { post, pack })
    expect(calls[0]?.role).toBe('writer')
    expect(calls[0]?.schema).toBeDefined()
  })

  it('propage l’indicateur de réparation, qui est une métrique de qualité', async () => {
    const base = okResponse({
      decision: 'reply',
      text: 'ok',
      angle: 'question',
      reasoning: 'r',
      confidence: 0.5,
    })
    const { client } = fakeClient(() =>
      base.ok ? { ...base, value: { ...base.value, repaired: true } } : base,
    )
    const result = await runQuickReply(client, { post, pack })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.repaired).toBe(true)
  })
})
