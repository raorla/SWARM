/**
 * CRITIC — le veto.
 *
 * Les deux propriétés protégées ici :
 *
 *  1. **Le seuil est appliqué en code**, pas seulement demandé au modèle. Un juge LLM dérive :
 *     il dit `pass` en donnant 0,4. Faire confiance au verdict déclaré rendrait le seuil
 *     décoratif.
 *  2. **Un veto est un `ok`**, pas une erreur. Le remonter en erreur ferait alarmer sur le
 *     fonctionnement normal du produit (SPEC §4.5) — le rejet est un résultat.
 */
import { describe, expect, it, vi } from 'vitest'
import { applyThreshold, calibrationStats, criticAgent } from '@/swarm/agents/critic'
import type { CriticResult } from '@/swarm/agents/critic'
import {
  DEFAULT_VETO_THRESHOLD,
  MAX_REPUTATION_RISK,
  type CriticScore,
} from '@/swarm/schemas/critic.io'
import { bundledPack } from '@/niches/loader'
import { ZERO_USAGE } from '@/llm/types'
import type { LlmClient } from '@/llm/client'
import type { WriterVariant } from '@/swarm/schemas/writer.io'

const pack = bundledPack('memecoin')!

const score = (
  index: number,
  overall: number,
  overrides: Partial<CriticScore> = {},
): CriticScore => ({
  index,
  voiceAuthenticity: 0.7,
  valueAdded: 0.7,
  reputationRisk: 0.1,
  redundancy: 0.1,
  attentionCost: 0.2,
  overall,
  note: 'note de test',
  ...overrides,
})

const variants: WriterVariant[] = [
  { text: 'locked liquidity is table stakes now', angle: 'counterpoint', intent: 'i0' },
  { text: 'le float est le vrai signal ici', angle: 'data', intent: 'i1' },
]

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
          usage: { ...ZERO_USAGE, inputTokens: 2_400, outputTokens: 180 },
          costEur: 0.0061,
          model: 'anthropic/claude-sonnet-5',
          provider: 'openrouter' as const,
          repaired: false,
          latencyMs: 1_900,
        },
      })
    }),
  } as unknown as LlmClient
  return { client, calls }
}

describe('applyThreshold — le seuil est la règle', () => {
  it('retient la meilleure variante au-dessus du seuil', () => {
    const result = applyThreshold(
      [score(0, 0.65), score(1, 0.82)],
      DEFAULT_VETO_THRESHOLD,
    )
    expect(result.verdict).toBe('pass')
    expect(result.bestIndex).toBe(1)
  })

  it('pose le veto quand tout est sous le seuil', () => {
    // Les notes sont relatives au seuil, pas absolues : le test les dérive du seuil courant.
    // Les coder en dur les rendait dépendantes de sa valeur, et il a changé quand la
    // calibration réelle a montré que 0,6 rejetait cinq bonnes réponses sur six.
    const below = DEFAULT_VETO_THRESHOLD - 0.05
    const result = applyThreshold(
      [score(0, DEFAULT_VETO_THRESHOLD - 0.2), score(1, below)],
      DEFAULT_VETO_THRESHOLD,
    )
    expect(result.verdict).toBe('veto')
    expect(result.bestIndex).toBeNull()
    // Le motif nomme la contrainte, pas « qualité insuffisante ».
    expect(result.reason).toContain(below.toFixed(2))
    expect(result.reason).toContain('seuil')
  })

  it('le défaut retenu est celui que la calibration a mesuré', () => {
    // Garde-fou contre un retour au 0,6 deviné : à ce seuil, la mesure du 2026-08-26 donne
    // 17 % de rappel — le CRITIC refuserait presque toutes les bonnes réponses, sans erreur
    // visible nulle part.
    expect(DEFAULT_VETO_THRESHOLD).toBeGreaterThanOrEqual(0.3)
    expect(DEFAULT_VETO_THRESHOLD).toBeLessThanOrEqual(0.55)
  })

  it('le risque réputationnel a son propre plafond, indépendant de la note globale', () => {
    // Une moyenne masquerait exactement le cas qu'on veut attraper : excellente partout,
    // risquée sur un point.
    const risky = score(0, 0.95, { reputationRisk: 0.8 })
    const result = applyThreshold([risky], DEFAULT_VETO_THRESHOLD)
    expect(result.verdict).toBe('veto')
    expect(result.reason).toContain('risque réputationnel')
  })

  it('accepte une variante juste sous le plafond de risque', () => {
    const borderline = score(0, 0.8, { reputationRisk: MAX_REPUTATION_RISK })
    expect(applyThreshold([borderline], DEFAULT_VETO_THRESHOLD).verdict).toBe('pass')
  })

  it('un seuil relevé rejette ce qu’un seuil bas accepterait', () => {
    const scores = [score(0, 0.7)]
    expect(applyThreshold(scores, 0.5).verdict).toBe('pass')
    expect(applyThreshold(scores, 0.9).verdict).toBe('veto')
  })

  it('gère une liste de notes vide', () => {
    const result = applyThreshold([], DEFAULT_VETO_THRESHOLD)
    expect(result.verdict).toBe('veto')
    expect(result.reason).toContain('aucune variante')
  })
})

describe('criticAgent', () => {
  it('retient la variante désignée et remonte la trace', async () => {
    const { client } = fakeClient({
      scores: [score(0, 0.62), score(1, 0.85)],
      verdict: 'pass',
      selectedIndex: 1,
      rejectionReason: null,
    })
    const result = await criticAgent.run(
      { postText: 'un post', variants, pack, profile: null },
      { client },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.output.verdict).toBe('pass')
    expect(result.value.output.selected?.angle).toBe('data')
    expect(result.value.step.costEur).toBeCloseTo(0.0061, 6)
    expect(result.value.step.promptVersionHash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('un veto remonte en ok, pas en erreur (SPEC §4.5)', async () => {
    const { client } = fakeClient({
      scores: [score(0, 0.3), score(1, 0.35)],
      verdict: 'veto',
      selectedIndex: null,
      rejectionReason: 'aucune ne dit rien de neuf',
    })
    const result = await criticAgent.run(
      { postText: 'un post', variants, pack, profile: null },
      { client },
    )
    // Le point crucial : `ok: true` avec `verdict: veto`. Un rejet est un résultat.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.output.verdict).toBe('veto')
    expect(result.value.output.rejectionReason).toContain('rien de neuf')
    expect(result.value.output.selected).toBeNull()
  })

  it('infirme un verdict incohérent du modèle et le trace', async () => {
    // Le cas réel : le modèle dit `pass` en donnant 0,4. Le code applique le seuil, et le
    // désaccord devient un signal de calibration au lieu d'être résolu en silence.
    const { client } = fakeClient({
      scores: [score(0, 0.4)],
      verdict: 'pass',
      selectedIndex: 0,
      rejectionReason: null,
    })
    const result = await criticAgent.run(
      { postText: 'un post', variants: [variants[0]!], pack, profile: null },
      { client },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.output.verdict).toBe('veto')
    expect(result.value.output.overrodeModel).toBe(true)
  })

  it('préfère le motif du modèle quand les deux sont d’accord', async () => {
    // Le motif du modèle est plus informatif que le nôtre : il parle du contenu.
    const { client } = fakeClient({
      scores: [score(0, 0.2)],
      verdict: 'veto',
      selectedIndex: null,
      rejectionReason: 'répète ton post du 12 sur la liquidité',
    })
    const result = await criticAgent.run(
      { postText: 'un post', variants: [variants[0]!], pack, profile: null },
      { client },
    )
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.output.rejectionReason).toContain('post du 12')
  })

  it('ignore les notes dont l’index ne désigne aucune variante', async () => {
    const { client } = fakeClient({
      scores: [score(0, 0.8), score(7, 0.9)],
      verdict: 'pass',
      selectedIndex: 0,
      rejectionReason: null,
    })
    const result = await criticAgent.run(
      { postText: 'un post', variants: [variants[0]!], pack, profile: null },
      { client },
    )
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.output.scores).toHaveLength(1)
    expect(result.value.output.selectedIndex).toBe(0)
  })

  it('refuse quand aucune note n’est exploitable', async () => {
    const { client } = fakeClient({
      scores: [score(9, 0.9)],
      verdict: 'pass',
      selectedIndex: 9,
      rejectionReason: null,
    })
    const result = await criticAgent.run(
      { postText: 'un post', variants: [variants[0]!], pack, profile: null },
      { client },
    )
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'refused') {
      expect(result.error.reason).toContain('exploitable')
    }
  })

  it('injecte les règles de niche et signale un angle dupliqué', async () => {
    const { client, calls } = fakeClient({
      scores: [score(0, 0.8), score(1, 0.7)],
      verdict: 'pass',
      selectedIndex: 0,
      rejectionReason: null,
    })
    const dupes: WriterVariant[] = [
      { text: 'a', angle: 'data', intent: 'i0' },
      { text: 'b', angle: 'data', intent: 'i1' },
    ]
    await criticAgent.run(
      { postText: 'un post', variants: dupes, pack, profile: null },
      { client },
    )

    const joined = (calls[0]?.messages ?? []).map((m) => m.content).join('\n')
    expect(joined).toContain(pack.promptFragments.criticExtraRules.slice(0, 30))
    // Le mode de défaillance du WRITER est de produire la même idée plusieurs fois : le
    // CRITIC doit être prévenu pour distinguer un vrai choix du remplissage.
    expect(joined).toContain('même angle')
  })

  it('marque le préfixe stable comme cachable', async () => {
    const { client, calls } = fakeClient({
      scores: [score(0, 0.8)],
      verdict: 'pass',
      selectedIndex: 0,
      rejectionReason: null,
    })
    await criticAgent.run(
      { postText: 'un post', variants: [variants[0]!], pack, profile: null },
      { client },
    )
    const messages = calls[0]?.messages ?? []
    expect(messages.filter((m) => m.cacheable === true)).toHaveLength(2)
    // Les variantes changent à chaque appel : les mettre en cache invaliderait le préfixe.
    expect(messages.filter((m) => m.cacheable !== true)).toHaveLength(1)
  })
})

describe('calibration', () => {
  const result = (
    verdict: 'pass' | 'veto',
    overall: number,
    overrode = false,
  ): CriticResult => ({
    verdict,
    scores: [score(0, overall)],
    selectedIndex: verdict === 'pass' ? 0 : null,
    selected: verdict === 'pass' ? variants[0]! : null,
    rejectionReason: verdict === 'veto' ? 'motif' : null,
    voiceDistances: [0.3],
    overrodeModel: overrode,
  })

  it('mesure le taux de rejet — un CRITIC à 95 % ou 5 % est inutile', () => {
    const stats = calibrationStats([
      result('pass', 0.8),
      result('veto', 0.3),
      result('veto', 0.4),
      result('pass', 0.7),
    ])
    expect(stats.rejectionRate).toBe(0.5)
    expect(stats.sample).toBe(4)
  })

  it('mesure le taux de désaccord code / modèle', () => {
    // Un taux élevé signifie que le prompt et le seuil ne disent pas la même chose : il
    // faut retoucher l'un des deux, pas ignorer le désaccord.
    const stats = calibrationStats([
      result('veto', 0.4, true),
      result('pass', 0.8, false),
    ])
    expect(stats.overrideRate).toBe(0.5)
  })

  it('gère un échantillon vide sans NaN', () => {
    const stats = calibrationStats([])
    expect(stats.rejectionRate).toBe(0)
    expect(stats.avgOverall).toBe(0)
    expect(stats.sample).toBe(0)
  })
})
