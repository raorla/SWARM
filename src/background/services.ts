/**
 * Construction des services depuis la persistance.
 *
 * Chaque appel reconstruit tout : c'est délibéré. Un service worker mort ne peut pas
 * conserver de singleton, et prétendre le contraire produit des bugs qui n'apparaissent
 * qu'après 30 s d'inactivité — les plus coûteux à diagnostiquer.
 */
import {
  Governor,
  chromeCadenceStore,
  chromeCapStore,
  chromeKillSwitchStore,
} from '@/governor'
import type { AuditEntry, AuditStore } from '@/governor/audit'
import { db } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { ActionRepo } from '@/db/repositories/action.repo'
import { BudgetMeter, chromeBudgetStore } from '@/llm/budget'
import { Keystore, chromeBackend, chromeSessionCache } from '@/llm/keystore'
import { LlmClient } from '@/llm/client'
import { systemClock, type Clock } from '@/shared/time'
import { createLogger } from '@/shared/logger'
import type { SwarmState } from '@/messaging/contract'
import type { DailyCaps } from '@/governor/types'

const log = createLogger('background:services')
/**
 * Horloge par défaut des fabriques.
 *
 * Ce module ne contient pas de logique temporelle : il **fournit** l'horloge aux objets qu'il
 * construit. Le paramètre reste néanmoins injectable, pour deux raisons — un test de bout en
 * bout du background doit pouvoir construire un governor sur une horloge simulée, et une
 * exception à MH-17 « parce que c'est une fabrique » se transforme en habitude (c'est
 * exactement comme ça que `voice-profile.handler.ts` avait échappé à la règle).
 */
const defaultClock: Clock = systemClock

/** Journal d'audit adossé à Dexie. Append-only : aucune méthode de modification. */
function dexieAuditStore(): AuditStore {
  return {
    append: async (entry) => {
      await db().auditLog.add(entry)
    },
    last: async () => db().auditLog.orderBy('seq').last(),
    all: async () => db().auditLog.orderBy('seq').toArray(),
  }
}

export async function buildGovernor(clock: Clock = defaultClock): Promise<Governor> {
  const config = await new ConfigRepo(db(), clock).get()
  const actions = new ActionRepo(db(), clock)
  const budget = new BudgetMeter(chromeBudgetStore(), clock, config.budget)

  return new Governor(
    {
      mode: config.mode,
      installSeed: config.installSeed,
      caps: config.caps as unknown as DailyCaps,
      cadence: config.cadence,
      window: config.window,
    },
    {
      capStore: chromeCapStore(),
      cadenceStore: chromeCadenceStore(),
      killSwitchStore: chromeKillSwitchStore(),
      auditStore: dexieAuditStore(),
      clock,
      budgetCheck: async () => budget.check('writer', 0),
      isDuplicate: (key) => actions.exists(key),
    },
  )
}

/**
 * Keystore adossé au cache de session.
 *
 * La passphrase n'est stockée nulle part ; le coffre **déchiffré**, lui, est mis en cache
 * dans `chrome.storage.session` — en mémoire, jamais sur le disque, effacé à la fermeture du
 * navigateur, avec un TTL de 8 h (voir `keystore.ts`, section « Déverrouillage de session »).
 *
 * Sans ce cache, un déverrouillage fait dans le side panel n'existait plus au message
 * suivant, puisque le service worker meurt entre deux : le chemin LLM était inatteignable en
 * pratique. `restoreKeystore()` est donc la porte d'entrée normale, et `buildKeystore()` ne
 * subsiste que pour les appels qui n'ont pas besoin du coffre.
 */
export function buildKeystore(clock: Clock = defaultClock): Keystore {
  return new Keystore(chromeBackend(), chromeSessionCache(), clock)
}

/** Keystore avec le déverrouillage de session déjà restauré, s'il en existe un. */
export async function restoreKeystore(clock: Clock = defaultClock): Promise<Keystore> {
  const keystore = buildKeystore(clock)
  await keystore.restore()
  return keystore
}

export async function buildLlmClient(
  keystore: Keystore,
  clock: Clock = defaultClock,
): Promise<LlmClient> {
  const config = await new ConfigRepo(db(), clock).get()
  return new LlmClient({
    keystore,
    budget: new BudgetMeter(chromeBudgetStore(), clock, config.budget),
    clock,
    hasHostPermission: async (origin) =>
      chrome.permissions.contains({ origins: [origin] }),
  })
}

export async function killSwitchFromCommand(clock: Clock = defaultClock): Promise<void> {
  const governor = await buildGovernor(clock)
  await governor.engageKillSwitch('raccourci clavier')
  log.warn('kill switch déclenché au clavier')
}

/**
 * Test d'appel LLM — DoD de la Phase 0.
 *
 * Renvoie aussi `cacheReadTokens` : c'est la mesure qui tranche FEEDBACK R-03, dont
 * dépend tout le chiffrage à 1 €/jour. Deux appels successifs avec le même préfixe
 * doivent faire monter ce compteur ; s'il reste à zéro, le cache ne passe pas par
 * OpenRouter et WRITER/CRITIC doivent basculer sur Anthropic en direct.
 */
export async function runLlmSelfTest(
  prompt: string,
  clock: Clock = defaultClock,
): Promise<{
  ok: boolean
  text?: string
  costEur?: number
  usage?: { input: number; output: number; cacheRead: number }
  model?: string
  error?: string
}> {
  const keystore = await restoreKeystore(clock)
  const client = await buildLlmClient(keystore, clock)

  if (!keystore.isUnlocked) {
    return {
      ok: false,
      error: 'coffre verrouillé — déverrouille-le dans l’onglet Config',
    }
  }

  const result = await client.call({
    role: 'selftest',
    messages: [
      {
        role: 'system',
        content:
          'Tu es le test de connectivité de SWARM. Réponds en une phrase, sans préambule.',
        cacheable: true,
      },
      { role: 'user', content: prompt },
    ],
  })

  if (!result.ok) return { ok: false, error: result.error.message }
  return {
    ok: true,
    text: result.value.text,
    costEur: result.value.costEur,
    usage: {
      input: result.value.usage.inputTokens,
      output: result.value.usage.outputTokens,
      cacheRead: result.value.usage.cacheReadTokens,
    },
    model: result.value.model,
  }
}

export async function swarmStateSnapshot(clock: Clock = defaultClock): Promise<SwarmState> {
  const config = await new ConfigRepo(db(), clock).get()
  const governor = await buildGovernor()
  const snap = await governor.snapshot()
  const budget = new BudgetMeter(chromeBudgetStore(), clock, config.budget)
  const budgetSnap = await budget.snapshot()

  return {
    mode: config.mode,
    // Phase 4 branchera l'orchestrateur XState ; d'ici là l'état est nominal ou arrêté.
    pipelineState: snap.killSwitchEngaged ? 'halted' : 'idle',
    governanceState: snap.killSwitchEngaged ? 'halted' : 'nominal',
    activeAgent: null,
    spentTodayEur: budgetSnap.spentEur,
    budgetEur: budgetSnap.budgetEur,
    queueLength: await db().opportunities.where('status').equals('queued').count(),
    caps: snap.caps,
  }
}

export type { AuditEntry }
