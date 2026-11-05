import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { LlmClient } from '@/llm/client'
import { BudgetMeter, memoryBudgetStore } from '@/llm/budget'
import { Keystore, memoryBackend } from '@/llm/keystore'
import { FALLBACK_TABLE } from '@/llm/pricing'
import { DEFAULT_ROUTING } from '@/llm/router'
import { LlmError } from '@/llm/errors'
import { ZERO_USAGE } from '@/llm/types'
import type { Provider } from '@/llm/types'
import { FakeClock } from '@/shared/time'
import { SeededRng } from '@/shared/rng'
import * as registry from '@/llm/providers'

const PASSPHRASE = 'passphrase de test'

async function unlockedKeystore(): Promise<Keystore> {
  const ks = new Keystore(memoryBackend())
  await ks.initialize(PASSPHRASE, {
    openrouter: { providerId: 'openrouter', apiKey: 'sk-or-v1-fake0000000000000000' },
  })
  return ks
}

/** Provider factice, contrôlé par le test. */
function fakeProvider(
  impl: (calls: number) => { text: string; usage: typeof ZERO_USAGE; model: string },
): { provider: Provider; calls: () => number } {
  let calls = 0
  const provider: Provider = {
    id: 'openrouter',
    label: 'fake',
    supportsPromptCache: true,
    originPattern: () => 'https://openrouter.ai/*',
    complete: async () => {
      calls += 1
      return impl(calls)
    },
  }
  return { provider, calls: () => calls }
}

function install(provider: Provider): void {
  vi.spyOn(registry, 'getProvider').mockReturnValue(provider)
}

async function buildClient(
  provider: Provider,
  budgetEur = 1,
): Promise<{ client: LlmClient; budget: BudgetMeter }> {
  install(provider)
  const clock = new FakeClock()
  const budget = new BudgetMeter(memoryBudgetStore(), clock, {
    dailyEur: budgetEur,
    reserveFraction: 0.25,
  })
  const client = new LlmClient({
    keystore: await unlockedKeystore(),
    budget,
    clock,
    rng: new SeededRng(1),
    routing: DEFAULT_ROUTING,
    prices: FALLBACK_TABLE,
    sleep: async () => undefined,
    hasHostPermission: async () => true,
  })
  return { client, budget }
}

const messages = [
  { role: 'system' as const, content: 'Tu es un test.', cacheable: true },
  { role: 'user' as const, content: 'Bonjour.' },
]

describe('LlmClient — appel simple', () => {
  it('renvoie le texte et debite le compteur avec l usage reel', async () => {
    const { provider } = fakeProvider(() => ({
      text: 'ok',
      usage: { ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 100 },
      model: 'claude-haiku-4-5',
    }))
    const { client, budget } = await buildClient(provider)

    const r = await client.call({ role: 'selftest', messages })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.text).toBe('ok')
    expect(r.value.costEur).toBeGreaterThan(0)

    const snap = await budget.snapshot()
    // Le compteur reflete l'usage rapporte, pas une estimation de longueur.
    expect(snap.spentEur).toBeCloseTo(r.value.costEur, 10)
  })

  it('refuse l appel quand le budget est insuffisant, AVANT de sortir', async () => {
    const { provider, calls } = fakeProvider(() => ({
      text: 'ne doit pas etre atteint',
      usage: ZERO_USAGE,
      model: 'x',
    }))
    const { client } = await buildClient(provider, 0.0000001)

    const r = await client.call({ role: 'writer', messages })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('budget-exhausted')
    // Le point qui compte : aucun appel reseau n'a eu lieu.
    expect(calls()).toBe(0)
  })

  it('echoue si le coffre est verrouille', async () => {
    const { provider } = fakeProvider(() => ({
      text: 'x',
      usage: ZERO_USAGE,
      model: 'x',
    }))
    install(provider)
    const client = new LlmClient({
      keystore: new Keystore(memoryBackend()),
      budget: new BudgetMeter(memoryBudgetStore(), new FakeClock()),
      clock: new FakeClock(),
      hasHostPermission: async () => true,
    })
    const r = await client.call({ role: 'selftest', messages })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('auth')
  })

  it('echoue si la permission d hote n est pas accordee', async () => {
    const { provider, calls } = fakeProvider(() => ({
      text: 'x',
      usage: ZERO_USAGE,
      model: 'x',
    }))
    install(provider)
    const client = new LlmClient({
      keystore: await unlockedKeystore(),
      budget: new BudgetMeter(memoryBudgetStore(), new FakeClock()),
      clock: new FakeClock(),
      hasHostPermission: async () => false,
    })
    const r = await client.call({ role: 'selftest', messages })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('no-permission')
    expect(calls()).toBe(0)
  })
})

describe('LlmClient — retry (MH-16)', () => {
  it('reessaie sur 429 puis reussit', async () => {
    const { provider, calls } = fakeProvider((n) => {
      if (n === 1) throw new LlmError('rate-limit', '429', { retryAfterMs: 10 })
      return {
        text: 'ok',
        usage: { ...ZERO_USAGE, outputTokens: 5 },
        model: 'claude-haiku-4-5',
      }
    })
    const { client } = await buildClient(provider)
    const r = await client.call({ role: 'selftest', messages })
    expect(r.ok).toBe(true)
    expect(calls()).toBe(2)
  })

  it('ne reessaie PAS sur 400 : insister brulerait du budget pour rien', async () => {
    const { provider, calls } = fakeProvider(() => {
      throw new LlmError('bad-request', 'parametre invalide')
    })
    const { client } = await buildClient(provider)
    const r = await client.call({ role: 'selftest', messages })
    expect(r.ok).toBe(false)
    expect(calls()).toBe(1)
  })

  it('abandonne apres le nombre maximal de tentatives', async () => {
    const { provider, calls } = fakeProvider(() => {
      throw new LlmError('server', '503')
    })
    const { client } = await buildClient(provider)
    const r = await client.call({ role: 'selftest', messages })
    expect(r.ok).toBe(false)
    expect(calls()).toBe(3)
  })
})

describe('LlmClient — validation et reparation', () => {
  const Schema = z.object({ verdict: z.enum(['pass', 'fail']), score: z.number() })

  it('valide et expose data', async () => {
    const { provider } = fakeProvider(() => ({
      text: JSON.stringify({ verdict: 'pass', score: 0.7 }),
      usage: { ...ZERO_USAGE, outputTokens: 20 },
      model: 'claude-sonnet-5',
    }))
    const { client } = await buildClient(provider)
    const r = await client.call({ role: 'critic', messages, schema: Schema })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.data?.verdict).toBe('pass')
      expect(r.value.repaired).toBe(false)
    }
  })

  it('repare localement sans second appel quand c est possible', async () => {
    // Le point de cout : une reparation locale est gratuite. On ne doit pas rappeler
    // le modele pour un bloc markdown.
    const { provider, calls } = fakeProvider(() => ({
      text: '```json\n{"verdict":"fail","score":0.2}\n```',
      usage: { ...ZERO_USAGE, outputTokens: 20 },
      model: 'claude-sonnet-5',
    }))
    const { client } = await buildClient(provider)
    const r = await client.call({ role: 'critic', messages, schema: Schema })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.repaired).toBe(true)
    expect(calls()).toBe(1)
  })

  it('fait un second appel quand le JSON est hors schema, une seule fois', async () => {
    const { provider, calls } = fakeProvider((n) => ({
      text: n === 1 ? '{"verdict":"peut-etre"}' : '{"verdict":"pass","score":0.9}',
      usage: { ...ZERO_USAGE, outputTokens: 20 },
      model: 'claude-sonnet-5',
    }))
    const { client, budget } = await buildClient(provider)
    const r = await client.call({ role: 'critic', messages, schema: Schema })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.data?.score).toBe(0.9)
      expect(r.value.repaired).toBe(true)
      // Les deux appels sont factures : le compteur ne doit rien oublier.
      const snap = await budget.snapshot()
      expect(snap.spentEur).toBeCloseTo(r.value.costEur, 10)
    }
    expect(calls()).toBe(2)
  })

  it('n insiste pas au dela du second appel', async () => {
    // Si le modele echoue deux fois sur le meme schema, le probleme est le prompt ou le
    // schema, pas le hasard.
    const { provider, calls } = fakeProvider(() => ({
      text: 'je ne peux pas produire ce format',
      usage: { ...ZERO_USAGE, outputTokens: 10 },
      model: 'claude-sonnet-5',
    }))
    const { client } = await buildClient(provider)
    const r = await client.call({ role: 'critic', messages, schema: Schema })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid-json')
    expect(calls()).toBe(2)
  })
})

describe('LlmClient — routage', () => {
  it('escalade WRITER sur le haut du classement EV, pas ailleurs', async () => {
    const seen: string[] = []
    const provider: Provider = {
      id: 'openrouter',
      label: 'fake',
      supportsPromptCache: true,
      originPattern: () => 'https://openrouter.ai/*',
      complete: async (req) => {
        seen.push(req.model)
        return { text: 'ok', usage: { ...ZERO_USAGE, outputTokens: 5 }, model: req.model }
      },
    }
    const { client } = await buildClient(provider)

    await client.call({ role: 'writer', messages, routeContext: { evRank: 3 } })
    await client.call({ role: 'writer', messages, routeContext: { evRank: 42 } })

    expect(seen[0]).toBe(DEFAULT_ROUTING.writerEscalated.model)
    expect(seen[1]).toBe(DEFAULT_ROUTING.writer.model)
  })

  it('utilise le modele de triage pour le QUALIFIER', async () => {
    let used = ''
    const provider: Provider = {
      id: 'openrouter',
      label: 'fake',
      supportsPromptCache: true,
      originPattern: () => 'https://openrouter.ai/*',
      complete: async (req) => {
        used = req.model
        return { text: 'ok', usage: { ...ZERO_USAGE, outputTokens: 5 }, model: req.model }
      },
    }
    const { client } = await buildClient(provider)
    await client.call({ role: 'qualifier', messages })
    expect(used).toBe(DEFAULT_ROUTING.qualifier.model)
  })
})
