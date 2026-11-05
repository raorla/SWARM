/**
 * Client LLM pour les mesures « live ».
 *
 * Le même `LlmClient` que l'extension, avec trois substitutions et une seule qui compte :
 *
 *  - keystore **en mémoire** au lieu de `chrome.storage` — le clair ne survit pas au script ;
 *  - permission d'hôte toujours accordée : `chrome.permissions` n'existe pas en Node, et le
 *    garde-fou qu'elle représente protège l'utilisateur, pas l'auteur du script ;
 *  - budget **en mémoire, plafonné par `.env`**. C'est la substitution importante : le plafond
 *    est appliqué par le vrai `BudgetMeter`, donc un script qui boucle par erreur est coupé
 *    par le même code que celui qui protège l'utilisateur. Un compteur affiché mais non
 *    appliqué n'aurait servi à rien.
 */
import { LlmClient } from '@/llm/client'
import { BudgetMeter, memoryBudgetStore } from '@/llm/budget'
import { Keystore, memoryBackend } from '@/llm/keystore'
import { systemClock } from '@/shared/time'
import { checkOpenRouterKey, loadEnv, type ScriptEnv } from '../../../scripts/lib/env.ts'

export interface LiveClient {
  client: LlmClient
  budget: BudgetMeter
  env: ScriptEnv
}

/**
 * Construit le client, ou lève avec le message qui dit quoi corriger.
 *
 * Les fichiers de mesure sautent déjà quand la clé manque (`describe.skipIf`) : arriver ici
 * sans clé est donc une erreur de câblage, et il vaut mieux la nommer que la contourner.
 */
export async function buildLiveClient(): Promise<LiveClient> {
  const env = loadEnv()
  const check = checkOpenRouterKey(env.openRouterKey)
  if (!check.ok) throw new Error(check.reason ?? 'clé indisponible')

  const keystore = new Keystore(memoryBackend())
  // Passphrase jetable : le coffre ne survit pas au processus, et rien ne l'écrit sur disque.
  await keystore.initialize('passphrase-de-script-jetable', {
    openrouter: { providerId: 'openrouter', apiKey: env.openRouterKey! },
  })

  const budget = new BudgetMeter(memoryBudgetStore(), systemClock, {
    dailyEur: env.budgetEur,
    // Aucune réserve : une mesure n'a pas de contrôle qualité à protéger, et une réserve
    // rendrait le plafond affiché différent du plafond appliqué.
    reserveFraction: 0,
  })

  const client = new LlmClient({
    keystore,
    budget,
    clock: systemClock,
    hasHostPermission: async () => true,
  })

  return { client, budget, env }
}

/** Dépense du jour, pour l'afficher en fin de mesure. */
export async function spentEur(budget: BudgetMeter): Promise<number> {
  const snapshot = await budget.snapshot()
  return snapshot.spentEur
}
