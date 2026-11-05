/**
 * `Result<T, E>` — les frontières de SWARM ne lancent pas d'exceptions.
 *
 * Motivation concrète : un LLM qui renvoie du JSON malformé, un sélecteur DOM qui ne
 * matche plus ou un budget épuisé ne sont pas des bugs, ce sont des issues normales du
 * système. Les modéliser en valeurs force l'appelant à les traiter, alors qu'un `throw`
 * se propage jusqu'à un `catch` générique qui perd l'information.
 */

export type Ok<T> = { readonly ok: true; readonly value: T }
export type Err<E> = { readonly ok: false; readonly error: E }
export type Result<T, E = Error> = Ok<T> | Err<E>

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value })
export const err = <E>(error: E): Err<E> => ({ ok: false, error })

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok

export function map<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r
}

export function mapErr<T, E, F>(r: Result<T, E>, fn: (e: E) => F): Result<T, F> {
  return r.ok ? r : err(fn(r.error))
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback
}

/** Lance si `r` est une erreur. Réservé aux tests et aux invariants internes. */
export function expect<T, E>(r: Result<T, E>, message: string): T {
  if (r.ok) return r.value
  throw new Error(`${message}: ${String(r.error)}`)
}

/** Enveloppe une fonction qui peut lancer (API navigateur, JSON.parse, Dexie…). */
export async function attempt<T>(fn: () => T | Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn())
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}
