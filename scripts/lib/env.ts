/**
 * Chargement du `.env` — **pour les scripts Node uniquement**.
 *
 * ## Pourquoi ce fichier n'est pas dans `src/`
 *
 * L'extension ne lit jamais de `.env`. Sa clé vit chiffrée dans `chrome.storage.local`,
 * saisie par l'utilisateur (SPEC §3.1). Un `.env` lu au build serait **inliné dans le
 * bundle**, donc expédié dans le zip du Chrome Web Store — c'est-à-dire une clé publiée.
 *
 * Deux protections, parce qu'une seule se contourne par distraction :
 *
 *  1. Aucune variable n'est préfixée `VITE_`. Vite n'expose au client que celles-là ; une clé
 *     nommée `VITE_OPENROUTER_KEY` atterrirait dans `dist/` sans qu'aucun code ne la demande.
 *  2. `tests/unit/security/no-secret-in-bundle.test.ts` lit `dist/` quand il existe et échoue
 *     si un motif de clé y apparaît.
 *
 * Ce module sert donc aux **scripts de mesure** : R-03 (propagation du cache de prompt), coût
 * réel du triage, calibration du CRITIC. Ils font de vrais appels payants, d'où le plafond.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ScriptEnv {
  openRouterKey: string | null
  /** Plafond local de dépense d'un script, en euros. */
  budgetEur: number
  localBaseUrl: string | null
}

/**
 * Parse un `.env` minimal : `CLÉ=valeur`, commentaires `#`, lignes vides ignorées.
 *
 * Écrit à la main plutôt que via `dotenv` : une dépendance de plus pour trente lignes, dans
 * un projet dont l'argument de vente est de ne rien laisser fuir. Les guillemets encadrants
 * sont retirés parce que les coller est le réflexe le plus courant, et qu'une clé entre
 * guillemets échoue côté API avec un message qui ne dit pas pourquoi.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) out[key] = value
  }
  return out
}

/** Variables du processus prioritaires sur le fichier : c'est ce qu'attend une CI. */
export function loadEnv(cwd = process.cwd()): ScriptEnv {
  const path = join(cwd, '.env')
  const fromFile = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {}
  const read = (key: string): string | undefined =>
    process.env[key] !== undefined && process.env[key] !== ''
      ? process.env[key]
      : fromFile[key]

  const key = read('SWARM_OPENROUTER_KEY')?.trim()
  const budget = Number(read('SWARM_SCRIPT_BUDGET_EUR') ?? '0.5')

  return {
    openRouterKey: key !== undefined && key.length > 0 ? key : null,
    budgetEur: Number.isFinite(budget) && budget > 0 ? budget : 0.5,
    localBaseUrl: read('SWARM_LOCAL_BASE_URL') ?? null,
  }
}

/**
 * Motif d'une clé OpenRouter, pour valider **la forme** avant de dépenser un appel.
 *
 * Une clé tronquée au copier-coller échoue avec un HTTP 401 dont le message ne dit pas
 * « ta clé est tronquée » — on préfère le dire ici.
 */
export const OPENROUTER_KEY_PATTERN = /^sk-or-v1-[A-Za-z0-9]{32,}$/

export interface KeyCheck {
  ok: boolean
  reason: string | null
}

export function checkOpenRouterKey(key: string | null): KeyCheck {
  if (key === null) {
    return {
      ok: false,
      reason:
        'aucune clé : copie `.env.example` en `.env` et renseigne SWARM_OPENROUTER_KEY ' +
        '(https://openrouter.ai/settings/keys).',
    }
  }
  if (key.includes(' ')) {
    return { ok: false, reason: 'la clé contient un espace — copier-coller incomplet ?' }
  }
  if (!key.startsWith('sk-or-v1-')) {
    return {
      ok: false,
      reason: `la clé ne commence pas par « sk-or-v1- » (reçu « ${key.slice(0, 9)}… »). ` +
        "Est-ce une clé Anthropic ou OpenAI plutôt qu'OpenRouter ?",
    }
  }
  if (!OPENROUTER_KEY_PATTERN.test(key)) {
    return { ok: false, reason: 'la clé a le bon préfixe mais une longueur inattendue — tronquée ?' }
  }
  return { ok: true, reason: null }
}

/**
 * Empreinte affichable d'une clé : 4 premiers et 4 derniers caractères.
 *
 * Sert à confirmer *quelle* clé est utilisée sans l'écrire. Jamais plus de 8 caractères
 * révélés, et jamais dans un fichier — seulement sur la sortie du terminal de l'auteur.
 */
export function keyFingerprint(key: string): string {
  if (key.length < 12) return '(clé trop courte)'
  return `${key.slice(0, 12)}…${key.slice(-4)}`
}
