/**
 * Retry et repli — FEEDBACK MH-16.
 *
 * OpenRouter route vers des fournisseurs tiers dont la disponibilité n'est pas garantie.
 * Sans repli, une indisponibilité amont fige le swarm en silence, ce qui est le pire des
 * modes de défaillance : rien n'est cassé visiblement, rien ne fonctionne.
 */
import { LlmError } from './errors'
import { type Rng } from '@/shared/rng'
import type { Clock } from '@/shared/time'

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** Facteur de jitter appliqué au délai, dans [0, 1]. */
  jitter: number
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 800,
  maxDelayMs: 20_000,
  jitter: 0.3,
}

export function backoffDelayMs(
  policy: RetryPolicy,
  attempt: number,
  rng: Rng,
  retryAfterMs?: number,
): number {
  // Un `Retry-After` du provider fait autorité : deviner mieux que lui n'a pas de sens,
  // et l'ignorer garantit un second 429.
  if (retryAfterMs !== undefined) return Math.min(policy.maxDelayMs, retryAfterMs)
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(policy.maxDelayMs, exp)
  const spread = capped * policy.jitter
  return Math.max(0, capped - spread / 2 + rng.next() * spread)
}

export interface RetryDeps {
  rng: Rng
  clock: Clock
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

export function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmError('aborted', 'annulé avant attente'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new LlmError('aborted', 'annulé pendant attente'))
      },
      { once: true },
    )
  })
}

export interface AttemptContext {
  attempt: number
  /** Nombre total de tentatives prévues, tous providers confondus. */
  totalAttempts: number
}

/**
 * Exécute `fn` avec backoff, puis bascule sur `fallback` si tous les essais échouent.
 *
 * Le repli ne réessaie pas indéfiniment : il a droit à ses propres tentatives, mais on
 * n'enchaîne pas les chaînes de repli. Un système qui met deux minutes à conclure qu'il
 * ne peut pas répondre est moins utile qu'un système qui le dit en dix secondes.
 */
export async function withRetry<T>(
  fn: (ctx: AttemptContext) => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (signal?.aborted) throw new LlmError('aborted', 'annulé')
    try {
      return await fn({ attempt, totalAttempts: policy.maxAttempts })
    } catch (e) {
      lastError = e
      const isLast = attempt === policy.maxAttempts
      const retryable = e instanceof LlmError ? e.retryable : false
      if (!retryable || isLast) throw e
      const hint = e instanceof LlmError ? e.detail?.retryAfterMs : undefined
      await deps.sleep(backoffDelayMs(policy, attempt, deps.rng, hint), signal)
    }
  }
  // Inatteignable : la boucle renvoie ou lance. Présent pour le typage.
  throw lastError instanceof Error
    ? lastError
    : new LlmError('unknown', 'échec inattendu')
}
