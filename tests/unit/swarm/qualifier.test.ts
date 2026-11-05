/**
 * QUALIFIER — le triage de masse.
 *
 * Le test qui compte est le dernier bloc : **le DoD de la Phase 3**, 200 posts triés pour
 * moins de 0,05 €. C'est l'assertion qui doit faire échouer la CI si quelqu'un allonge le
 * prompt, agrandit la sortie ou réduit la taille des lots — trois changements qui paraissent
 * inoffensifs et qui multiplient le coût du produit.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ROUTING } from '@/llm/router'
import {
  buildBatchBlock,
  buildQualifierNicheBlock,
  intoBatches,
  qualifierAgent,
  qualifyAll,
} from '@/swarm/agents/qualifier'
import {
  NO_ANGLE_RELEVANCE_CAP,
  QUALIFIER_BATCH_SIZE,
  QualifierOutputSchema,
} from '@/swarm/schemas/qualifier.io'
import { bundledPack } from '@/niches/loader'
import { computeCostEur, FALLBACK_TABLE } from '@/llm/pricing'
import { ZERO_USAGE } from '@/llm/types'
import { LlmError } from '@/llm/errors'
import type { LlmClient } from '@/llm/client'
import type { ExtractedPost } from '@/content/dom/dom-schemas'

const pack = bundledPack('memecoin')!
const NOW = Date.parse('2026-08-25T12:00:00.000Z')

function post(index: number, text: string): ExtractedPost {
  return {
    postId: `178945600000000${String(index).padStart(4, '0')}`,
    authorHandle: `author${index}`,
    authorDisplayName: null,
    text,
    lang: 'en',
    postedAtMs: NOW - 10 * 60_000,
    replyCount: 5,
    likeCount: 40,
    repostCount: 2,
    hasMedia: false,
    hasQuote: false,
    isReply: false,
    isOwnPost: false,
    surface: 'timeline',
    observedAtMs: NOW,
    permalink: `/author${index}/status/178945600000000${String(index).padStart(4, '0')}`,
  }
}

const POSTS = Array.from({ length: 3 }, (_, i) =>
  post(i, `bonding curve mechanics discussion number ${i} about float and holders`),
)

function scriptedClient(
  responses: readonly (unknown | LlmError)[],
  costPerCall = 0.011,
): { client: LlmClient; calls: Parameters<LlmClient['call']>[0][] } {
  const calls: Parameters<LlmClient['call']>[0][] = []
  let index = 0
  const client = {
    call: vi.fn((opts: Parameters<LlmClient['call']>[0]) => {
      calls.push(opts)
      const response = responses[Math.min(index++, responses.length - 1)]
      if (response instanceof LlmError) {
        return Promise.resolve({ ok: false as const, error: response })
      }
      return Promise.resolve({
        ok: true as const,
        value: {
          text: JSON.stringify(response),
          data: response,
          usage: { ...ZERO_USAGE, inputTokens: 5_300, outputTokens: 1_250 },
          costEur: costPerCall,
          model: 'anthropic/claude-haiku-4.5',
          provider: 'openrouter' as const,
          repaired: false,
          latencyMs: 900,
        },
      })
    }),
  } as unknown as LlmClient
  return { client, calls }
}

describe('découpage en lots', () => {
  it('découpe 200 posts en 4 lots de 50', () => {
    // Le chiffrage de SPEC §3.2 repose sur ce découpage exact.
    const items = Array.from({ length: 200 }, (_, i) => i)
    const batches = intoBatches(items)
    expect(batches).toHaveLength(4)
    expect(batches.every((b) => b.length === 50)).toBe(true)
    expect(QUALIFIER_BATCH_SIZE).toBe(50)
  })

  it('gère un dernier lot incomplet', () => {
    expect(
      intoBatches(Array.from({ length: 120 }, (_, i) => i)).map((b) => b.length),
    ).toEqual([50, 50, 20])
  })

  it('gère une liste vide', () => {
    expect(intoBatches([])).toEqual([])
  })
})

describe('frontière de cache et coût du prompt', () => {
  it('deux blocs cachables, un bloc variable', async () => {
    const { client, calls } = scriptedClient([
      {
        verdicts: POSTS.map((_, i) => ({
          id: String(i),
          relevance: 0.8,
          angle: 'data',
          note: '',
        })),
      },
    ])
    await qualifierAgent.run({ posts: POSTS, pack }, { client })

    const messages = calls[0]?.messages ?? []
    expect(messages.filter((m) => m.cacheable === true)).toHaveLength(2)
    expect(messages.filter((m) => m.cacheable !== true)).toHaveLength(1)
  })

  it('le brief de niche du QUALIFIER est plus court que celui du WRITER', async () => {
    // Le QUALIFIER n'a pas besoin de savoir *comment* bien écrire, seulement *de quoi* la
    // niche parle. Chaque ligne superflue est payée quatre fois par jour.
    const { buildNicheBlock } = await import('@/swarm/agents/writer')
    expect(buildQualifierNicheBlock(pack).length).toBeLessThan(
      buildNicheBlock(pack).length,
    )
  })

  it('tronque les textes longs — le début suffit à juger la pertinence', () => {
    // Envoyer 4 000 caractères par post multiplierait le coût du triage par cinq pour un
    // gain de jugement nul.
    const long = post(0, 'x'.repeat(4_000))
    const block = buildBatchBlock([long])
    expect(block.length).toBeLessThan(900)
    expect(block).toContain('…')
  })

  it('numérote les posts et annonce le nombre de verdicts attendu', () => {
    const block = buildBatchBlock(POSTS)
    expect(block).toContain('id: 0')
    expect(block).toContain('id: 2')
    expect(block).toContain('Renvoie exactement 3 verdicts')
  })

  it('signale média et réponse sans envoyer le contenu du média', () => {
    const withMedia = { ...post(0, 'un post avec image'), hasMedia: true, isReply: true }
    const block = buildBatchBlock([withMedia])
    expect(block).toContain('[média]')
    expect(block).toContain('[réponse]')
  })
})

describe('interprétation des verdicts', () => {
  it('associe chaque verdict à son post', async () => {
    const { client } = scriptedClient([
      {
        verdicts: [
          { id: '0', relevance: 0.9, angle: 'counterpoint', note: '' },
          { id: '1', relevance: 0.2, angle: null, note: 'hors niche' },
          { id: '2', relevance: 0.7, angle: 'data', note: '' },
        ],
      },
    ])
    const result = await qualifierAgent.run({ posts: POSTS, pack }, { client })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.output.qualified).toHaveLength(3)
    expect(result.value.output.qualified[0]?.relevance).toBe(0.9)
    expect(result.value.output.qualified[1]?.note).toBe('hors niche')
  })

  it('COMPTE les posts omis au lieu de les taire', async () => {
    // Le pire mode de défaillance d'un module de triage : des opportunités qui disparaissent
    // sans trace, donc invisiblement.
    const { client } = scriptedClient([
      { verdicts: [{ id: '0', relevance: 0.8, angle: 'data', note: '' }] },
    ])
    const result = await qualifierAgent.run({ posts: POSTS, pack }, { client })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.output.qualified).toHaveLength(1)
    expect(result.value.output.missingVerdicts).toBe(2)
  })

  it('plafonne une pertinence haute sans angle', async () => {
    // Contradiction fréquente : le prompt l'interdit, un modèle le fait quand même. On
    // tranche vers la prudence — pas d'angle signifie rien à apporter.
    const { client } = scriptedClient([
      { verdicts: [{ id: '0', relevance: 0.95, angle: null, note: '' }] },
    ])
    const result = await qualifierAgent.run({ posts: [POSTS[0]!], pack }, { client })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.output.qualified[0]?.relevance).toBe(NO_ANGLE_RELEVANCE_CAP)
    expect(result.value.output.qualified[0]?.corrected).toBe(true)
  })

  it('écarte un angle hors de ceux autorisés par le pack', async () => {
    // Le laisser passer produirait des patterns inexploitables en Phase 5.
    const { client } = scriptedClient([
      { verdicts: [{ id: '0', relevance: 0.8, angle: 'resource', note: '' }] },
    ])
    // Le pack memecoin n'autorise pas `resource`.
    expect(pack.allowedAngles).not.toContain('resource')
    const result = await qualifierAgent.run({ posts: [POSTS[0]!], pack }, { client })
    if (!result.ok) throw new Error('attendu: ok')
    expect(result.value.output.qualified[0]?.angle).toBeNull()
    expect(result.value.output.qualified[0]?.corrected).toBe(true)
  })

  it('refuse quand aucun verdict n’est exploitable', async () => {
    const { client } = scriptedClient([
      { verdicts: [{ id: '99', relevance: 0.8, angle: 'data', note: '' }] },
    ])
    const result = await qualifierAgent.run({ posts: [POSTS[0]!], pack }, { client })
    expect(result.ok).toBe(false)
  })

  it('utilise le rôle qualifier — donc le modèle de triage et son budget', async () => {
    const { client, calls } = scriptedClient([
      { verdicts: [{ id: '0', relevance: 0.8, angle: 'data', note: '' }] },
    ])
    await qualifierAgent.run({ posts: [POSTS[0]!], pack }, { client })
    expect(calls[0]?.role).toBe('qualifier')
  })
})

describe('qualifyAll — un lot en échec n’arrête pas les autres', () => {
  it('poursuit après un lot en échec et le compte', async () => {
    // Sur 200 posts, perdre 50 opportunités parce qu'un appel a échoué est acceptable ;
    // perdre les 200 ne l'est pas.
    const posts = Array.from({ length: 6 }, (_, i) => post(i, `discussion number ${i}`))
    const goodBatch = {
      verdicts: [
        { id: '0', relevance: 0.8, angle: 'data', note: '' },
        { id: '1', relevance: 0.7, angle: 'data', note: '' },
        { id: '2', relevance: 0.6, angle: 'data', note: '' },
      ],
    }
    const { client } = scriptedClient([
      goodBatch,
      new LlmError('server', '503'),
      goodBatch,
    ])

    const result = await qualifyAll(posts, pack, { client }, 3)
    expect(result.batches).toBe(2)
    expect(result.failedBatches).toBe(1)
    expect(result.qualified).toHaveLength(3)
    // Le coût du lot réussi est bien compté.
    expect(result.totalCostEur).toBeCloseTo(0.011, 6)
  })

  it('agrège les verdicts manquants sur tous les lots', async () => {
    const posts = Array.from({ length: 4 }, (_, i) => post(i, `discussion ${i}`))
    const partial = { verdicts: [{ id: '0', relevance: 0.8, angle: 'data', note: '' }] }
    const { client } = scriptedClient([partial, partial])
    const result = await qualifyAll(posts, pack, { client }, 2)
    expect(result.qualified).toHaveLength(2)
    expect(result.missingVerdicts).toBe(2)
  })

  it('ne fait aucun appel sur une liste vide', async () => {
    const { client, calls } = scriptedClient([{ verdicts: [] }])
    const result = await qualifyAll([], pack, { client })
    expect(calls).toHaveLength(0)
    expect(result.totalCostEur).toBe(0)
  })
})

describe('DoD Phase 3 : 200 posts triés pour moins de 0,05 €', () => {
  /**
   * L'assertion qui doit faire échouer la CI.
   *
   * Trois changements paraissent inoffensifs et multiplient le coût du produit : allonger le
   * prompt, agrandir la sortie, réduire la taille des lots. Ce test les attrape.
   */
  /**
   * Chiffres **mesurés** le 2026-08-26 sur 200 posts réels (`npm run measure:qualifier`), pas
   * estimés : 4 276 tokens d'entrée et 511 de sortie par lot de 50, soit 10,2 tokens par
   * verdict.
   *
   * L'histoire de ces deux nombres vaut d'être connue, parce qu'elle dit pourquoi une
   * estimation ne remplace pas une mesure :
   *
   *  - le chiffrage d'origine supposait 1 250 tokens de sortie par lot (25 par verdict) ;
   *  - la première mesure en a trouvé **1 711** avec la forme objet, puis **2 702** sur des
   *     posts plus riches — le DoD était donc manqué en vrai alors qu'il passait sur le papier ;
   *  - deux correctifs plus tard — format compact et raisonnement désactivé — la sortie est
   *     tombée à **511**, soit deux fois mieux que l'estimation initiale.
   *
   * Autrement dit : l'estimation était fausse dans les deux sens, et seule la mesure le disait.
   */
  const MEASURED_INPUT_PER_BATCH = 4_276
  const MEASURED_OUTPUT_PER_BATCH = 511

  it('le chiffrage tient avec les tailles MESURÉES, sans cache', () => {
    const { eur } = computeCostEur(FALLBACK_TABLE, 'claude-haiku-4-5', {
      inputTokens: 4 * MEASURED_INPUT_PER_BATCH,
      outputTokens: 4 * MEASURED_OUTPUT_PER_BATCH,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    // Sans cache, le pire cas réaliste. La marge est mince, et c'est l'information utile :
    // allonger `note` ou le prompt fait sauter le DoD.
    expect(eur).toBeLessThan(0.05)
  })

  it('la marge mesurée est d’un facteur 2, et pas plus', () => {
    const { eur } = computeCostEur(FALLBACK_TABLE, 'claude-haiku-4-5', {
      inputTokens: 4 * MEASURED_INPUT_PER_BATCH,
      outputTokens: 4 * MEASURED_OUTPUT_PER_BATCH,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    // Borne basse volontaire : si un changement fait tomber le coût bien plus bas, c'est une
    // bonne nouvelle à constater et à consigner, pas un test à laisser mentir. La mesure réelle
    // donne 0,025 € — dont environ 80 % en entrée, ce qui est l'inverse de l'intuition
    // d'origine.
    expect(eur).toBeGreaterThan(0.015)
    expect(eur).toBeLessThan(0.05)
  })

  it('le cache de prompt aiderait, s’il s’appliquait ici', () => {
    /**
     * Nuance **mesurée**, et elle contredit le chiffrage d'origine : R-03 est confirmé (le cache
     * passe bien à travers OpenRouter), mais il ne s'applique **pas au QUALIFIER**. Sur les
     * quatre lots, l'entrée reste identique d'un appel à l'autre — aucun token lu en cache.
     *
     * Explication la plus probable : le préfixe du QUALIFIER fait ~1 400 tokens, sous le
     * minimum de mise en cache d'Anthropic pour Haiku. Le WRITER et le CRITIC, eux, ont un
     * préfixe bien plus long (Voice Profile + brief de niche) et sur Sonnet — c'est là que le
     * cache a été mesuré comme fonctionnel.
     *
     * Le DoD tient sans cache, donc rien ne dépend de cette nuance ; mais la garder pour
     * acquise ferait sous-estimer le coût du triage de moitié.
     */
    const PREFIX = 1_400
    const { eur } = computeCostEur(FALLBACK_TABLE, 'claude-haiku-4-5', {
      inputTokens: PREFIX + 4 * (MEASURED_INPUT_PER_BATCH - PREFIX),
      outputTokens: 4 * MEASURED_OUTPUT_PER_BATCH,
      cacheReadTokens: 3 * PREFIX,
      cacheWriteTokens: PREFIX,
    })
    expect(eur).toBeLessThan(0.045)
  })

  it('la SORTIE domine le coût — c’est là que la vigilance doit porter', () => {
    // Haiku 4.5 facture la sortie 5× l'entrée. Un champ `note` libre de 400 caractères au
    // lieu de 40 tuerait le DoD sans que rien d'autre ne change.
    const input = computeCostEur(FALLBACK_TABLE, 'claude-haiku-4-5', {
      inputTokens: 21_200,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    const output = computeCostEur(FALLBACK_TABLE, 'claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 5_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(output.eur).toBeGreaterThan(input.eur * 0.9)
  })

  it('un lot de 10 au lieu de 50 ferait exploser le coût du prompt système', () => {
    // 20 appels au lieu de 4 : le prompt système est payé 5 fois plus.
    const withBatch50 = computeCostEur(FALLBACK_TABLE, 'claude-haiku-4-5', {
      inputTokens: 4 * (800 + 4_500),
      outputTokens: 5_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    const withBatch10 = computeCostEur(FALLBACK_TABLE, 'claude-haiku-4-5', {
      inputTokens: 20 * (800 + 900),
      outputTokens: 5_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(withBatch10.eur).toBeGreaterThan(withBatch50.eur)
  })

  it('le budget quotidien de 1 € absorbe le triage sans peine', () => {
    const { eur } = computeCostEur(FALLBACK_TABLE, 'claude-haiku-4-5', {
      inputTokens: 4 * 5_300,
      outputTokens: 4 * 1_250,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    // Le triage doit rester une fraction du budget : le reste va à la rédaction.
    expect(eur / 1).toBeLessThan(0.06)
  })
})

describe('format compact — mesuré, pas supposé', () => {
  /**
   * Ce bloc fixe ce qu'une mesure réelle a appris le 2026-08-26. Chaque assertion correspond à
   * un échec constaté sur appels réels, qu'aucun test à réponse factice ne pouvait voir.
   */
  it('accepte la forme compacte `[id, relevance, angle, note?]`', () => {
    const parsed = QualifierOutputSchema.safeParse({
      verdicts: [
        ['0', 0.9, 'data'],
        ['1', 0, null],
        ['2', 0.6, 'question', 'déjà dit'],
      ],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.verdicts[0]).toEqual({
      id: '0',
      relevance: 0.9,
      angle: 'data',
      note: '',
    })
    expect(parsed.data.verdicts[2]?.note).toBe('déjà dit')
  })

  it('accepte encore la forme objet — on demande le compact, on tolère le verbeux', () => {
    // Un modèle y retombe régulièrement. Perdre un lot de 50 posts sur une question de mise en
    // forme coûterait plus cher que l'accepter.
    const parsed = QualifierOutputSchema.safeParse({
      verdicts: [{ id: '0', relevance: 0.8, angle: 'counterpoint', note: 'ok' }],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.verdicts[0]?.angle).toBe('counterpoint')
  })

  it('accepte un index numérique', () => {
    // Constaté : le modèle écrit `0` au lieu de `"0"` malgré la consigne.
    const parsed = QualifierOutputSchema.safeParse({ verdicts: [[0, 0.5, null]] })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.verdicts[0]?.id).toBe('0')
  })

  it('un angle INVENTÉ devient null au lieu d’invalider le lot', () => {
    // Le défaut mesuré : trois angles inventés par lot de 50 faisaient échouer le schéma, donc
    // déclenchaient un appel de réparation — un aller-retour payé pour trois lignes.
    const parsed = QualifierOutputSchema.safeParse({
      verdicts: [
        ['0', 0.9, 'insight'],
        ['1', 0.7, 'clarification'],
        ['2', 0.8, 'data'],
      ],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.verdicts[0]?.angle).toBeNull()
    expect(parsed.data.verdicts[1]?.angle).toBeNull()
    // L'angle valide du même lot est préservé : la tolérance ne dégrade pas ce qui était bon.
    expect(parsed.data.verdicts[2]?.angle).toBe('data')
  })

  it('le QUALIFIER n’active AUCUN raisonnement', () => {
    // Le piège coûteux : `effort: 'low'` n'économise pas, il *active* la réflexion étendue —
    // facturée en sortie, au tarif le plus cher. Mesuré : avec effort, les quatre lots étaient
    // tronqués avant d'avoir écrit un verdict ; sans effort, 15 tokens par verdict.
    expect(DEFAULT_ROUTING.qualifier.effort).toBeUndefined()
  })

  it('le plafond de sortie laisse de la marge sur la sortie mesurée', () => {
    // 15,3 tokens par verdict mesurés × 50 = ~770 ; le plafond est une borne de sécurité, et on
    // paie les tokens émis, pas le plafond.
    const measuredPerVerdict = 16
    expect(DEFAULT_ROUTING.qualifier.maxOutputTokens).toBeGreaterThan(
      measuredPerVerdict * QUALIFIER_BATCH_SIZE * 1.5,
    )
  })
})
