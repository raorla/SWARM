/**
 * Alertes de rupture de sélecteur — SPEC §8, FEEDBACK MH-14.
 *
 * « Alerte utilisateur au lieu d'échec silencieux » demande trois choses, et les trois
 * comptent :
 *
 *  1. **Persister** la rupture, pour que l'onglet Config puisse l'afficher — l'utilisateur
 *     doit pouvoir comprendre pourquoi le produit s'est tu.
 *  2. **Notifier** une fois, pas à chaque post. Une notification par article rendrait
 *     l'alerte insupportable, donc désactivée, donc inutile.
 *  3. **Conserver le fragment anonymisé**, qui transforme la rupture en fixture de test.
 *
 * La notification est une permission optionnelle : si elle n'est pas accordée, on se replie
 * sur le badge de l'icône. Une alerte dégradée vaut mieux qu'une alerte absente.
 */
import { db } from '@/db'
import { createLogger } from '@/shared/logger'
import { DAY, systemClock, type Clock } from '@/shared/time'

const log = createLogger('background:selector-alerts')
/**
 * Horloge injectable (MH-17). Le refroidissement d'alerte est une logique temporelle : la
 * figer au niveau du module la rend intestable, et fait diverger le calcul de tout appelant
 * qui travaille sur une autre horloge.
 */
export interface AlertDeps {
  clock: Clock
}

const defaultDeps: AlertDeps = { clock: systemClock }

const STORAGE_KEY = 'swarm:selector-health'

export interface SelectorAlertState {
  /** Dernière rupture connue par nom de sélecteur. */
  breaks: Record<
    string,
    {
      firstSeenAtMs: number
      lastSeenAtMs: number
      surface: string
      consecutiveMisses: number
    }
  >
  /** Dernier fragment DOM anonymisé capturé, pour le diagnostic. */
  lastSnapshot: { selectorName: string; atMs: number; fragment: string } | null
  hitRate: number
  lastReportAtMs: number | null
  lastNotifiedAtMs: number | null
}

const EMPTY: SelectorAlertState = {
  breaks: {},
  lastSnapshot: null,
  hitRate: 1,
  lastReportAtMs: null,
  lastNotifiedAtMs: null,
}

async function readState(): Promise<SelectorAlertState> {
  const got = await chrome.storage.local.get(STORAGE_KEY)
  return (got[STORAGE_KEY] as SelectorAlertState | undefined) ?? EMPTY
}

async function writeState(state: SelectorAlertState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state })
}

/** Une notification par jour au maximum, tous sélecteurs confondus. */
const NOTIFY_COOLDOWN_MS = DAY

export async function recordSelectorBreak(
  payload: {
    selectorName: string
    surface: string
    consecutiveMisses: number
    anonymizedSnippet?: string | undefined
  },
  deps: AlertDeps = defaultDeps,
): Promise<{ acknowledged: true; alerted: boolean }> {
  const state = await readState()
  const now = deps.clock.now()
  const existing = state.breaks[payload.selectorName]

  state.breaks[payload.selectorName] = {
    firstSeenAtMs: existing?.firstSeenAtMs ?? now,
    lastSeenAtMs: now,
    surface: payload.surface,
    consecutiveMisses: payload.consecutiveMisses,
  }

  if (payload.anonymizedSnippet) {
    state.lastSnapshot = {
      selectorName: payload.selectorName,
      atMs: now,
      fragment: payload.anonymizedSnippet,
    }
  }

  const shouldNotify =
    state.lastNotifiedAtMs === null || now - state.lastNotifiedAtMs > NOTIFY_COOLDOWN_MS

  if (shouldNotify) state.lastNotifiedAtMs = now
  await writeState(state)

  await db()
    .auditLog.count()
    .catch(() => 0) // s'assure que la base est ouverte
  log.warn('rupture enregistrée', {
    selector: payload.selectorName,
    misses: payload.consecutiveMisses,
  })

  if (!shouldNotify) return { acknowledged: true, alerted: false }

  const alerted = await alertUser(payload.selectorName)
  return { acknowledged: true, alerted }
}

/**
 * Notifie, ou se replie sur le badge de l'icône.
 *
 * `notifications` est une permission optionnelle : la demander à l'installation pour un
 * cas qui se produit deux fois par an serait un mauvais signal en review CWS. Le badge
 * fonctionne sans permission et reste visible.
 */
async function alertUser(selectorName: string): Promise<boolean> {
  const badge = async (): Promise<void> => {
    // « ! » plutôt qu'un compteur : l'utilisateur n'a pas besoin de savoir combien de
    // sélecteurs sont cassés, il a besoin de savoir qu'il doit ouvrir le panel.
    await chrome.action.setBadgeText({ text: '!' }).catch(() => undefined)
    await chrome.action
      .setBadgeBackgroundColor({ color: '#f4212e' })
      .catch(() => undefined)
    await chrome.action
      .setTitle({ title: `SWARM — parsing de X cassé (${selectorName})` })
      .catch(() => undefined)
  }

  await badge()

  const granted = await chrome.permissions
    .contains({ permissions: ['notifications'] })
    .catch(() => false)
  if (!granted) return false

  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title: 'SWARM — parsing de X interrompu',
      message:
        `Le sélecteur « ${selectorName} » ne correspond plus au DOM de X. ` +
        'Le produit s’est arrêté au lieu de deviner. Ouvre le panel pour le détail.',
      priority: 2,
    })
    return true
  } catch (e) {
    log.debug('notification impossible', { error: e })
    return false
  }
}

/** Rapport périodique de santé, même quand tout va bien. */
export async function recordSelectorHealth(
  payload: {
    hitRate: number
    broken: readonly string[]
    surface: string
  },
  deps: AlertDeps = defaultDeps,
): Promise<{ acknowledged: true }> {
  const state = await readState()
  state.hitRate = payload.hitRate
  state.lastReportAtMs = deps.clock.now()

  // Un sélecteur qui remarche disparaît de la liste : sinon le badge resterait allumé
  // après un correctif de X, et l'utilisateur apprendrait à l'ignorer.
  if (payload.broken.length === 0 && Object.keys(state.breaks).length > 0) {
    state.breaks = {}
    await chrome.action.setBadgeText({ text: '' }).catch(() => undefined)
    await chrome.action.setTitle({ title: 'SWARM' }).catch(() => undefined)
    log.info('sélecteurs rétablis, alerte effacée')
  }

  await writeState(state)
  return { acknowledged: true }
}

/** Lu par l'onglet Config. */
export async function selectorHealthState(): Promise<SelectorAlertState> {
  return readState()
}
