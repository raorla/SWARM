/**
 * Aides Zod pour les frontières — SPEC §8.
 *
 * Règle du produit : rien de non validé ne franchit une frontière (LLM, DOM, storage,
 * messages inter-contextes). Ces helpers rendent le chemin validé plus court à écrire
 * que le chemin non validé — c'est la seule façon fiable de faire tenir une convention.
 */
import { z } from 'zod'
import { err, ok, type Result } from './result'

export interface ParseFailure {
  readonly kind: 'validation'
  /** Frontière concernée, pour le diagnostic : 'llm:critic', 'dom:post', 'msg:STAGE'. */
  readonly boundary: string
  readonly issues: readonly string[]
  readonly received?: unknown
}

/** Parse sans lancer. `boundary` sert au diagnostic, pas au contrôle de flux. */
export function parseAt<S extends z.ZodType>(
  boundary: string,
  schema: S,
  input: unknown,
): Result<z.output<S>, ParseFailure> {
  const r = schema.safeParse(input)
  if (r.success) return ok(r.data)
  return err({
    kind: 'validation',
    boundary,
    issues: r.error.issues.map((i) => `${i.path.join('.') || '(racine)'}: ${i.message}`),
  })
}

/**
 * Parse du JSON textuel — le cas des réponses LLM.
 * Sépare volontairement « JSON illisible » de « JSON lisible mais hors schéma » : la
 * réparation à tenter n'est pas la même (voir llm/json-repair.ts).
 */
export function parseJsonAt<S extends z.ZodType>(
  boundary: string,
  schema: S,
  raw: string,
): Result<z.output<S>, ParseFailure> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return err({
      kind: 'validation',
      boundary,
      issues: [`JSON illisible: ${e instanceof Error ? e.message : String(e)}`],
    })
  }
  return parseAt(boundary, schema, parsed)
}

export function formatFailure(f: ParseFailure): string {
  return `[${f.boundary}] ${f.issues.join(' · ')}`
}

/** Handle X sans le `@`, tel que stocké partout dans la base. */
export const HandleSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .min(1)
      .max(15)
      .regex(/^[A-Za-z0-9_]+$/, 'handle X invalide'),
  )

/** Identifiant de post X : un entier décimal en chaîne (snowflake). */
export const XPostIdSchema = z
  .string()
  .regex(/^\d{5,25}$/, 'identifiant de post invalide')

export const IsoDateSchema = z.string().datetime()
export const UnixMillisSchema = z.number().int().nonnegative()

/** Score borné [0, 1] — utilisé par le scoring EV et les notes du CRITIC. */
export const UnitScoreSchema = z.number().min(0).max(1)

export const LangSchema = z.string().min(2).max(8)
