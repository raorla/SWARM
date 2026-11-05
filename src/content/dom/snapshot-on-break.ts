/**
 * Capture de fragment DOM anonymisé — FEEDBACK MH-14.
 *
 * Une alerte sans preuve oblige à reproduire le bug à l'aveugle. Un fragment anonymisé
 * transforme une rupture en fixture de test, c'est-à-dire une réparation de vingt minutes
 * au lieu d'une soirée. Vu que le DOM de X est le premier risque de maintenance du
 * produit, c'est l'outil qui se rentabilise le plus vite.
 *
 * L'anonymisation est faite **dans le content script**, avant que le fragment ne quitte
 * la page : le service worker ne doit jamais recevoir de contenu de tiers identifiable.
 * C'est aussi ce qui rend le fragment partageable dans un rapport de bug.
 */

/** Attributs conservés : ce sont eux qui portent la structure que nos sélecteurs visent. */
const KEPT_ATTRIBUTES = new Set([
  'data-testid',
  'role',
  'aria-selected',
  'aria-expanded',
  'contenteditable',
  'dir',
  'lang',
  'type',
  'tabindex',
])

/** Profondeur maximale conservée — au-delà, c'est du rendu, pas de la structure. */
const MAX_DEPTH = 12
const MAX_LENGTH = 20_000

function anonymizeHref(href: string): string {
  // On garde la *forme* du chemin, qui est ce que nos sélecteurs exploitent
  // (`/handle/status/id`), et on remplace les identifiants.
  if (/\/status\/\d+/.test(href)) return '/user/status/0000000000000000000'
  if (/^\/[A-Za-z0-9_]{1,15}$/.test(href)) return '/user'
  if (href.startsWith('http')) return 'https://example.invalid/'
  return '/redacted'
}

function anonymizeText(text: string): string {
  // Longueur préservée à peu près, contenu détruit : la longueur influence parfois la
  // structure (troncature, « Show more »), le contenu jamais.
  const trimmed = text.trim()
  if (trimmed === '') return text
  if (/^[\d.,KkMmBb\s]+$/.test(trimmed)) return trimmed // les compteurs sont anonymes
  return 'x'.repeat(Math.min(trimmed.length, 40))
}

function anonymizeAriaLabel(label: string): string {
  // Un aria-label contient souvent « 12 replies, 34 likes » : les nombres sont utiles au
  // débogage du parsing de métriques et ne sont pas identifiants.
  return label.replace(/[^\d\s,.]+/g, (m) =>
    m.trim() === '' ? m : 'x'.repeat(Math.min(m.length, 12)),
  )
}

/**
 * Reconstruit un fragment HTML anonymisé.
 *
 * On rebâtit au lieu de nettoyer une copie : partir d'un `cloneNode` puis retirer des
 * choses laisse invariablement passer un attribut oublié, et l'oubli n'est visible qu'une
 * fois le fragment sorti.
 */
export function anonymizeElement(el: Element, depth = 0): string {
  if (depth > MAX_DEPTH) return '<!-- profondeur max -->'

  const tag = el.tagName.toLowerCase()
  const attrs: string[] = []

  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase()
    if (KEPT_ATTRIBUTES.has(name)) {
      attrs.push(`${name}="${escapeAttr(attr.value)}"`)
    } else if (name === 'href') {
      attrs.push(`href="${escapeAttr(anonymizeHref(attr.value))}"`)
    } else if (name === 'aria-label') {
      attrs.push(`aria-label="${escapeAttr(anonymizeAriaLabel(attr.value))}"`)
    } else if (name === 'datetime') {
      // La forme de la date importe au parsing, sa valeur non.
      attrs.push('datetime="2026-01-01T00:00:00.000Z"')
    }
    // Tout le reste — classes générées, styles, identifiants — est écarté.
  }

  const open = attrs.length > 0 ? `<${tag} ${attrs.join(' ')}>` : `<${tag}>`

  const children: string[] = []
  for (const node of [...el.childNodes]) {
    if (node.nodeType === 3 /* Text */) {
      const anon = anonymizeText(node.textContent ?? '')
      if (anon.trim() !== '') children.push(escapeText(anon))
    } else if (node.nodeType === 1 /* Element */) {
      children.push(anonymizeElement(node as Element, depth + 1))
    }
  }

  return `${open}${children.join('')}</${tag}>`
}

const escapeAttr = (s: string): string => s.replace(/"/g, '&quot;').replace(/</g, '&lt;')
const escapeText = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Capture le contexte d'une rupture : le conteneur de post le plus proche, ou la racine
 * donnée. Renvoie `null` si rien d'exploitable n'a été trouvé — mieux que d'envoyer un
 * fragment vide qui laisserait croire à une capture réussie.
 */
export function captureBreakContext(root: Element | null): string | null {
  if (!root) return null
  const anonymized = anonymizeElement(root)
  if (anonymized.length > MAX_LENGTH) {
    return `${anonymized.slice(0, MAX_LENGTH)}\n<!-- tronqué -->`
  }
  return anonymized
}

/**
 * Vérifie qu'un fragment ne contient plus rien d'identifiant.
 * Utilisé en test, et appelé avant l'envoi : une capture qui fuit serait pire que pas de
 * capture, parce qu'elle transforme un outil de débogage en canal d'exfiltration.
 */
export function containsIdentifiableData(fragment: string): boolean {
  return (
    /@[A-Za-z0-9_]{2,15}/.test(fragment) ||
    /\/status\/(?!0{19})\d{10,}/.test(fragment) ||
    /class="/.test(fragment) ||
    /style="/.test(fragment) ||
    /https?:\/\/(?!example\.invalid)/.test(fragment)
  )
}
