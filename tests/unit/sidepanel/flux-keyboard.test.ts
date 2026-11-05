/**
 * @vitest-environment jsdom
 *
 * Navigation clavier du Flux — SPEC §8 : « accessibilité clavier complète sur le Flux ».
 *
 * Le bloc central est `isTypingTarget`. C'est la règle dont la défaillance serait la plus
 * coûteuse : avec des raccourcis d'une seule lettre, taper « rejeter » dans une note
 * rejetterait l'opportunité à la lettre `r`. Chaque type de champ est testé séparément.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  FLUX_BINDINGS,
  isTypingTarget,
  keyboardHelp,
  type FluxAction,
} from '@/sidepanel/hooks/useFluxKeyboard'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('isTypingTarget — la règle qui protège la saisie', () => {
  it('reconnaît un input', () => {
    document.body.innerHTML = '<input type="text" />'
    expect(isTypingTarget(document.querySelector('input'))).toBe(true)
  })

  it('reconnaît un textarea', () => {
    document.body.innerHTML = '<textarea></textarea>'
    expect(isTypingTarget(document.querySelector('textarea'))).toBe(true)
  })

  it('reconnaît un select', () => {
    document.body.innerHTML = '<select></select>'
    expect(isTypingTarget(document.querySelector('select'))).toBe(true)
  })

  it('reconnaît un contenteditable', () => {
    document.body.innerHTML = '<div contenteditable="true">texte</div>'
    const el = document.querySelector('div') as HTMLElement
    // jsdom n'implémente pas `isContentEditable` : on le simule pour tester notre logique.
    Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true })
    expect(isTypingTarget(el)).toBe(true)
  })

  it('reconnaît un role="textbox" — le motif des éditeurs riches', () => {
    document.body.innerHTML = '<div role="textbox">texte</div>'
    expect(isTypingTarget(document.querySelector('div'))).toBe(true)
  })

  it('ne bloque PAS sur un bouton ou un lien', () => {
    document.body.innerHTML = '<button>ok</button><a href="#">lien</a><p>texte</p>'
    expect(isTypingTarget(document.querySelector('button'))).toBe(false)
    expect(isTypingTarget(document.querySelector('a'))).toBe(false)
    expect(isTypingTarget(document.querySelector('p'))).toBe(false)
  })

  it('gère une cible absente ou non-élément', () => {
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(document)).toBe(false)
  })
})

describe('table des raccourcis', () => {
  it('couvre les quatre raccourcis exigés par la spec', () => {
    // `A` approuver · `E` éditer · `R` rejeter · `Espace` suivant.
    const byKey = new Map<string, FluxAction>()
    for (const binding of FLUX_BINDINGS) {
      for (const key of binding.keys) byKey.set(key, binding.action)
    }
    expect(byKey.get('a')).toBe('approve')
    expect(byKey.get('e')).toBe('edit')
    expect(byKey.get('r')).toBe('reject')
    expect(byKey.get(' ')).toBe('next')
  })

  it('n’associe jamais deux actions à la même touche', () => {
    // Une collision rendrait le comportement dépendant de l'ordre de la table.
    const seen = new Map<string, FluxAction>()
    for (const binding of FLUX_BINDINGS) {
      for (const key of binding.keys) {
        const existing = seen.get(key)
        if (existing !== undefined) {
          expect(existing, `touche « ${key} » en collision`).toBe(binding.action)
        }
        seen.set(key, binding.action)
      }
    }
  })

  it('propose des alternatives aux touches uniques', () => {
    // `J`/`K` et les flèches : naviguer sans agir est le geste le plus fréquent.
    const nextKeys = FLUX_BINDINGS.filter((b) => b.action === 'next').flatMap(
      (b) => b.keys,
    )
    expect(nextKeys).toContain('j')
    expect(nextKeys).toContain('ArrowDown')
    const prevKeys = FLUX_BINDINGS.filter((b) => b.action === 'previous').flatMap(
      (b) => b.keys,
    )
    expect(prevKeys).toContain('k')
    expect(prevKeys).toContain('ArrowUp')
  })

  it('permet de fermer au clavier', () => {
    const escape = FLUX_BINDINGS.find((b) => b.keys.includes('Escape'))
    expect(escape?.action).toBe('dismiss')
  })

  it('chaque liaison porte un libellé humain, pas un identifiant', () => {
    // Le libellé va dans l'aide affichée : « approve » n'y a pas sa place.
    for (const binding of FLUX_BINDINGS) {
      expect(binding.label.trim().length, binding.action).toBeGreaterThan(3)
      expect(binding.label, binding.action).not.toBe(binding.action)
      expect(binding.label, binding.action).toMatch(/^\p{Lu}/u)
    }
  })
})

describe('aide clavier', () => {
  it('est générée depuis la table — donc toujours exacte', () => {
    // Une aide écrite à la main finit toujours par mentir sur les raccourcis réels.
    const help = keyboardHelp()
    expect(help.length).toBeGreaterThan(4)
    const actions = new Set(FLUX_BINDINGS.map((b) => b.action))
    expect(help.length).toBe(actions.size)
  })

  it('rend les touches spéciales lisibles', () => {
    const help = keyboardHelp()
    const joined = help.map((row) => row.keys).join(' ')
    expect(joined).toContain('Espace')
    expect(joined).toContain('Échap')
    expect(joined).toContain('↓')
  })

  it('regroupe les alternatives sur une seule ligne', () => {
    const help = keyboardHelp()
    const nextRow = help.find((row) => row.label === 'Suivant')
    expect(nextRow?.keys).toContain('Espace')
    expect(nextRow?.keys).toContain('J')
  })
})
