/**
 * Réglages et coffre — les handlers dont dépend la première utilisation (Phase 4 / Phase 8).
 *
 * Sans cet écran, le produit était complet et **inutilisable** : le keystore chiffré, le
 * routage, le budget et les plafonds fonctionnaient tous, mais rien ne permettait de saisir
 * une clé ni de déverrouiller le coffre. C'est le genre de manque qu'aucun test unitaire ne
 * signale, puisque chaque pièce prise séparément est correcte.
 *
 * ## Deux règles tenues ici
 *
 *  1. **La passphrase ne traverse ce module que pour être consommée.** Elle n'est ni
 *     retournée, ni journalisée, ni conservée. Le logger redacte de toute façon la clé
 *     `passphrase`, mais on ne compte pas sur lui : rien ne l'écrit.
 *  2. **Aucun réglage ne peut relever un plafond au-delà du maximum de la spec.** Un champ de
 *     saisie qui accepterait 500 réponses par jour rendrait décoratifs tous les garde-fous du
 *     governor. Les bornes sont donc appliquées ici, côté service worker, et pas seulement
 *     dans l'attribut `max` d'un `<input>`.
 */
import { db } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { systemClock, type Clock } from '@/shared/time'
import { createLogger } from '@/shared/logger'
import { restoreKeystore } from './services'
import { getProvider, availableProviders } from '@/llm/providers'
import type { ProviderId } from '@/llm/types'
import type { MSG, PayloadOf } from '@/messaging/contract'
import type { ConfigRecord } from '@/db/schema'

const log = createLogger('background:settings')

/**
 * Plafonds durs. Un réglage ne peut pas les dépasser — c'est la traduction en code de
 * « plafonds journaliers en dur » (SPEC §4.6). Les valeurs sont celles de la spec, et le
 * `follow`/`dm` à zéro n'est pas un défaut : ces actions n'existent pas dans le produit.
 */
export const HARD_LIMITS = {
  reply: 40,
  post: 5,
  follow: 0,
  dm: 0,
  budgetEur: 10,
  cadenceMinMinutes: 2,
} as const

export interface SettingsStatus {
  keystore: {
    initialized: boolean
    unlocked: boolean
    providers: ProviderId[]
  }
  /** Providers implémentés, pour que l'UI ne propose pas ce qui n'existe pas. */
  available: { id: ProviderId; label: string; needsBaseUrl: boolean }[]
  config: ConfigRecord
  /** Permissions d'hôte déjà accordées, par provider. */
  granted: Partial<Record<ProviderId, boolean>>
}

export async function settingsStatus(clock: Clock = systemClock): Promise<SettingsStatus> {
  const keystore = await restoreKeystore()
  const config = await new ConfigRepo(db(), clock).get()

  const available = availableProviders().map((p) => ({
    id: p.id,
    label: p.label,
    needsBaseUrl: p.id === 'openai-compatible',
  }))

  const granted: Partial<Record<ProviderId, boolean>> = {}
  for (const provider of availableProviders()) {
    const origin = provider.originPattern({ providerId: provider.id, apiKey: '' })
    granted[provider.id] = await chrome.permissions.contains({ origins: [origin] })
  }

  return {
    keystore: {
      initialized: await keystore.isInitialized(),
      unlocked: keystore.isUnlocked,
      providers: [...keystore.configuredProviders()],
    },
    available,
    config,
    granted,
  }
}

/**
 * Enregistre le consentement d'onboarding (MH-12).
 *
 * Horodaté en base, jamais un simple booléen : la date sert au journal d'audit et permet de
 * redemander le consentement si les conditions changent. Idempotent — accepter deux fois ne
 * réécrit pas la première date, qui est celle qui compte.
 */
export async function acceptConsent(
  clock: Clock = systemClock,
): Promise<{ accepted: true; atMs: number }> {
  const repo = new ConfigRepo(db(), clock)
  const current = await repo.get()
  if (current.consentAcceptedAtMs === null) {
    await repo.acceptConsent()
    log.info('consentement enregistré')
  }
  const after = await repo.get()
  return { accepted: true, atMs: after.consentAcceptedAtMs ?? clock.now() }
}

export interface UnlockResult {
  unlocked: boolean
  /** Message prêt à afficher — jamais la cause cryptographique brute. */
  error: string | null
}

export async function unlockKeystore(passphrase: string): Promise<UnlockResult> {
  const keystore = await restoreKeystore()
  const result = await keystore.unlock(passphrase)
  if (result.ok) {
    log.info('coffre déverrouillé')
    return { unlocked: true, error: null }
  }
  // AES-GCM ne distingue pas mauvaise passphrase et données altérées : on ne prétend pas
  // le contraire, sinon l'utilisateur cherche le mauvais problème.
  const message =
    result.error.kind === 'not-initialized'
      ? 'Aucun coffre : enregistre d’abord une clé.'
      : result.error.kind === 'wrong-passphrase'
        ? 'Passphrase refusée, ou coffre altéré — les deux sont indistinguables.'
        : 'Coffre illisible.'
  return { unlocked: false, error: message }
}

export async function lockKeystore(): Promise<{ unlocked: false }> {
  const keystore = await restoreKeystore()
  await keystore.lock()
  log.info('coffre verrouillé')
  return { unlocked: false }
}

/**
 * Type dérivé du contrat de messagerie plutôt que redéclaré.
 *
 * Redéclarer la forme ici la ferait diverger du schéma Zod au premier changement, et sous
 * `exactOptionalPropertyTypes` la divergence se manifeste par une erreur de compilation à
 * l'appel — donc loin de la cause.
 */
export type SetKeyInput = PayloadOf<typeof MSG.KEYSTORE_SET_KEY>

export interface SetKeyResult {
  stored: boolean
  error: string | null
  /** Vrai si la permission d'hôte a été accordée pendant l'opération. */
  hostGranted: boolean
}

/**
 * Enregistre une clé de provider.
 *
 * La permission d'hôte n'est **pas** demandée ici : `chrome.permissions.request` exige un
 * geste utilisateur, et un message venant du side panel n'en est pas un du point de vue de
 * Chrome. L'UI la demande donc elle-même, avant d'envoyer ce message ; ce handler se contente
 * de constater si elle est là. Découvert en construisant l'écran — l'ordre inverse échoue
 * silencieusement, ce qui est le pire des deux mondes.
 */
export async function setProviderKey(input: SetKeyInput): Promise<SetKeyResult> {
  const provider = getProvider(input.providerId)
  if (provider === undefined) {
    return { stored: false, error: 'Provider non implémenté.', hostGranted: false }
  }
  if (input.providerId !== 'openai-compatible' && input.apiKey.trim().length === 0) {
    return { stored: false, error: 'Clé vide.', hostGranted: false }
  }
  if (input.passphrase.length < 8) {
    // Huit caractères est bas ; c'est un plancher, pas une recommandation. L'écran, lui,
    // explique ce que la passphrase protège et ce qu'elle ne protège pas.
    return {
      stored: false,
      error: 'Passphrase trop courte (8 caractères minimum).',
      hostGranted: false,
    }
  }

  const creds = {
    providerId: input.providerId,
    apiKey: input.apiKey.trim(),
    ...(input.baseUrl !== undefined && input.baseUrl.trim().length > 0
      ? { baseUrl: input.baseUrl.trim() }
      : {}),
  }

  const keystore = await restoreKeystore()
  if (!(await keystore.isInitialized())) {
    await keystore.initialize(input.passphrase, { [input.providerId]: creds })
  } else {
    const result = await keystore.setCredentials(creds, input.passphrase)
    if (!result.ok) {
      return {
        stored: false,
        error:
          result.error.kind === 'wrong-passphrase'
            ? 'Passphrase refusée : c’est celle du coffre existant qui est attendue.'
            : 'Écriture du coffre impossible.',
        hostGranted: false,
      }
    }
  }

  const origin = provider.originPattern(creds)
  const hostGranted = await chrome.permissions.contains({ origins: [origin] })
  log.info('clé enregistrée', { provider: input.providerId, hostGranted })
  return { stored: true, error: null, hostGranted }
}

export async function removeProviderKey(input: {
  providerId: ProviderId
  passphrase: string
}): Promise<{ removed: boolean; error: string | null }> {
  const keystore = await restoreKeystore()
  const result = await keystore.removeCredentials(input.providerId, input.passphrase)
  if (!result.ok) return { removed: false, error: 'Passphrase refusée.' }
  return { removed: true, error: null }
}

/* ─────────────────────────────── Réglages ─────────────────────────────────── */

export type ConfigPatch = PayloadOf<typeof MSG.SETTINGS_UPDATE>

/**
 * Applique un correctif de réglages, borné.
 *
 * `mode` n'accepte pas `'autopilot'` : le passage en autopilote a son propre chemin, avec
 * l'écran d'avertissement et la phrase à recopier (`AutopilotWarning.tsx`). Le laisser
 * passer par un champ ordinaire contournerait ce consentement — et l'autopilote n'est de
 * toute façon pas implémenté.
 */
export async function updateSettings(
  patch: ConfigPatch,
  clock: Clock = systemClock,
): Promise<{ config: ConfigRecord; clamped: string[] }> {
  const repo = new ConfigRepo(db(), clock)
  const current = await repo.get()
  const clamped: string[] = []

  const bound = (
    label: string,
    value: number | undefined,
    min: number,
    max: number,
    fallback: number,
  ): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback
    const next = Math.min(max, Math.max(min, value))
    if (next !== value) clamped.push(`${label} ramené à ${next}`)
    return next
  }

  const caps: Record<string, number> = {
    ...current.caps,
    reply: bound('réponses/jour', patch.capReply, 0, HARD_LIMITS.reply, current.caps['reply'] ?? 25),
    post: bound('posts/jour', patch.capPost, 0, HARD_LIMITS.post, current.caps['post'] ?? 3),
    // Non réglables : ces actions n'existent pas dans le produit (SPEC §4.6).
    follow: 0,
    dm: 0,
  }

  const cadenceMin = bound(
    'cadence min',
    patch.cadenceMinMinutes,
    HARD_LIMITS.cadenceMinMinutes,
    120,
    current.cadence.minMinutes,
  )
  const cadenceMax = bound(
    'cadence max',
    patch.cadenceMaxMinutes,
    cadenceMin + 1,
    240,
    Math.max(current.cadence.maxMinutes, cadenceMin + 1),
  )

  const next: Partial<ConfigRecord> = {
    caps,
    cadence: { minMinutes: cadenceMin, maxMinutes: cadenceMax },
    budget: {
      ...current.budget,
      dailyEur: bound(
        'budget/jour',
        patch.dailyBudgetEur,
        0,
        HARD_LIMITS.budgetEur,
        current.budget.dailyEur,
      ),
    },
    window: {
      ...current.window,
      startMinute: bound(
        'début de fenêtre',
        patch.windowStartMinute,
        0,
        1_439,
        current.window.startMinute,
      ),
      endMinute: bound('fin de fenêtre', patch.windowEndMinute, 1, 1_440, current.window.endMinute),
    },
    retentionDays: bound('rétention', patch.retentionDays, 1, 365, current.retentionDays),
    criticVetoThreshold: bound(
      'seuil de veto',
      patch.criticVetoThreshold,
      0,
      1,
      current.criticVetoThreshold,
    ),
  }

  if (patch.mode !== undefined) next.mode = patch.mode
  if (patch.draftMode !== undefined) next.draftMode = patch.draftMode
  if (patch.activeNichePackId !== undefined) next.activeNichePackId = patch.activeNichePackId

  await repo.update(next)
  if (clamped.length > 0) log.warn('réglages bornés', { clamped })
  return { config: await repo.get(), clamped }
}
