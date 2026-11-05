/**
 * Logger avec redaction — FEEDBACK MH-08.
 *
 * « Les clés ne sont jamais loggées » (SPEC §3.1) est une intention tant que rien ne
 * l'applique. Ici la redaction est structurelle : on n'imprime que ce qui a survécu au
 * filtre, jamais l'objet d'origine. Un test unitaire échoue si un secret connu traverse.
 *
 * Menace concrète : un content script partage la console avec la page. Une clé API
 * imprimée là est lisible par n'importe quel script de x.com.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * Noms de champs dont la valeur est remplacée, quelle que soit la profondeur.
 * Liste volontairement large : le coût d'un faux positif est un log moins lisible,
 * le coût d'un faux négatif est une clé exposée.
 */
const REDACTED_KEYS = [
  'apikey',
  'api_key',
  'key',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'passphrase',
  'password',
  'passwd',
  'credential',
  'credentials',
  'cookie',
  'session',
  'bearer',
  'privatekey',
  'private_key',
  'salt',
  'iv',
  'wrappedkey',
  'ciphertext',
]

/**
 * Motifs de secrets reconnaissables dans du texte libre — un secret concaténé dans un
 * message d'erreur n'est pas protégé par le filtre de clés.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g, // OpenRouter
  /sk-proj-[A-Za-z0-9_-]{8,}/g, // OpenAI (projet)
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI (legacy)
  /xai-[A-Za-z0-9]{20,}/g, // xAI
  /AIza[A-Za-z0-9_-]{30,}/g, // Google
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
]

export const REDACTED = '«redacted»'
const MAX_DEPTH = 6
const MAX_STRING = 2_000

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z_]/g, '')
  return REDACTED_KEYS.some((s) => k === s || k.endsWith(s) || k.startsWith(s))
}

function scrubString(s: string): string {
  let out = s
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED)
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[tronqué]` : out
}

/**
 * Reconstruit une valeur sûre. On ne mute jamais l'entrée : les appelants passent
 * souvent des objets encore utilisés par ailleurs.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'function') return '«function»'
  if (typeof value === 'symbol') return value.toString()

  if (depth >= MAX_DEPTH) return '«profondeur max»'

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      // La stack peut contenir des URL avec des paramètres de requête.
      stack: value.stack ? scrubString(value.stack) : undefined,
    }
  }

  // Les données binaires n'ont aucune valeur de diagnostic et sont souvent du matériel
  // cryptographique.
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `«binaire ${(value as ArrayBufferView).byteLength ?? 0}o»`
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '«cycle»'
    seen.add(value)

    if (Array.isArray(value)) {
      return value.slice(0, 50).map((v) => redact(v, depth + 1, seen))
    }
    if (value instanceof Map) {
      return Object.fromEntries(
        [...value.entries()]
          .slice(0, 50)
          .map(([k, v]) => [
            String(k),
            isSensitiveKey(String(k)) ? REDACTED : redact(v, depth + 1, seen),
          ]),
      )
    }
    if (value instanceof Set) {
      return [...value].slice(0, 50).map((v) => redact(v, depth + 1, seen))
    }

    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1, seen)
    }
    return out
  }

  return '«inconnu»'
}

export interface LoggerOptions {
  scope: string
  level?: LogLevel
  /** Cible de sortie. Substituable pour les tests. */
  sink?: (level: LogLevel, scope: string, message: string, fields: unknown) => void
}

const consoleSink = (
  level: LogLevel,
  scope: string,
  message: string,
  fields: unknown,
): void => {
  const prefix = `[swarm:${scope}]`
  const args = fields === undefined ? [prefix, message] : [prefix, message, fields]
  switch (level) {
    case 'debug':
      console.debug(...args)
      break
    case 'info':
      console.info(...args)
      break
    case 'warn':
      console.warn(...args)
      break
    case 'error':
      console.error(...args)
      break
  }
}

export class Logger {
  private readonly scope: string
  private readonly min: number
  private readonly sink: NonNullable<LoggerOptions['sink']>

  constructor(opts: LoggerOptions) {
    this.scope = opts.scope
    this.min = LEVEL_ORDER[opts.level ?? 'info']
    this.sink = opts.sink ?? consoleSink
  }

  child(subScope: string): Logger {
    const level = (Object.keys(LEVEL_ORDER) as LogLevel[]).find(
      (l) => LEVEL_ORDER[l] === this.min,
    )
    return new Logger({
      scope: `${this.scope}:${subScope}`,
      sink: this.sink,
      ...(level === undefined ? {} : { level }),
    })
  }

  private emit(level: LogLevel, message: string, fields?: unknown): void {
    if (LEVEL_ORDER[level] < this.min) return
    this.sink(
      level,
      this.scope,
      scrubString(message),
      fields === undefined ? undefined : redact(fields),
    )
  }

  debug(message: string, fields?: unknown): void {
    this.emit('debug', message, fields)
  }
  info(message: string, fields?: unknown): void {
    this.emit('info', message, fields)
  }
  warn(message: string, fields?: unknown): void {
    this.emit('warn', message, fields)
  }
  error(message: string, fields?: unknown): void {
    this.emit('error', message, fields)
  }
}

export const createLogger = (scope: string, level?: LogLevel): Logger =>
  new Logger(level === undefined ? { scope } : { scope, level })
