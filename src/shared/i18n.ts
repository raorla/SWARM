/**
 * i18n minimal — FEEDBACK MH-11.
 *
 * Aucune dépendance : on a besoin d'interpolation et d'un fallback, pas d'un moteur de
 * pluralisation ICU. L'intérêt est d'exister *maintenant* : retrofiter l'i18n sur quatre
 * onglets et un onboarding coûte une semaine en Phase 8, l'ajouter ici coûte ce fichier.
 */

export type Locale = 'fr' | 'en'
export const LOCALES: readonly Locale[] = ['fr', 'en'] as const
export const DEFAULT_LOCALE: Locale = 'fr'

type Catalog = Record<string, string>

const fr: Catalog = {
  'app.name': 'SWARM',
  'tab.flux': 'Flux',
  'tab.swarm': 'Swarm',
  'tab.analytics': 'Analytics',
  'tab.config': 'Config',
  'mode.simulation': 'Simulation',
  'mode.copilot': 'Copilote',
  'mode.autopilot': 'Autopilote',
  'killswitch.label': 'Kill switch',
  'killswitch.engaged': 'Swarm arrêté — file vidée',
  'budget.today': 'Dépensé aujourd’hui',
  'budget.remaining': 'Budget restant',
  'budget.exhausted': 'Budget quotidien épuisé',
  'budget.reserved': 'Réserve qualité',
  'caps.replies': 'Réponses',
  'caps.posts': 'Posts',
  'permit.denied.killswitch': 'Kill switch actif',
  'permit.denied.cap': 'Plafond quotidien atteint',
  'permit.denied.window': 'Hors fenêtre active',
  'permit.denied.cadence': 'Cadence : trop tôt après la dernière action',
  'permit.denied.budget': 'Budget épuisé',
  'permit.denied.topic': 'Sujet écarté par le garde-fou',
  'permit.denied.simulation': 'Mode simulation : aucune action réelle',
  'permit.denied.dayoff': 'Jour de pause',
  'permit.granted': 'Autorisé',
}

const en: Catalog = {
  'app.name': 'SWARM',
  'tab.flux': 'Feed',
  'tab.swarm': 'Swarm',
  'tab.analytics': 'Analytics',
  'tab.config': 'Config',
  'mode.simulation': 'Simulation',
  'mode.copilot': 'Copilot',
  'mode.autopilot': 'Autopilot',
  'killswitch.label': 'Kill switch',
  'killswitch.engaged': 'Swarm halted — queue cleared',
  'budget.today': 'Spent today',
  'budget.remaining': 'Budget left',
  'budget.exhausted': 'Daily budget exhausted',
  'budget.reserved': 'Quality reserve',
  'caps.replies': 'Replies',
  'caps.posts': 'Posts',
  'permit.denied.killswitch': 'Kill switch engaged',
  'permit.denied.cap': 'Daily cap reached',
  'permit.denied.window': 'Outside active window',
  'permit.denied.cadence': 'Cadence: too soon after the last action',
  'permit.denied.budget': 'Budget exhausted',
  'permit.denied.topic': 'Topic blocked by the guard',
  'permit.denied.simulation': 'Simulation mode: no real action',
  'permit.denied.dayoff': 'Day off',
  'permit.granted': 'Granted',
}

const CATALOGS: Record<Locale, Catalog> = { fr, en }

let current: Locale = DEFAULT_LOCALE

export function setLocale(locale: Locale): void {
  current = locale
}
export function getLocale(): Locale {
  return current
}

/**
 * Traduit `key`, en interpolant `{nom}`.
 * Retourne la clé elle-même si elle est absente : une clé visible dans l'UI est un bug
 * qu'on voit, un texte vide est un bug qu'on ne voit pas.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = CATALOGS[current][key] ?? CATALOGS[DEFAULT_LOCALE][key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  )
}

/** Toutes les clés doivent exister dans tous les catalogues — vérifié en test. */
export function catalogKeys(): Record<Locale, string[]> {
  return { fr: Object.keys(fr), en: Object.keys(en) }
}
