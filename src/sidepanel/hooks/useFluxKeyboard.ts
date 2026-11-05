/**
 * Navigation clavier du Flux — SPEC §6 et §8.
 *
 * « Accessibilité clavier complète sur le Flux (c'est l'écran où l'utilisateur passe son
 * temps) ». La conséquence pratique : **la souris ne doit jamais être nécessaire**, et les
 * raccourcis doivent être inertes là où l'utilisateur écrit.
 *
 * Raccourcis de la spec : `A` approuver · `E` éditer · `R` rejeter · `Espace` suivant.
 * Ajoutés parce que l'écran s'y prête : `J`/`K` et les flèches pour naviguer sans agir,
 * `?` pour l'aide, `Échap` pour refermer.
 *
 * ## La règle qui évite le pire bug de cet écran
 *
 * Un raccourci d'une seule lettre est un piège dès qu'il y a un champ de saisie : taper
 * « rejeter » dans une note rejetterait l'opportunité à la lettre `r`. Tous les raccourcis
 * sont donc **désactivés dans un `input`, un `textarea` ou un élément éditable**, sans
 * exception — et c'est vérifié par un test.
 */
import { useEffect, useRef } from 'react'

export type FluxAction =
  | 'approve'
  | 'edit'
  | 'reject'
  | 'next'
  | 'previous'
  | 'open'
  | 'toggleBreakdown'
  | 'help'
  | 'dismiss'

export interface FluxKeyBinding {
  keys: readonly string[]
  action: FluxAction
  /** Libellé affiché dans l'aide. */
  label: string
}

/**
 * Table des raccourcis.
 *
 * Exportée pour que l'aide affichée soit **générée depuis la même source** que le
 * comportement. Une aide écrite à la main finit toujours par mentir.
 */
export const FLUX_BINDINGS: readonly FluxKeyBinding[] = [
  { keys: ['a'], action: 'approve', label: 'Rédiger une réponse' },
  { keys: ['e'], action: 'edit', label: 'Rédiger avec une consigne' },
  { keys: ['r'], action: 'reject', label: 'Rejeter' },
  { keys: [' '], action: 'next', label: 'Suivant' },
  { keys: ['j', 'ArrowDown'], action: 'next', label: 'Suivant' },
  { keys: ['k', 'ArrowUp'], action: 'previous', label: 'Précédent' },
  { keys: ['o', 'Enter'], action: 'open', label: 'Ouvrir le post sur X' },
  { keys: ['d'], action: 'toggleBreakdown', label: 'Décomposé du score' },
  { keys: ['?'], action: 'help', label: 'Aide' },
  { keys: ['Escape'], action: 'dismiss', label: 'Fermer' },
]

/**
 * Un raccourci doit-il être ignoré parce que l'utilisateur est en train d'écrire ?
 *
 * Exportée et testée séparément : c'est la règle dont la défaillance serait la plus coûteuse
 * — perdre une note en cours de frappe, ou rejeter une opportunité en tapant un mot.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  // Un `role="textbox"` sur un div est le motif des éditeurs riches : il compte aussi.
  return target.getAttribute('role') === 'textbox'
}

export interface UseFluxKeyboardOptions {
  enabled: boolean
  onAction: (action: FluxAction) => void
}

export function useFluxKeyboard(options: UseFluxKeyboardOptions): void {
  // On garde le callback dans une ref : sans ça, chaque rendu du parent réinstallerait
  // l'écouteur, et une touche pressée pendant le remplacement serait perdue.
  const handlerRef = useRef(options.onAction)
  handlerRef.current = options.onAction

  const enabledRef = useRef(options.enabled)
  enabledRef.current = options.enabled

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!enabledRef.current) return
      if (isTypingTarget(event.target)) return
      // Une combinaison avec un modificateur appartient au navigateur ou au système :
      // intercepter Ctrl+R rechargerait autre chose que ce que l'utilisateur voulait.
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const binding = FLUX_BINDINGS.find((b) => b.keys.includes(event.key))
      if (!binding) return

      // `Espace` fait défiler la page par défaut : sur un écran piloté au clavier, ce
      // défilement parasite désoriente plus qu'il n'aide.
      event.preventDefault()
      handlerRef.current(binding.action)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

/** Aide affichable, générée depuis la table — donc toujours exacte. */
export function keyboardHelp(): readonly { keys: string; label: string }[] {
  const seen = new Set<FluxAction>()
  const rows: { keys: string; label: string }[] = []

  for (const binding of FLUX_BINDINGS) {
    if (seen.has(binding.action)) {
      // Deuxième liaison pour la même action : on l'ajoute à la ligne existante plutôt que
      // de créer un doublon.
      const existing = rows.find((r) => r.label === binding.label)
      if (existing) existing.keys += ` / ${binding.keys.map(prettyKey).join(' ')}`
      continue
    }
    seen.add(binding.action)
    rows.push({ keys: binding.keys.map(prettyKey).join(' / '), label: binding.label })
  }
  return rows
}

function prettyKey(key: string): string {
  switch (key) {
    case ' ':
      return 'Espace'
    case 'ArrowDown':
      return '↓'
    case 'ArrowUp':
      return '↑'
    case 'Enter':
      return 'Entrée'
    case 'Escape':
      return 'Échap'
    default:
      return key.toUpperCase()
  }
}
