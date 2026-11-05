/**
 * Installation, mise à jour, démarrage.
 *
 * Deux responsabilités qui ne sont pas évidentes :
 *
 *  1. **Réinjecter le content script** dans les onglets X déjà ouverts. Après une mise à
 *     jour, l'ancien script est mort et le nouveau ne s'injecte que sur navigation : sans
 *     cette étape, l'utilisateur doit recharger X à la main après chaque update, sans
 *     comprendre pourquoi le produit ne réagit plus.
 *  2. **Réconcilier les actions en attente.** Si le worker est mort entre la mise en
 *     scène d'un brouillon et la confirmation, l'action reste `pending` pour toujours et
 *     l'ANALYST attend une mesure qui n'arrivera jamais.
 */
import { db } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { ActionRepo } from '@/db/repositories/action.repo'
import { bundledPacks } from '@/niches/loader'
import { createLogger } from '@/shared/logger'
import { DAY, systemClock, type Clock } from '@/shared/time'

const log = createLogger('background:lifecycle')
/**
 * Horloge injectable (MH-17). `reconcilePendingActions` compare des dates : la figer au
 * niveau du module rendait la réconciliation d'abandon intestable, alors que c'est la seule
 * chose ici dont la justesse se voit dans les statistiques du produit.
 */
export interface LifecycleDeps {
  clock: Clock
}

const defaultDeps: LifecycleDeps = { clock: systemClock }

/** Au-delà de ce délai, une action `pending` est considérée abandonnée (MH-09). */
const PENDING_TIMEOUT_MS = 2 * DAY

export async function onInstalled(
  details: chrome.runtime.InstalledDetails,
  deps: LifecycleDeps = defaultDeps,
): Promise<void> {
  log.info('installation / mise à jour', { reason: details.reason })

  // Crée la config par défaut si absente, sans écraser une config existante.
  await new ConfigRepo(db(), deps.clock).get()
  await installBundledPacks(deps.clock)

  if (details.reason === 'update') await reinjectContentScripts()
  await reconcilePendingActions(deps)
}

export async function onStartup(deps: LifecycleDeps = defaultDeps): Promise<void> {
  log.info('démarrage du navigateur')
  await reconcilePendingActions(deps)
}

/** Installe ou met à jour les packs livrés, sans toucher aux packs importés. */
async function installBundledPacks(clock: Clock): Promise<void> {
  for (const pack of bundledPacks()) {
    const existing = await db().nichePacks.get(pack.id)
    if (existing && existing.version === pack.version) continue
    // On écrase un pack livré, jamais un pack importé par l'utilisateur : `isBundled`
    // distingue les deux, et un pack utilisateur qui porterait le même id est préservé.
    if (existing && !existing.isBundled) {
      log.info('pack utilisateur conservé, pack livré ignoré', { id: pack.id })
      continue
    }
    await db().nichePacks.put({
      id: pack.id,
      version: pack.version,
      json: JSON.stringify({ formatVersion: 1, pack }),
      installedAtMs: clock.now(),
      isBundled: true,
    })
  }
}

async function reinjectContentScripts(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://x.com/*', 'https://twitter.com/*'],
    })
    for (const tab of tabs) {
      if (tab.id === undefined) continue
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/content/index.ts'],
        })
      } catch (e) {
        // Un onglet peut être déchargé ou protégé : c'est normal, on continue.
        log.debug('réinjection impossible sur cet onglet', { tabId: tab.id, error: e })
      }
    }
    log.info('content scripts réinjectés', { tabs: tabs.length })
  } catch (e) {
    log.warn('réinjection impossible', { error: e })
  }
}

/**
 * Une action restée `pending` trop longtemps est classée abandonnée.
 *
 * Le choix de fermer plutôt que de laisser ouvert est délibéré : une action `pending`
 * éternelle est invisible dans les statistiques et fausse le taux d'abandon, qui est
 * justement un des signaux d'apprentissage du produit (MH-09).
 */
export async function reconcilePendingActions(
  deps: LifecycleDeps = defaultDeps,
): Promise<{ closed: number }> {
  const repo = new ActionRepo(db(), deps.clock)
  const pending = await repo.pending()
  const cutoff = deps.clock.now() - PENDING_TIMEOUT_MS
  let closed = 0
  for (const action of pending) {
    if (action.stagedAtMs < cutoff) {
      await repo.markAbandoned(action.idempotencyKey)
      closed++
    }
  }
  if (closed > 0) log.info('actions en attente classées abandonnées', { closed })
  return { closed }
}
