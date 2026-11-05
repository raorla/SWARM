/**
 * Résolution des cascades de sélecteurs, avec télémétrie.
 *
 * C'est le seul point qui interroge le DOM de X. Chaque tentative est comptée, ce qui
 * transforme « le parsing ne marche plus » en « `post.text` ne matche plus depuis
 * 40 posts, voici le fragment DOM » — la différence entre une soirée de reproduction à
 * l'aveugle et une réparation de vingt minutes.
 */
import type { SelectorSpec } from './x-selectors'

export interface Resolution<T extends Element = Element> {
  el: T | null
  /** Index du candidat qui a matché. `-1` si aucun. */
  candidateIndex: number
}

/**
 * Rapport d'une tentative de résolution, consommé par `selector-health.ts`.
 * Séparé de la résolution elle-même pour que `query` reste testable sans état global.
 */
export interface AttemptReport {
  name: string
  hit: boolean
  candidateIndex: number
  /** Vrai si un candidat de repli a été nécessaire — signe précoce de dérive du DOM. */
  usedFallback: boolean
}

export type ReportSink = (report: AttemptReport) => void

/** Sink neutre, pour les tests et les appels de diagnostic. */
export const noopSink: ReportSink = () => undefined

/**
 * `:has()` n'est pas supporté partout et lance une `SyntaxError` sur les moteurs anciens.
 * Un sélecteur invalide ne doit pas faire échouer toute la cascade : on l'ignore et on
 * passe au suivant.
 */
function trySelect(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector)
  } catch {
    return null
  }
}

function trySelectAll(root: ParentNode, selector: string): Element[] {
  try {
    return [...root.querySelectorAll(selector)]
  } catch {
    return []
  }
}

export function queryOne<T extends Element = Element>(
  root: ParentNode,
  spec: SelectorSpec,
  report: ReportSink = noopSink,
): Resolution<T> {
  for (const [index, candidate] of spec.candidates.entries()) {
    const el = trySelect(root, candidate)
    if (el) {
      report({
        name: spec.name,
        hit: true,
        candidateIndex: index,
        usedFallback: index > 0,
      })
      return { el: el as T, candidateIndex: index }
    }
  }
  report({ name: spec.name, hit: false, candidateIndex: -1, usedFallback: false })
  return { el: null, candidateIndex: -1 }
}

/**
 * Union de **tous** les candidats, dédupliquée par identité de nœud.
 *
 * Le premier réflexe est de renvoyer les résultats du premier candidat qui matche, pour
 * éviter les doublons — deux sélecteurs de la cascade désignent souvent le même nœud, et
 * un post compté deux fois fausse le triage.
 *
 * Ce réflexe est faux ici, et c'est un test qui l'a montré : X déploie ses changements de
 * DOM **progressivement**. Pendant plusieurs jours, l'ancienne et la nouvelle structure
 * coexistent dans le même fil. « Premier candidat gagnant » ignorerait alors la moitié de
 * la timeline, en silence, sans qu'aucun sélecteur ne paraisse cassé — le pire mode de
 * défaillance possible pour ce module.
 *
 * On prend donc l'union, et un `Set` règle le problème des doublons.
 */
export function queryAll<T extends Element = Element>(
  root: ParentNode,
  spec: SelectorSpec,
  report: ReportSink = noopSink,
): { els: T[]; candidateIndex: number } {
  const found = new Set<Element>()
  let firstHitIndex = -1
  let usedFallback = false

  for (const [index, candidate] of spec.candidates.entries()) {
    const els = trySelectAll(root, candidate)
    if (els.length === 0) continue

    let addedSomething = false
    for (const el of els) {
      if (!found.has(el)) {
        found.add(el)
        addedSomething = true
      }
    }

    if (firstHitIndex === -1) {
      firstHitIndex = index
      // Le candidat préféré ne matche plus du tout : dérive franche du DOM.
      if (index > 0) usedFallback = true
    } else if (addedSomething) {
      // Un candidat secondaire apporte des nœuds que le préféré n'a pas trouvés : c'est
      // la signature d'un déploiement progressif en cours.
      usedFallback = true
    }
  }

  if (found.size === 0) {
    report({ name: spec.name, hit: false, candidateIndex: -1, usedFallback: false })
    return { els: [], candidateIndex: -1 }
  }

  report({ name: spec.name, hit: true, candidateIndex: firstHitIndex, usedFallback })

  // Ordre du document plutôt que d'insertion : le fil se traite de haut en bas, et l'ordre
  // d'ajout dans le Set suit les candidats, pas la page.
  const ordered = [...found].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  )
  return { els: ordered as T[], candidateIndex: firstHitIndex }
}

/** Existence seule, sans rapport de santé : pour les tests de présence optionnels. */
export function exists(root: ParentNode, spec: SelectorSpec): boolean {
  return spec.candidates.some((c) => trySelect(root, c) !== null)
}

/**
 * Convertit un compteur affiché par X en nombre.
 *
 * X abrège (`1.2K`, `3,4 M`), localise le séparateur décimal, et insère des espaces
 * insécables comme séparateur de milliers en français. Renvoyer `0` sur un format non
 * reconnu serait pire que `null` : le scoring de saturation prendrait un post à
 * 2 000 réponses pour un post frais.
 */
export function parseCompactNumber(raw: string | null | undefined): number | null {
  if (!raw) return null

  const cleaned = raw
    // U+00A0 (insécable), U+202F (fine insécable), U+2009 (fine) : X les emploie comme
    // séparateur de milliers en français. Échappés plutôt qu'insérés
    // littéralement — un caractère invisible dans une expression régulière est illisible
    // et se supprime par accident.
    .replace(/[\u00A0\u202F\u2009]/g, '')
    .replace(/\s/g, '')
    .trim()
  if (cleaned === '') return null

  const match = cleaned.match(/^([\d.,]+)\s*([KkMmBb])?$/)
  if (!match) return null

  const [, digitsRaw, suffix] = match
  if (digitsRaw === undefined) return null

  // Désambiguïser séparateur décimal et séparateur de milliers : « 1,234 » est mille deux
  // cent trente-quatre en anglais, « 1,2 » est un virgule deux en français. On tranche
  // sur le nombre de chiffres après le séparateur — trois chiffres = milliers.
  let normalized = digitsRaw
  const lastSep = Math.max(digitsRaw.lastIndexOf(','), digitsRaw.lastIndexOf('.'))
  if (lastSep !== -1) {
    const tail = digitsRaw.slice(lastSep + 1)
    normalized =
      tail.length === 3 && !suffix
        ? digitsRaw.replace(/[.,]/g, '')
        : digitsRaw.slice(0, lastSep).replace(/[.,]/g, '') + '.' + tail
  }

  const value = Number(normalized)
  if (!Number.isFinite(value)) return null

  const multiplier =
    suffix === undefined
      ? 1
      : ({ k: 1_000, m: 1_000_000, b: 1_000_000_000 }[suffix.toLowerCase()] ?? 1)
  return Math.round(value * multiplier)
}

/**
 * Extrait un compteur d'un bouton d'action.
 *
 * L'`aria-label` est privilégié parce qu'il porte le nombre **exact** (« 1234 replies »)
 * là où le texte visible est abrégé (« 1.2K ») : pour le scoring de saturation, la
 * précision compte.
 */
export function readMetric(button: Element | null): number | null {
  if (!button) return null

  const label = button.getAttribute('aria-label')
  if (label) {
    const exact = label.match(/([\d.,\u00A0\u202F\u2009\s]+)/)
    const parsed = parseCompactNumber(exact?.[1])
    if (parsed !== null) return parsed
  }

  const text = button.textContent?.trim()
  const fromText = parseCompactNumber(text)
  if (fromText !== null) return fromText

  // Un bouton sans compteur signifie zéro, pas « inconnu » : X n'affiche rien à zéro.
  return text === '' || text === undefined ? 0 : null
}
