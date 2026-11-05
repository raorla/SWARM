/**
 * Réparation de JSON — SPEC §8 : « un LLM qui renvoie du JSON malformé ne doit jamais
 * casser l'app ».
 *
 * Stratégie en trois temps, du moins coûteux au plus coûteux :
 *   1. parsing direct ;
 *   2. réparations locales, gratuites — celles qui couvrent la grande majorité des cas
 *      réels (bloc markdown, texte avant/après, virgule traînante, guillemets typographiques) ;
 *   3. seulement en dernier recours, un second appel au modèle.
 *
 * L'ordre compte pour le budget : réparer localement coûte zéro, et c'est suffisant la
 * plupart du temps.
 */
import type { z } from 'zod'
import { err, ok, type Result } from '@/shared/result'

export interface RepairOutcome<T> {
  value: T
  /** Vrai si une réparation a été nécessaire — remonté comme métrique de qualité. */
  repaired: boolean
}

/** Retire une clôture markdown ```json … ``` */
function stripFence(text: string): string {
  const m = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  return m?.[1]?.trim() ?? text
}

/**
 * Isole **tous** les objets ou tableaux équilibrés du texte, dans l'ordre.
 *
 * Renvoyer seulement le premier ne suffit pas : un modèle bavard écrit volontiers
 * « la syntaxe {placeholder} n'est pas utilisée » avant le vrai JSON, et le premier
 * fragment équilibré est alors du bruit. On énumère donc les candidats et l'appelant les
 * essaie dans l'ordre.
 *
 * Le comptage tient compte des chaînes et des échappements : sans ça, une accolade à
 * l'intérieur d'une valeur JSON casserait l'équilibre.
 */
function extractBalanced(text: string): string[] {
  const out: string[] = []
  for (let start = 0; start < text.length; start++) {
    const open = text[start]
    if (open !== '{' && open !== '[') continue
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          out.push(text.slice(start, i + 1))
          // On saute au-delà du fragment trouvé : les sous-objets imbriqués ne sont pas
          // des candidats utiles, et les énumérer ferait exploser le coût sur un gros JSON.
          start = i
          break
        }
      }
    }
  }
  return out
}

function fixCommonSyntax(text: string): string {
  return (
    text
      // Guillemets typographiques : fréquents quand le modèle « rédige » du JSON.
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      // Virgules traînantes avant une fermeture.
      .replace(/,(\s*[}\]])/g, '$1')
      // Commentaires de style JS, que certains modèles ajoutent spontanément.
      .replace(/^\s*\/\/.*$/gm, '')
  )
}

/**
 * Candidats à essayer, du moins transformé au plus transformé. Ordonné par coût
 * décroissant de confiance : on préfère toujours interpréter le texte tel quel.
 */
function candidates(raw: string): string[] {
  const fenced = stripFence(raw)
  const seen = new Set<string>()
  const push = (s: string | undefined): void => {
    if (s === undefined) return
    const trimmed = s.trim()
    if (trimmed !== '') seen.add(trimmed)
  }

  push(raw)
  push(fenced)
  for (const b of extractBalanced(fenced)) push(b)
  for (const b of extractBalanced(raw)) push(b)
  push(fixCommonSyntax(fenced))
  for (const b of extractBalanced(fixCommonSyntax(fenced))) push(b)
  for (const b of extractBalanced(fenced)) push(fixCommonSyntax(b))

  return [...seen]
}

/**
 * Tente d'obtenir une valeur conforme à `schema` depuis un texte de modèle.
 * `repaired` est vrai dès qu'on a dû faire autre chose qu'un `JSON.parse` direct.
 */
export function repairAndParse<S extends z.ZodType>(
  raw: string,
  schema: S,
): Result<RepairOutcome<z.output<S>>, string[]> {
  const schemaIssues: string[] = []
  const syntaxIssues: string[] = []
  let sawValidJson = false

  for (const [index, candidate] of candidates(raw).entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch (e) {
      if (index === 0) {
        syntaxIssues.push(`parse direct: ${e instanceof Error ? e.message : String(e)}`)
      }
      continue
    }
    sawValidJson = true

    const result = schema.safeParse(parsed)
    if (result.success) return ok({ value: result.data, repaired: index > 0 })

    // JSON valide mais hors schéma. On garde l'écart au schéma — c'est l'information qui
    // sert à formuler la consigne de reprise — et on continue : un autre candidat du même
    // texte peut être le bon objet (le premier était peut-être un fragment de prose).
    schemaIssues.push(
      ...result.error.issues.map(
        (i) => `${i.path.join('.') || '(racine)'}: ${i.message}`,
      ),
    )
  }

  if (schemaIssues.length > 0) return err(dedupe(schemaIssues))
  if (!sawValidJson) {
    // Message d'abord : « aucun JSON exploitable » est plus actionnable qu'un
    // « Unexpected token » sur un texte qui n'a jamais prétendu être du JSON.
    return err(['aucun JSON exploitable dans la réponse', ...syntaxIssues])
  }
  return err(syntaxIssues.length > 0 ? syntaxIssues : ['réponse non conforme au schéma'])
}

function dedupe(issues: readonly string[]): string[] {
  return [...new Set(issues)]
}

/**
 * Consigne de reprise pour le second appel. Volontairement sèche et impérative : les
 * consignes polies produisent des préambules, qui sont exactement le problème à corriger.
 */
export function buildRepairInstruction(issues: readonly string[]): string {
  return [
    'Ta réponse précédente n’était pas exploitable.',
    issues.length > 0 ? `Problèmes : ${issues.slice(0, 8).join(' ; ')}.` : '',
    'Renvoie uniquement du JSON valide conforme au schéma demandé.',
    'Aucun texte avant, aucun texte après, aucun bloc de code markdown.',
  ]
    .filter(Boolean)
    .join(' ')
}
