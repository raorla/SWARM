/**
 * ORCHESTRATEUR — les cinq invariants de sûreté de l'ADR 0001.
 *
 * Ce fichier ne teste pas « la machine fonctionne ». Il teste que les propriétés qui
 * protègent l'utilisateur sont **structurelles** et non conventionnelles :
 *
 *  1. `awaitingHuman` n'expire jamais — l'inaction ne vaut pas consentement.
 *  2. `queued` retombe sur la validation humaine, jamais sur l'action.
 *  3. `KILL` est traité pendant un appel en cours.
 *  4. Un veto est un résultat, pas une erreur.
 *  5. `confirming` distingue publié d'abandonné.
 *
 * Chacun de ces tests correspond à une façon dont le produit pourrait publier quelque chose
 * que l'utilisateur n'a pas voulu.
 */
import { describe, expect, it, vi } from 'vitest'
import { createActor, fromPromise } from 'xstate'
import {
  CONFIRM_TIMEOUT_MS,
  describeState,
  MAX_BACKOFF_MS,
  orchestrator,
  type DraftInput,
  type DraftOutput,
  type LearnOutput,
  type MeasureOutput,
  type OrchestratorContext,
  type PipelineOpportunity,
  type ScoutOutput,
  type StageInput,
  type StageOutput,
} from '@/swarm/orchestrator.machine'

const opportunity = (id: number, evRank = id): PipelineOpportunity => ({
  id,
  postId: `178945600000000${String(id).padStart(4, '0')}`,
  authorHandle: `author${id}`,
  text: `un post de test ${id}`,
  evScore: 0.8 - id * 0.05,
  evRank,
})

const DRAFT_OK: DraftOutput = {
  draft: { text: 'une réponse', angle: 'data', idempotencyKey: 'k-1' },
  vetoReason: null,
  costEur: 0.014,
}

const DRAFT_VETO: DraftOutput = {
  draft: null,
  vetoReason: 'aucune variante ne dépasse le seuil',
  costEur: 0.013,
}

interface Stubs {
  scout?: () => Promise<ScoutOutput>
  draft?: (input: DraftInput) => Promise<DraftOutput>
  stage?: (input: StageInput) => Promise<StageOutput>
  measure?: () => Promise<MeasureOutput>
  learn?: () => Promise<LearnOutput>
}

/** Machine instanciée avec des acteurs contrôlés par le test. */
function build(stubs: Stubs = {}, context?: Partial<OrchestratorContext>) {
  const machine = orchestrator.provide({
    actors: {
      scout: fromPromise<ScoutOutput, void>(
        async () => (await stubs.scout?.()) ?? { opportunities: [] },
      ),
      draft: fromPromise<DraftOutput, DraftInput>(
        async ({ input }) => (await stubs.draft?.(input)) ?? DRAFT_OK,
      ),
      stage: fromPromise<StageOutput, StageInput>(
        async ({ input }) => (await stubs.stage?.(input)) ?? { staged: true, reason: null },
      ),
      measure: fromPromise<MeasureOutput, void>(
        async () => (await stubs.measure?.()) ?? { measured: 0 },
      ),
      learn: fromPromise<LearnOutput, void>(
        async () => (await stubs.learn?.()) ?? { patternsUpdated: 0 },
      ),
    },
  })

  const actor = createActor(machine, context ? { input: undefined } : undefined)
  if (context) {
    // XState ne permet pas de surcharger le contexte initial d'une machine sans `input` :
    // on démarre puis on force le mode via un snapshot restauré, ce qui exerce au passage le
    // chemin de reprise après mort du service worker.
    actor.start()
    const snapshot = actor.getPersistedSnapshot() as unknown as {
      context: OrchestratorContext
      value: unknown
    }
    actor.stop()
    const restored = createActor(machine, {
      snapshot: { ...snapshot, context: { ...snapshot.context, ...context } } as never,
    })
    restored.start()
    return restored
  }

  actor.start()
  return actor
}

const stateOf = (actor: ReturnType<typeof build>): { pipeline: string; governance: string } => {
  const value = actor.getSnapshot().value as { pipeline: string; governance: string }
  return value
}

/** Laisse le microtask queue se vider — les acteurs `fromPromise` résolvent en asynchrone. */
const settle = async (turns = 6): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

describe('invariant 1 — awaitingHuman n’expire JAMAIS', () => {
  it('reste en attente indéfiniment sans APPROVE ni REJECT', async () => {
    // La propriété qui empêche le Copilote de dériver vers la publication automatique par
    // oubli de validation.
    vi.useFakeTimers()
    const actor = build({ scout: async () => ({ opportunities: [opportunity(1)] }) })
    actor.send({ type: 'TICK' })
    await settle()

    expect(stateOf(actor).pipeline).toBe('awaitingHuman')

    // Une semaine plus tard.
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000)
    expect(stateOf(actor).pipeline).toBe('awaitingHuman')

    actor.stop()
    vi.useRealTimers()
  })

  it('la définition de l’état ne contient aucune transition temporelle', () => {
    // Test structurel, plus fort que le précédent : un `after` ajouté par erreur ferait
    // échouer celui-ci même si le délai est long.
    const definition = orchestrator.config.states?.['pipeline'] as {
      states?: Record<string, { after?: unknown; on?: Record<string, unknown> }>
    }
    const awaitingHuman = definition.states?.['awaitingHuman']
    expect(awaitingHuman).toBeDefined()
    expect(awaitingHuman?.after).toBeUndefined()
    // Seuls APPROVE et REJECT en sortent.
    expect(Object.keys(awaitingHuman?.on ?? {}).sort()).toEqual(['APPROVE', 'REJECT'])
  })
})

describe('invariant 2 — queued retombe sur la validation humaine', () => {
  it('un brouillon prêt va en attente humaine, pas en staging', async () => {
    const actor = build({ scout: async () => ({ opportunities: [opportunity(1)] }) })
    actor.send({ type: 'TICK' })
    await settle()
    expect(stateOf(actor).pipeline).toBe('awaitingHuman')
    actor.stop()
  })

  it('le mode autopilote NON implémenté retombe sur la validation humaine', async () => {
    // Le pire scénario évité : une config qui dit « autopilote » ne doit pas produire une
    // publication automatique par un chemin non écrit (SPEC §4.6).
    const actor = build(
      { scout: async () => ({ opportunities: [opportunity(1)] }) },
      { mode: 'autopilot' },
    )
    actor.send({ type: 'TICK' })
    await settle()
    expect(stateOf(actor).pipeline).toBe('awaitingHuman')
    expect(actor.getSnapshot().context.lastDenial).toContain('autopilote')
    actor.stop()
  })

  it('le mode simulation n’atteint jamais staging', async () => {
    const actor = build(
      { scout: async () => ({ opportunities: [opportunity(1)] }) },
      { mode: 'simulation' },
    )
    actor.send({ type: 'TICK' })
    await settle(12)
    // Il repart en file puis en mesure : jamais `staging`.
    expect(stateOf(actor).pipeline).not.toBe('staging')
    expect(actor.getSnapshot().context.lastDenial).toContain('simulation')
    actor.stop()
  })

  it('APPROVE est le SEUL chemin vers staging', async () => {
    const staged: StageInput[] = []
    const actor = build({
      scout: async () => ({ opportunities: [opportunity(1)] }),
      stage: async (input) => {
        staged.push(input)
        return { staged: true, reason: null }
      },
    })
    actor.send({ type: 'TICK' })
    await settle()
    expect(staged).toHaveLength(0)

    actor.send({ type: 'APPROVE' })
    await settle()
    expect(staged).toHaveLength(1)
    expect(stateOf(actor).pipeline).toBe('confirming')
    actor.stop()
  })
})

describe('invariant 3 — KILL est traité pendant un appel en cours', () => {
  it('arrête le swarm même pendant un appel LLM non résolu', async () => {
    // Un kill switch qui ne fonctionne pas pendant un `await` est un kill switch qui ne
    // fonctionne pas au moment où on en a besoin.
    // Conteneur mutable plutôt qu'une variable : l'analyse de flux de TypeScript réduirait
    // une variable assignée depuis un callback à son type initial.
    const pending: { resolve: ((value: DraftOutput) => void) | null } = { resolve: null }
    const actor = build({
      scout: async () => ({ opportunities: [opportunity(1)] }),
      draft: () =>
        new Promise<DraftOutput>((resolve) => {
          pending.resolve = resolve
        }),
    })

    actor.send({ type: 'TICK' })
    await settle()
    expect(stateOf(actor).pipeline).toBe('drafting')

    actor.send({ type: 'KILL', reason: 'test' })
    expect(stateOf(actor).governance).toBe('halted')

    // L'appel se résout après coup : il ne doit pas relancer le pipeline vers une action.
    pending.resolve?.(DRAFT_OK)
    await settle()
    expect(stateOf(actor).governance).toBe('halted')
    actor.stop()
  })

  it('vide la file au kill switch', async () => {
    const actor = build({
      scout: async () => ({
        opportunities: [opportunity(1), opportunity(2), opportunity(3)],
      }),
    })
    actor.send({ type: 'TICK' })
    await settle()
    expect(actor.getSnapshot().context.queue.length).toBeGreaterThan(0)

    actor.send({ type: 'KILL', reason: 'test' })
    expect(actor.getSnapshot().context.queue).toHaveLength(0)
    expect(actor.getSnapshot().context.current).toBeNull()
    expect(actor.getSnapshot().context.staged).toBeNull()
    actor.stop()
  })

  it('halted est un état absorbant — seul RESUME en sort', async () => {
    const actor = build()
    actor.send({ type: 'KILL', reason: 'test' })

    // Aucun autre événement ne doit le relever.
    for (const event of [
      { type: 'TICK' } as const,
      { type: 'BUDGET_RESTORED' } as const,
      { type: 'SELECTORS_RECOVERED' } as const,
      { type: 'PUBLISH_CONFIRMED', xPostId: null } as const,
    ]) {
      actor.send(event)
      expect(stateOf(actor).governance, event.type).toBe('halted')
    }

    actor.send({ type: 'RESUME' })
    expect(stateOf(actor).governance).toBe('nominal')
    actor.stop()
  })

  it('le budget épuisé met en pause sans vider la file', async () => {
    // Distinction importante : une pause budgétaire est réversible demain, un kill switch
    // est une décision. Vider la file dans les deux cas perdrait du travail utile.
    const actor = build({ scout: async () => ({ opportunities: [opportunity(1), opportunity(2)] }) })
    actor.send({ type: 'TICK' })
    await settle()
    const before = actor.getSnapshot().context.queue.length

    actor.send({ type: 'BUDGET_EXHAUSTED', detail: 'plafond atteint' })
    expect(stateOf(actor).governance).toBe('paused')
    expect(actor.getSnapshot().context.queue.length).toBe(before)
    actor.stop()
  })

  it('une rupture de sélecteur dégrade sans arrêter', async () => {
    const actor = build()
    actor.send({ type: 'SELECTOR_BROKEN', selectorName: 'post.text' })
    expect(stateOf(actor).governance).toBe('degraded')
    actor.send({ type: 'SELECTORS_RECOVERED' })
    expect(stateOf(actor).governance).toBe('nominal')
    actor.stop()
  })
})

describe('invariant 4 — un veto est un résultat, pas une erreur', () => {
  it('passe à l’opportunité suivante sans compter d’erreur', async () => {
    const actor = build({
      scout: async () => ({ opportunities: [opportunity(1), opportunity(2)] }),
      draft: async (input) =>
        input.opportunity?.id === 1 ? DRAFT_VETO : DRAFT_OK,
    })
    actor.send({ type: 'TICK' })
    await settle(12)

    const context = actor.getSnapshot().context
    expect(context.counters.vetoed).toBe(1)
    expect(context.counters.errors).toBe(0)
    // La seconde opportunité a bien été traitée.
    expect(context.counters.drafted).toBe(1)
    actor.stop()
  })

  it('le coût du veto est compté (MH-05)', async () => {
    // Un veto a consommé deux appels : ne pas les compter sous-estimerait la dépense.
    const actor = build({
      scout: async () => ({ opportunities: [opportunity(1)] }),
      draft: async () => DRAFT_VETO,
    })
    actor.send({ type: 'TICK' })
    await settle(12)
    expect(actor.getSnapshot().context.cycleCostEur).toBeCloseTo(0.013, 6)
    actor.stop()
  })

  it('une VRAIE erreur d’agent compte comme erreur et applique un backoff', async () => {
    const actor = build({
      scout: async () => ({ opportunities: [opportunity(1)] }),
      draft: async () => {
        throw new Error('provider indisponible')
      },
    })
    const before = actor.getSnapshot().context.backoffMs
    actor.send({ type: 'TICK' })
    await settle(12)

    const context = actor.getSnapshot().context
    expect(context.counters.errors).toBe(1)
    expect(context.lastError).toContain('provider indisponible')
    expect(context.backoffMs).toBeGreaterThan(before)
    actor.stop()
  })

  it('le backoff est plafonné', async () => {
    const actor = build({}, { backoffMs: MAX_BACKOFF_MS })
    // On force plusieurs erreurs : le plafond doit tenir.
    const errorActor = build(
      {
        scout: async () => {
          throw new Error('panne')
        },
      },
      { backoffMs: MAX_BACKOFF_MS },
    )
    errorActor.send({ type: 'TICK' })
    await settle(12)
    expect(errorActor.getSnapshot().context.backoffMs).toBeLessThanOrEqual(MAX_BACKOFF_MS)
    actor.stop()
    errorActor.stop()
  })
})

describe('invariant 5 — confirming distingue publié d’abandonné (MH-09)', () => {
  it('une confirmation compte une publication', async () => {
    const actor = build({ scout: async () => ({ opportunities: [opportunity(1)] }) })
    actor.send({ type: 'TICK' })
    await settle()
    actor.send({ type: 'APPROVE' })
    await settle()
    expect(stateOf(actor).pipeline).toBe('confirming')

    actor.send({ type: 'PUBLISH_CONFIRMED', xPostId: '1789456999999999999' })
    await settle()
    expect(actor.getSnapshot().context.counters.published).toBe(1)
    expect(actor.getSnapshot().context.counters.abandoned).toBe(0)
    actor.stop()
  })

  it('un abandon explicite compte un abandon', async () => {
    const actor = build({ scout: async () => ({ opportunities: [opportunity(1)] }) })
    actor.send({ type: 'TICK' })
    await settle()
    actor.send({ type: 'APPROVE' })
    await settle()

    actor.send({ type: 'PUBLISH_ABANDONED' })
    await settle()
    expect(actor.getSnapshot().context.counters.abandoned).toBe(1)
    expect(actor.getSnapshot().context.counters.published).toBe(0)
    actor.stop()
  })

  it('la confirmation EXPIRE — contrairement à la validation', async () => {
    // Distinction essentielle : on n'attend pas un consentement, on constate un fait. Ne
    // jamais conclure laisserait une action `pending` éternelle, invisible dans les stats.
    vi.useFakeTimers()
    const actor = build({ scout: async () => ({ opportunities: [opportunity(1)] }) })
    actor.send({ type: 'TICK' })
    await settle()
    actor.send({ type: 'APPROVE' })
    await settle()
    expect(stateOf(actor).pipeline).toBe('confirming')

    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 1_000)
    expect(actor.getSnapshot().context.counters.abandoned).toBe(1)
    actor.stop()
    vi.useRealTimers()
  })

  it('un échec de mise en scène ne compte NI publication NI abandon', async () => {
    // L'éditeur a refusé : rien n'a été mis en scène, donc rien à confirmer. Compter un
    // abandon fausserait le taux, qui est un signal d'apprentissage.
    const actor = build({
      scout: async () => ({ opportunities: [opportunity(1)] }),
      stage: async () => ({ staged: false, reason: 'éditeur introuvable' }),
    })
    actor.send({ type: 'TICK' })
    await settle()
    actor.send({ type: 'APPROVE' })
    await settle(12)

    const context = actor.getSnapshot().context
    expect(context.counters.staged).toBe(0)
    expect(context.counters.published).toBe(0)
    expect(context.counters.abandoned).toBe(0)
    expect(context.counters.errors).toBe(1)
    actor.stop()
  })
})

describe('reprise après mort du service worker', () => {
  it('le snapshot persisté est sérialisable en JSON', async () => {
    // Contrainte MV3 : une fonction ou une classe dans le contexte casserait la reprise.
    const actor = build({ scout: async () => ({ opportunities: [opportunity(1)] }) })
    actor.send({ type: 'TICK' })
    await settle()

    const snapshot = actor.getPersistedSnapshot()
    expect(() => JSON.stringify(snapshot)).not.toThrow()
    const roundTripped = JSON.parse(JSON.stringify(snapshot))
    expect(roundTripped).toBeDefined()
    actor.stop()
  })

  it('restaure la file et l’état après redémarrage', async () => {
    const machine = orchestrator.provide({
      actors: {
        scout: fromPromise<ScoutOutput, void>(async () => ({
          opportunities: [opportunity(1), opportunity(2)],
        })),
        draft: fromPromise<DraftOutput, DraftInput>(async () => DRAFT_OK),
        stage: fromPromise<StageOutput, StageInput>(async () => ({ staged: true, reason: null })),
        measure: fromPromise<MeasureOutput, void>(async () => ({ measured: 0 })),
        learn: fromPromise<LearnOutput, void>(async () => ({ patternsUpdated: 0 })),
      },
    })

    const first = createActor(machine)
    first.start()
    first.send({ type: 'TICK' })
    await settle()
    const pipelineBefore = (first.getSnapshot().value as { pipeline: string }).pipeline
    const queueBefore = first.getSnapshot().context.queue.length
    const persisted = JSON.parse(JSON.stringify(first.getPersistedSnapshot()))
    first.stop()

    // Nouveau service worker, même snapshot.
    const revived = createActor(machine, { snapshot: persisted })
    revived.start()
    expect((revived.getSnapshot().value as { pipeline: string }).pipeline).toBe(pipelineBefore)
    expect(revived.getSnapshot().context.queue.length).toBe(queueBefore)

    // Et il reste pilotable : un rejet fait avancer la file, il ne la vide pas.
    const rejectedId = revived.getSnapshot().context.current?.id
    revived.send({ type: 'REJECT' })
    await settle()
    const nextId = revived.getSnapshot().context.current?.id
    expect(nextId).not.toBe(rejectedId)
    expect(revived.getSnapshot().context.queue.length).toBeLessThan(queueBefore)
    revived.stop()
  })
})

describe('cycle complet', () => {
  it('traite toute la file puis retourne au repos', async () => {
    const actor = build({
      scout: async () => ({
        opportunities: [opportunity(1), opportunity(2), opportunity(3)],
      }),
      draft: async () => DRAFT_VETO,
    })
    actor.send({ type: 'TICK' })
    await settle(30)

    const context = actor.getSnapshot().context
    expect(context.counters.vetoed).toBe(3)
    expect(context.queue).toHaveLength(0)
    expect(stateOf(actor).pipeline).toBe('idle')
    actor.stop()
  })

  it('un scout vide passe directement à la mesure', async () => {
    const measured: number[] = []
    const actor = build({
      scout: async () => ({ opportunities: [] }),
      measure: async () => {
        measured.push(1)
        return { measured: 0 }
      },
    })
    actor.send({ type: 'TICK' })
    await settle(12)
    expect(measured).toHaveLength(1)
    actor.stop()
  })

  it('l’overlay court-circuite le triage', async () => {
    const scouted: number[] = []
    const actor = build({
      scout: async () => {
        scouted.push(1)
        return { opportunities: [] }
      },
    })
    actor.send({ type: 'MANUAL_TRIGGER', opportunity: opportunity(42) })
    await settle()
    // L'utilisateur a déjà choisi : pas de triage.
    expect(scouted).toHaveLength(0)
    expect(actor.getSnapshot().context.current?.id).toBe(42)
    expect(stateOf(actor).pipeline).toBe('awaitingHuman')
    actor.stop()
  })
})

describe('describeState', () => {
  it('donne une phrase lisible pour chaque état notable', () => {
    const cases: [string, string, RegExp][] = [
      ['idle', 'nominal', /attente du prochain cycle/],
      ['drafting', 'nominal', /Rédaction/],
      ['awaitingHuman', 'nominal', /ta validation/],
      ['confirming', 'nominal', /confirmation/],
      ['idle', 'halted', /arrêté/],
      ['idle', 'paused', /budget/],
      ['idle', 'degraded', /parsing/],
    ]
    for (const [pipeline, governance, expected] of cases) {
      const described = describeState({
        value: { pipeline, governance },
        context: { ...({} as OrchestratorContext) },
      })
      expect(described.summary, `${pipeline}/${governance}`).toMatch(expected)
    }
  })

  it('la gouvernance prime sur le pipeline dans le résumé', () => {
    // Un swarm arrêté en cours de rédaction doit dire « arrêté », pas « rédaction ».
    const described = describeState({
      value: { pipeline: 'drafting', governance: 'halted' },
      context: { ...({} as OrchestratorContext) },
    })
    expect(described.summary).toContain('arrêté')
  })
})
