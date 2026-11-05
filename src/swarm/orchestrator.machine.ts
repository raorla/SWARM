/**
 * ORCHESTRATEUR — machine à états XState v5. Voir `docs/adr/0001`.
 *
 * ## Ce que la machine garantit structurellement
 *
 * Cinq invariants de sûreté qui ne dépendent d'aucune discipline de relecture :
 *
 *  1. **`awaitingHuman` n'a aucune transition temporelle.** Le mode Copilote ne peut pas
 *     dériver vers la publication automatique par oubli de validation : l'inaction ne vaut
 *     jamais consentement.
 *  2. **Le `always` de `queued` retombe sur `awaitingHuman` en dernier recours.** Si un garde
 *     est mal évalué, on tombe sur la validation humaine, jamais sur l'action.
 *  3. **`KILL` vit dans une région parallèle**, donc il est traité quel que soit l'état du
 *     pipeline — y compris pendant un appel LLM. Un kill switch qui ne fonctionne pas pendant
 *     un `await` est un kill switch qui ne fonctionne pas au moment où on en a besoin.
 *  4. **Un veto du CRITIC est un `onDone`**, jamais un `onError`. Le rejet est un résultat.
 *  5. **`staging` écrit puis s'arrête ; `confirming` découvre** si l'humain a publié. Sans ce
 *     second état, l'ANALYST mesurerait des actions fantômes (MH-09).
 *
 * ## Contrainte MV3
 *
 * Le service worker meurt sans préavis. Le snapshot est donc sérialisé à chaque transition et
 * rejoué au réveil, ce qui impose un **contexte entièrement sérialisable** : aucune fonction,
 * aucune classe, aucune référence DOM dedans.
 */
import { assign, fromPromise, setup, type SnapshotFrom } from 'xstate'

/* ─────────────────────────────── Types du contexte ───────────────────────── */

/** Opportunité en cours de traitement, réduite à ce qui est sérialisable. */
export interface PipelineOpportunity {
  id: number
  postId: string
  authorHandle: string
  text: string
  evScore: number
  /** Rang EV au moment de l'entrée en pipeline — pilote l'escalade de modèle. */
  evRank: number
}

export interface StagedDraft {
  idempotencyKey: string
  opportunityId: number
  text: string
  angle: string
  /** Instant de mise en scène — base du délai de confirmation. */
  stagedAtMs: number
}

export interface OrchestratorContext {
  mode: 'simulation' | 'copilot' | 'autopilot'
  /** File d'attente, la plus prometteuse d'abord. */
  queue: PipelineOpportunity[]
  current: PipelineOpportunity | null
  staged: StagedDraft | null
  /** Dépense cumulée du cycle, pour le cockpit. */
  cycleCostEur: number
  /** Compteurs de cycle, remis à zéro à chaque tour complet. */
  counters: {
    scouted: number
    qualified: number
    drafted: number
    vetoed: number
    staged: number
    published: number
    abandoned: number
    errors: number
  }
  lastError: string | null
  /** Millisecondes de backoff après une erreur retryable. */
  backoffMs: number
  /** Raison du dernier refus du governor, pour l'affichage. */
  lastDenial: string | null
}

export type OrchestratorEvent =
  | { type: 'TICK' }
  | { type: 'MANUAL_TRIGGER'; opportunity: PipelineOpportunity }
  | { type: 'APPROVE'; text?: string }
  | { type: 'REJECT'; reason?: string }
  | { type: 'KILL'; reason: string }
  | { type: 'RESUME' }
  | { type: 'BUDGET_EXHAUSTED'; detail: string }
  | { type: 'BUDGET_RESTORED' }
  | { type: 'SELECTOR_BROKEN'; selectorName: string }
  | { type: 'SELECTORS_RECOVERED' }
  | { type: 'PUBLISH_CONFIRMED'; xPostId: string | null }
  | { type: 'PUBLISH_ABANDONED' }

/** Résultats renvoyés par les acteurs. Volontairement plats et sérialisables. */
export interface ScoutOutput {
  opportunities: PipelineOpportunity[]
}
export interface DraftOutput {
  /** `null` = veto du CRITIC ou absence d'angle. C'est un résultat, pas une erreur. */
  draft: { text: string; angle: string; idempotencyKey: string } | null
  vetoReason: string | null
  costEur: number
}
export interface StageOutput {
  staged: boolean
  reason: string | null
}

export interface DraftInput {
  opportunity: PipelineOpportunity | null
}
export interface StageInput {
  draft: StagedDraft | null
}
export interface MeasureOutput {
  measured: number
}
export interface LearnOutput {
  patternsUpdated: number
}

/**
 * Acteur non fourni.
 *
 * La machine seule ne peut pas tourner : elle décrit l'ordonnancement, pas le travail. Un
 * acteur manquant **échoue bruyamment** au lieu de résoudre silencieusement — sinon la machine
 * enchaînerait ses états sans rien faire, ce qui ressemble à un fonctionnement normal.
 */
function notProvided(name: string): () => Promise<never> {
  return () => {
    throw new Error(
      `acteur « ${name} » non fourni — la machine doit être instanciée via .provide({ actors })`,
    )
  }
}

export const MAX_BACKOFF_MS = 5 * 60_000
const INITIAL_BACKOFF_MS = 2_000

export const initialContext: OrchestratorContext = {
  mode: 'copilot',
  queue: [],
  current: null,
  staged: null,
  cycleCostEur: 0,
  counters: {
    scouted: 0,
    qualified: 0,
    drafted: 0,
    vetoed: 0,
    staged: 0,
    published: 0,
    abandoned: 0,
    errors: 0,
  },
  lastError: null,
  backoffMs: INITIAL_BACKOFF_MS,
  lastDenial: null,
}

/**
 * Délai au-delà duquel un brouillon mis en scène est considéré abandonné.
 *
 * Trente minutes : assez pour que l'utilisateur relise et publie, assez court pour ne pas
 * laisser une action `pending` polluer le taux d'abandon indéfiniment. Ce délai porte sur la
 * *confirmation*, pas sur la validation — `awaitingHuman`, lui, n'expire jamais.
 */
export const CONFIRM_TIMEOUT_MS = 30 * 60_000

export const orchestrator = setup({
  types: {
    context: {} as OrchestratorContext,
    events: {} as OrchestratorEvent,
  },

  actors: {
    /** SCOUT + QUALIFIER : remplit la file. */
    scout: fromPromise<ScoutOutput, void>(notProvided('scout')),
    /** WRITER + CRITIC : produit un brouillon, ou pose un veto. */
    draft: fromPromise<DraftOutput, DraftInput>(notProvided('draft')),
    /** ACTUATOR : écrit dans le composeur de X. Ne soumet jamais. */
    stage: fromPromise<StageOutput, StageInput>(notProvided('stage')),
    /** ANALYST : mesure les actions dues. */
    measure: fromPromise<MeasureOutput, void>(notProvided('measure')),
    /** Agrégation des patterns et réinjection dans les prompts. */
    learn: fromPromise<LearnOutput, void>(notProvided('learn')),
  },

  guards: {
    hasQueue: ({ context }) => context.queue.length > 0,
    isSimulation: ({ context }) => context.mode === 'simulation',
    /**
     * L'autopilote reste refusé tant que son code n'existe pas (SPEC §4.6).
     * Le garde est là pour que la machine ne puisse pas emprunter un chemin non écrit.
     */
    isAutopilotImplemented: () => false,
    hasDraft: ({ context }) => context.staged !== null,
  },

  actions: {
    storeQueue: assign(({ context }, params: { opportunities: PipelineOpportunity[] }) => ({
      // La file est remplacée, pas concaténée : le triage renvoie l'état courant du
      // classement, et concaténer accumulerait des doublons de rang.
      queue: params.opportunities,
      counters: {
        ...context.counters,
        scouted: context.counters.scouted + params.opportunities.length,
        qualified: context.counters.qualified + params.opportunities.length,
      },
    })),

    shiftQueue: assign(({ context }) => ({
      current: context.queue[0] ?? null,
      queue: context.queue.slice(1),
    })),

    setCurrent: assign((_, params: { opportunity: PipelineOpportunity }) => ({
      current: params.opportunity,
    })),

    storeDraft: assign(({ context }, params: { output: DraftOutput }) => ({
      staged:
        params.output.draft === null
          ? null
          : {
              idempotencyKey: params.output.draft.idempotencyKey,
              opportunityId: context.current?.id ?? 0,
              text: params.output.draft.text,
              angle: params.output.draft.angle,
              stagedAtMs: 0,
            },
      cycleCostEur: context.cycleCostEur + params.output.costEur,
      counters: {
        ...context.counters,
        drafted: context.counters.drafted + (params.output.draft === null ? 0 : 1),
        vetoed: context.counters.vetoed + (params.output.draft === null ? 1 : 0),
      },
    })),

    markStaged: assign(({ context }) => ({
      counters: { ...context.counters, staged: context.counters.staged + 1 },
    })),

    markPublished: assign(({ context }) => ({
      staged: null,
      current: null,
      counters: { ...context.counters, published: context.counters.published + 1 },
    })),

    markAbandoned: assign(({ context }) => ({
      staged: null,
      current: null,
      counters: { ...context.counters, abandoned: context.counters.abandoned + 1 },
    })),

    clearCurrent: assign({ current: null, staged: null }),

    recordError: assign(({ context }, params: { message: string }) => ({
      lastError: params.message,
      counters: { ...context.counters, errors: context.counters.errors + 1 },
      // Backoff exponentiel plafonné : un service en panne ne doit pas être martelé, et un
      // backoff non borné rendrait le produit muet pour la journée.
      backoffMs: Math.min(MAX_BACKOFF_MS, context.backoffMs * 2),
    })),

    resetBackoff: assign({ backoffMs: INITIAL_BACKOFF_MS, lastError: null }),

    recordDenial: assign((_, params: { reason: string }) => ({ lastDenial: params.reason })),

    /** Vidage de la file au kill switch — SPEC §2.3. */
    flushQueue: assign({
      queue: [],
      current: null,
      staged: null,
      lastDenial: 'kill switch',
    }),

    resetCycle: assign({ cycleCostEur: 0 }),
  },
}).createMachine({
  id: 'swarm',
  type: 'parallel',
  context: initialContext,

  states: {
    /* ═══════════════════════ Région de gouvernance ═══════════════════════ */
    /**
     * Tourne en permanence, indépendamment du pipeline. C'est cette parallélisation qui
     * permet au kill switch d'être traité même pendant un appel LLM en cours.
     */
    governance: {
      initial: 'nominal',
      states: {
        nominal: {
          on: {
            KILL: { target: 'halted', actions: 'flushQueue' },
            BUDGET_EXHAUSTED: 'paused',
            SELECTOR_BROKEN: 'degraded',
          },
        },
        /** État absorbant : seul un `RESUME` explicite en sort. */
        halted: {
          on: { RESUME: { target: 'nominal', actions: 'resetBackoff' } },
        },
        paused: {
          on: {
            RESUME: 'nominal',
            BUDGET_RESTORED: 'nominal',
            KILL: { target: 'halted', actions: 'flushQueue' },
          },
        },
        /** Lecture autorisée, écriture DOM interdite : le parsing n'est plus fiable. */
        degraded: {
          on: {
            SELECTORS_RECOVERED: 'nominal',
            RESUME: 'nominal',
            KILL: { target: 'halted', actions: 'flushQueue' },
          },
        },
      },
    },

    /* ══════════════════════════ Région du pipeline ════════════════════════ */
    pipeline: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            TICK: 'scouting',
            MANUAL_TRIGGER: {
              // L'overlay court-circuite le triage : l'utilisateur a déjà choisi.
              target: 'drafting',
              actions: {
                type: 'setCurrent',
                params: ({ event }) => ({ opportunity: event.opportunity }),
              },
            },
          },
        },

        scouting: {
          // Réinitialisation au **début** du cycle, pas à son retour au repos : le cockpit
          // doit pouvoir lire ce qu'a coûté le cycle qui vient de finir. Remettre à zéro en
          // entrant dans `idle` rendrait le compteur invisible précisément quand on le
          // consulte.
          entry: 'resetCycle',
          invoke: {
            src: 'scout',
            onDone: [
              {
                guard: ({ event }) => (event.output as ScoutOutput).opportunities.length > 0,
                target: 'nextOpportunity',
                actions: {
                  type: 'storeQueue',
                  params: ({ event }) => ({
                    opportunities: (event.output as ScoutOutput).opportunities,
                  }),
                },
              },
              { target: 'measuring' },
            ],
            onError: {
              target: 'recovering',
              actions: {
                type: 'recordError',
                params: ({ event }) => ({ message: String(event.error) }),
              },
            },
          },
        },

        nextOpportunity: {
          entry: 'shiftQueue',
          always: [
            { guard: ({ context }) => context.current !== null, target: 'drafting' },
            { target: 'measuring' },
          ],
        },

        drafting: {
          invoke: {
            src: 'draft',
            input: ({ context }) => ({ opportunity: context.current }),
            onDone: [
              {
                // Veto du CRITIC : `onDone`, jamais `onError`. Le rejet est un résultat.
                guard: ({ event }) => (event.output as DraftOutput).draft === null,
                target: 'nextOpportunity',
                actions: [
                  {
                    type: 'storeDraft',
                    params: ({ event }) => ({ output: event.output as DraftOutput }),
                  },
                  'clearCurrent',
                ],
              },
              {
                target: 'queued',
                actions: {
                  type: 'storeDraft',
                  params: ({ event }) => ({ output: event.output as DraftOutput }),
                },
              },
            ],
            onError: {
              target: 'recovering',
              actions: {
                type: 'recordError',
                params: ({ event }) => ({ message: String(event.error) }),
              },
            },
          },
        },

        /**
         * Point de bascule.
         *
         * L'ordre des `always` est un invariant de sûreté : `awaitingHuman` est le **dernier**
         * recours, donc un garde mal évalué mène à la validation humaine, jamais à l'action.
         */
        queued: {
          always: [
            {
              guard: 'isSimulation',
              target: 'nextOpportunity',
              actions: [
                { type: 'recordDenial', params: { reason: 'mode simulation' } },
                'clearCurrent',
              ],
            },
            {
              guard: ({ context }) =>
                context.mode === 'autopilot' && !ORCHESTRATOR_AUTOPILOT_READY,
              target: 'awaitingHuman',
              actions: {
                type: 'recordDenial',
                params: { reason: 'autopilote non implémenté — repli sur validation humaine' },
              },
            },
            { guard: 'isAutopilotImplemented', target: 'staging' },
            // Dernier recours, et le seul chemin réellement emprunté aujourd'hui.
            { target: 'awaitingHuman' },
          ],
        },

        /**
         * Validation humaine.
         *
         * **Aucune transition temporelle**, aucun `after`. L'inaction ne vaut jamais
         * consentement : c'est ce qui empêche le Copilote de dériver vers la publication
         * automatique par oubli.
         */
        awaitingHuman: {
          on: {
            APPROVE: 'staging',
            REJECT: {
              target: 'nextOpportunity',
              actions: 'clearCurrent',
            },
          },
        },

        staging: {
          invoke: {
            src: 'stage',
            input: ({ context }) => ({ draft: context.staged }),
            onDone: [
              {
                guard: ({ event }) => (event.output as StageOutput).staged,
                target: 'confirming',
                actions: ['markStaged', 'resetBackoff'],
              },
              {
                target: 'recovering',
                actions: {
                  type: 'recordError',
                  params: ({ event }) => ({
                    message: (event.output as StageOutput).reason ?? 'mise en scène refusée',
                  }),
                },
              },
            ],
            onError: {
              target: 'recovering',
              actions: {
                type: 'recordError',
                params: ({ event }) => ({ message: String(event.error) }),
              },
            },
          },
        },

        /**
         * Confirmation — MH-09.
         *
         * En Copilote c'est l'humain qui clique Publier. Sans cet état, l'ANALYST mesurerait
         * des actions qui n'ont jamais existé, et la boucle d'apprentissage s'entraînerait sur
         * du bruit.
         *
         * Le délai est **borné** ici, contrairement à `awaitingHuman` : on n'attend pas un
         * consentement, on constate un fait. Ne jamais conclure laisserait une action
         * `pending` éternelle, invisible dans les statistiques.
         */
        confirming: {
          after: {
            [CONFIRM_TIMEOUT_MS]: { target: 'nextOpportunity', actions: 'markAbandoned' },
          },
          on: {
            PUBLISH_CONFIRMED: { target: 'measuring', actions: 'markPublished' },
            PUBLISH_ABANDONED: { target: 'nextOpportunity', actions: 'markAbandoned' },
          },
        },

        measuring: {
          invoke: {
            src: 'measure',
            onDone: 'learning',
            onError: {
              target: 'learning',
              actions: {
                // Une mesure qui échoue ne doit pas empêcher l'apprentissage sur ce qui a
                // déjà été mesuré : on note l'erreur et on continue.
                type: 'recordError',
                params: ({ event }) => ({ message: String(event.error) }),
              },
            },
          },
        },

        learning: {
          invoke: {
            src: 'learn',
            onDone: 'idle',
            onError: {
              target: 'idle',
              actions: {
                type: 'recordError',
                params: ({ event }) => ({ message: String(event.error) }),
              },
            },
          },
        },

        recovering: {
          always: [
            { guard: 'hasQueue', target: 'nextOpportunity', actions: 'clearCurrent' },
            { target: 'idle', actions: 'clearCurrent' },
          ],
        },
      },
    },
  },
})

/**
 * Drapeau d'implémentation de l'autopilote.
 *
 * Constante et non configuration : c'est le code d'exécution qui manque, pas une permission.
 * La machine ne doit pas pouvoir emprunter un chemin non écrit, même avec une config
 * corrompue (SPEC §4.6).
 */
export const ORCHESTRATOR_AUTOPILOT_READY = false

export type OrchestratorSnapshot = SnapshotFrom<typeof orchestrator>

/** État lisible, pour le cockpit. */
export function describeState(snapshot: {
  value: unknown
  context: OrchestratorContext
}): { pipeline: string; governance: string; summary: string } {
  const value = snapshot.value as { pipeline?: string; governance?: string }
  const pipeline = value.pipeline ?? 'inconnu'
  const governance = value.governance ?? 'inconnu'

  const summary = ((): string => {
    if (governance === 'halted') return 'Swarm arrêté — file vidée'
    if (governance === 'paused') return 'En pause — budget quotidien épuisé'
    if (governance === 'degraded') return 'Dégradé — parsing de X cassé, écriture suspendue'
    switch (pipeline) {
      case 'idle':
        return 'En attente du prochain cycle'
      case 'scouting':
        return 'Observation et triage'
      case 'drafting':
        return 'Rédaction et relecture critique'
      case 'awaitingHuman':
        return 'En attente de ta validation'
      case 'staging':
        return 'Mise en scène dans le composeur'
      case 'confirming':
        return 'Attente de confirmation de publication'
      case 'measuring':
        return 'Mesure des actions publiées'
      case 'learning':
        return 'Mise à jour des patterns'
      default:
        return pipeline
    }
  })()

  return { pipeline, governance, summary }
}
