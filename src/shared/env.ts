/**
 * Environnement d'exécution — FEEDBACK MH-15.
 *
 * Le développement de ce produit se fait sur un vrai compte X. Le mode par défaut en
 * dev est donc `simulation` : le governor refuse toute écriture DOM. Agir sur un vrai
 * compte demande un opt-in explicite et persistant.
 */

export type RunMode = 'simulation' | 'copilot' | 'autopilot'

/**
 * `autopilot` est déclaré dans le type parce que la machine à états et la config
 * doivent le connaître dès maintenant. Le code qui le mettrait en œuvre — la
 * soumission d'un post — n'existe pas et n'existera pas avant la Phase 8 (SPEC §4.6).
 * Cette constante permet de le vérifier en test.
 */
export const AUTOPILOT_IMPLEMENTED = false

export const IS_DEV = import.meta.env?.MODE !== 'production'

/** Mode par défaut : simulation en dev, copilote en production. */
export const DEFAULT_RUN_MODE: RunMode = IS_DEV ? 'simulation' : 'copilot'

export interface BuildInfo {
  version: string
  mode: 'development' | 'production'
}

export const buildInfo: BuildInfo = {
  version: '0.1.0',
  mode: IS_DEV ? 'development' : 'production',
}

/** Contexte d'extension courant — utile au routage des messages et aux logs. */
export type ExtensionContext =
  'background' | 'sidepanel' | 'content' | 'offscreen' | 'test' | 'unknown'

export function detectContext(): ExtensionContext {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return 'test'
  if (typeof window === 'undefined') return 'background'
  const href = globalThis.location?.href ?? ''
  if (href.includes('sidepanel')) return 'sidepanel'
  if (href.includes('offscreen')) return 'offscreen'
  if (href.startsWith('http')) return 'content'
  return 'unknown'
}
