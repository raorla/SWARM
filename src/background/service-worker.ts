/**
 * Service worker MV3 — point d'entrée.
 *
 * Contrainte fondatrice : ce contexte est tué sans préavis (~30 s d'inactivité). Il ne garde
 * donc **aucun état en mémoire**. Chaque handler relit ce dont il a besoin depuis Dexie ou
 * `chrome.storage`. Tout ce qui ressemble à un `let` de portée module ici est un bug en attente.
 *
 * ## Pourquoi les imports sont dynamiques, et l'écouteur enregistré en premier
 *
 * Trouvé en préparant la première installation dans Chrome, et c'était une panne **totale** :
 * `chrome.runtime.onMessage.hasListeners()` renvoyait `false` dans le service worker. Le module
 * levait une exception pendant l'évaluation de ses imports — donc avant `router.start()
breadcrumb('listener-registered')` — et
 * l'extension se chargeait, s'affichait, et laissait **tous** les messages expirer sans un mot.
 * Le side panel restait sur « Lecture de la configuration… », indéfiniment.
 *
 * Aucun test unitaire ne pouvait le voir : ils importent chaque handler directement, jamais le
 * graphe complet dans un vrai service worker.
 *
 * Deux règles en découlent, et elles vont dans le même sens :
 *
 *  1. **L'écouteur est enregistré de façon synchrone, avant tout le reste.** C'est ce que MV3
 *     exige de toute façon : un écouteur ajouté après un `await` manque les événements qui
 *     réveillent le worker. Ici, ça garantit en plus qu'un module cassé n'empêche pas le
 *     produit de répondre — il répond une erreur nommée, ce qui est infiniment mieux qu'un
 *     silence.
 *  2. **Chaque handler est importé à la demande, dans le corps de son message.** Le coût est
 *     négligeable — le bundle est déjà en cache disque — et le bénéfice est que la défaillance
 *     est *locale* : un `settings.handler` cassé ne rend pas le kill switch inaccessible.
 */
import { createRouter } from '@/messaging/listen'
import { MSG } from '@/messaging/contract'
import { createLogger } from '@/shared/logger'
import { detectContext } from '@/shared/env'
import { db } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { systemClock } from '@/shared/time'
import { registerAlarms, handleAlarm } from './alarms'
import { onInstalled, onStartup } from './lifecycle'
import { ensureOffscreen } from './offscreen'
import { handleDraftRequest } from './draft.handler'
import {
  ingestOwnPosts,
  rebuildVoiceProfile,
  voiceProfileStatus,
} from './voice-profile.handler'
import { handleObservedPosts } from './qualify.handler'
import { draftFromQueue, listQueue, queueStats, rejectOpportunity } from './queue.handler'
import { recordSelectorBreak, recordSelectorHealth } from './selector-alerts'
import { analyticsSnapshot } from './analyst.handler'
import { listAudit } from './audit.handler'
import {
  acceptConsent,
  lockKeystore,
  removeProviderKey,
  setProviderKey,
  settingsStatus,
  unlockKeystore,
  updateSettings,
} from './settings.handler'
import {
  buildGovernor,
  killSwitchFromCommand,
  runLlmSelfTest,
  swarmStateSnapshot,
} from './services'

const log = createLogger('background')

/**
 * Fil d'Ariane de démarrage — diagnostic MV3.
 *
 * Une exception pendant l'évaluation du module d'un service worker **disparaît** : pas de
 * console ouverte, pas d'utilisateur pour la voir, et le symptôme est un produit muet. Ce
 * marqueur écrit l'étape atteinte, ce qui transforme « rien ne répond » en « le module s'est
 * arrêté à telle étape ». Il coûte une écriture dans `chrome.storage.local` par démarrage.
 */
function breadcrumb(step: string): void {
  void chrome.storage?.local?.set({ 'swarm:boot:step': step }).catch(() => undefined)
}

breadcrumb('module-entry')

log.info('service worker démarré', { context: detectContext() })

const router = createRouter('background')

/* ────────────────────────────── Routage ───────────────────────────────────── */

router
  .on(MSG.PING, () => ({ pong: true }))
  .on(MSG.POSTS_OBSERVED, async (payload) => {
    return handleObservedPosts(payload)
  })
  .on(MSG.QUEUE_LIST, async (payload) => {
    return listQueue(payload)
  })
  .on(MSG.QUEUE_STATS, async () => {
    return queueStats()
  })
  .on(MSG.OPPORTUNITY_DRAFT, async (payload) => {
    return draftFromQueue(payload)
  })
  .on(MSG.OPPORTUNITY_REJECT, async (payload) => {
    return rejectOpportunity(payload)
  })
  .on(MSG.SELECTOR_BROKEN, async (payload) => {
    return recordSelectorBreak(payload)
  })
  .on(MSG.SELECTOR_HEALTH, async (payload) => {
    return recordSelectorHealth(payload)
  })
  .on(MSG.MANUAL_REPLY_REQUEST, async (payload) => {
    return handleDraftRequest(payload)
  })
  .on(MSG.OWN_POSTS_COLLECTED, async (payload) => {
    const result = await ingestOwnPosts({ posts: payload.posts })
    // Le profil est reconstruit à chaque ingestion : le coût est nul (aucun appel LLM pour les
    // statistiques) et un corpus enrichi dont le profil n'a pas bougé serait trompeur.
    const built = await rebuildVoiceProfile()
    return { ...result, profile: built.profile ?? null }
  })
  .on(MSG.OWN_HANDLE_DETECTED, async (payload) => {
    // Détection proposée, jamais imposée : on l'enregistre seulement si aucun handle n'est
    // encore configuré. Écraser un handle confirmé par l'utilisateur ferait collecter le
    // corpus de quelqu'un d'autre après un changement de compte dans le navigateur.
    const repo = new ConfigRepo(db(), systemClock)
    const config = await repo.get()
    if (config.ownHandle !== null) {
      return { stored: false, current: config.ownHandle, suggested: payload.handle }
    }
    await repo.update({ ownHandle: payload.handle })
    return { stored: true, current: payload.handle, suggested: payload.handle }
  })
  .on(MSG.VOICE_PROFILE_STATUS, async () => {
    return voiceProfileStatus()
  })
  .on(MSG.VOICE_PROFILE_REBUILD, async () => {
    return rebuildVoiceProfile()
  })
  .on(MSG.KILL_SWITCH, async ({ reason }) => {
    const governor = await buildGovernor()
    await governor.engageKillSwitch(reason ?? 'demandé depuis le side panel')
    return { engaged: true }
  })
  .on(MSG.RESUME, async () => {
    const governor = await buildGovernor()
    await governor.releaseKillSwitch()
    return { engaged: false }
  })
  .on(MSG.LLM_SELFTEST, async ({ prompt }) => {
    return runLlmSelfTest(prompt)
  })
  .on(MSG.SWARM_STATE, async () => {
    return swarmStateSnapshot()
  })
  .on(MSG.ANALYTICS_STATE, async () => {
    return analyticsSnapshot()
  })
  .on(MSG.AUDIT_LIST, async ({ limit }) => {
    return listAudit(limit)
  })
  .on(MSG.CONSENT_ACCEPT, async () => {
    return acceptConsent()
  })
  .on(MSG.SETTINGS_STATUS, async () => {
    return settingsStatus()
  })
  .on(MSG.SETTINGS_UPDATE, async (patch) => {
    return updateSettings(patch)
  })
  .on(MSG.KEYSTORE_UNLOCK, async ({ passphrase }) => {
    return unlockKeystore(passphrase)
  })
  .on(MSG.KEYSTORE_LOCK, async () => {
    return lockKeystore()
  })
  .on(MSG.KEYSTORE_SET_KEY, async (payload) => {
    return setProviderKey(payload)
  })
  .on(MSG.KEYSTORE_REMOVE_KEY, async (payload) => {
    return removeProviderKey(payload)
  })

// **Premier geste effectif du module.** Tout ce qui suit peut échouer sans rendre le produit
// muet : les messages seront servis, et l'erreur sera visible dans l'UI.
router.start()
breadcrumb('listener-registered')

/* ─────────────────────── Écouteurs d'événements Chrome ─────────────────────── */

/**
 * Enregistrés de façon synchrone, eux aussi.
 *
 * MV3 réveille le worker sur un événement **seulement si** l'écouteur a été ajouté au niveau
 * supérieur du script, sans `await` avant. Un `await` ici et les alarmes ne réveilleraient plus
 * rien — la mesure J+1/J+7 et la purge de rétention s'arrêteraient sans erreur.
 */
chrome.runtime.onInstalled.addListener((details) => {
  void boot('onInstalled', async () => {
    await onInstalled(details)
    registerAlarms()
    await ensureOffscreen()
  })
})

chrome.runtime.onStartup.addListener(() => {
  void boot('onStartup', async () => {
    await onStartup()
    registerAlarms()
    await ensureOffscreen()
  })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  void boot(`alarm:${alarm.name}`, async () => {
    await handleAlarm(alarm.name)
  })
})

/**
 * Le kill switch est aussi un raccourci clavier : en cas de problème, l'utilisateur ne doit pas
 * avoir à trouver le bon onglet du side panel.
 */
chrome.commands?.onCommand.addListener((command) => {
  if (command === 'kill-switch') {
    void boot('kill-switch', () => killSwitchFromCommand())
  }
  if (command === 'open-panel') {
    void chrome.windows.getCurrent().then((w) => {
      if (w.id !== undefined) void chrome.sidePanel.open({ windowId: w.id })
    })
  }
})

// Ouvrir le side panel au clic sur l'icône, plutôt qu'un popup.
void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  /* API absente sur les Chrome plus anciens que le minimum déclaré */
})

/**
 * Exécute une tâche de démarrage en nommant l'échec au lieu de le laisser filer.
 *
 * Une exception non capturée dans un écouteur de service worker disparaît : pas de console
 * ouverte, pas d'utilisateur pour la voir. On la journalise donc explicitement — c'est la seule
 * trace qui restera d'une panne d'initialisation.
 */
async function boot(step: string, task: () => Promise<void>): Promise<void> {
  try {
    await task()
  } catch (e) {
    log.error('étape de démarrage en échec', {
      step,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
