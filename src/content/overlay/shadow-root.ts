/**
 * Racine Shadow DOM isolée.
 *
 * X change ses classes CSS à chaque déploiement. Un overlay qui partage la cascade de la
 * page casse dans les deux sens : nos styles fuient sur X, et les leurs cassent notre UI.
 * Le Shadow DOM supprime le problème par construction plutôt que par discipline de nommage.
 *
 * **Mode `open`, pas `closed`** — décision révisée après l'E2E. `closed` empêche seulement
 * de lire `.shadowRoot` depuis la page ; il n'empêche pas x.com de retirer notre nœud hôte,
 * donc il n'ajoute aucune sécurité réelle dans ce modèle de menace, et notre contenu n'est
 * pas secret. En revanche il coûte cher : Playwright ne traverse pas une racine fermée, ce
 * qui rend l'overlay intestable de bout en bout, et il gêne l'introspection des outils
 * d'accessibilité — alors que SPEC §8 exige une navigation clavier complète. L'isolation des
 * styles, qui est le seul bénéfice qu'on cherchait, est identique dans les deux modes.
 *
 * L'overlay est écrit en DOM natif, pas en React. Deux raisons : le poids embarqué dans le
 * content script est payé par le scroll de X (SPEC §8), et l'overlay est un bouton plus
 * une petite fiche — le coût d'un runtime de rendu n'est pas justifié par cette surface.
 * Le side panel, lui, reste en React : ce n'est pas la même contrainte.
 */

const HOST_ID = 'swarm-overlay-host'

/** Styles de l'overlay, alignés sur la palette de X pour ne pas paraître greffés. */
const STYLES = `
  :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  * { box-sizing: border-box; }

  .btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 9999px;
    border: 1px solid #2f3336; background: transparent;
    color: #71767b; font-size: 12px; line-height: 18px;
    cursor: pointer; transition: background .12s, color .12s, border-color .12s;
  }
  .btn:hover { background: rgba(29,155,240,.1); color: #1d9bf0; border-color: #1d9bf0; }
  .btn:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 2px; }
  .btn[disabled] { opacity: .5; cursor: default; }
  .btn.busy { color: #1d9bf0; border-color: #1d9bf0; }

  .card {
    margin-top: 8px; padding: 10px;
    border: 1px solid #2f3336; border-radius: 12px;
    background: #16181c; color: #e7e9ea; font-size: 13px; line-height: 1.45;
    max-width: 100%;
  }
  .card h4 {
    margin: 0 0 6px; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .06em; color: #71767b;
  }
  .draft {
    width: 100%; min-height: 72px; resize: vertical;
    padding: 8px; border-radius: 8px;
    border: 1px solid #2f3336; background: #000; color: #e7e9ea;
    font: inherit; line-height: 1.45;
  }
  .draft:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 1px; }

  .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .meta { font-size: 10px; color: #71767b; font-variant-numeric: tabular-nums; }
  .primary {
    padding: 5px 14px; border: none; border-radius: 9999px;
    background: #1d9bf0; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .primary:hover { background: #1a8cd8; }
  .primary:focus-visible { outline: 2px solid #e7e9ea; outline-offset: 2px; }
  .ghost {
    padding: 5px 12px; border: 1px solid #2f3336; border-radius: 9999px;
    background: transparent; color: #e7e9ea; font-size: 12px; cursor: pointer;
  }
  .ghost:hover { background: #202327; }
  .error { color: #f4212e; font-size: 12px; margin: 0; }
  .warn {
    color: #ffd400; font-size: 11px; margin: 6px 0 0;
    padding: 6px 8px; border-radius: 6px;
    background: rgba(255,212,0,.08); border: 1px solid rgba(255,212,0,.25);
  }
  .count { font-variant-numeric: tabular-nums; }
  .count.over { color: #f4212e; }
`

export interface OverlayRoot {
  shadow: ShadowRoot
  host: HTMLElement
  dispose(): void
}

/**
 * Crée — ou récupère — la racine partagée.
 *
 * Une seule racine pour tout l'overlay : créer un Shadow DOM par post coûterait une
 * feuille de style par carte, et X affiche des centaines de posts par session.
 */
export function ensureOverlayRoot(doc: Document = document): OverlayRoot {
  const existing = doc.getElementById(HOST_ID)
  if (existing?.shadowRoot) {
    return {
      shadow: existing.shadowRoot,
      host: existing,
      dispose: () => existing.remove(),
    }
  }

  const host = doc.createElement('div')
  host.id = HOST_ID
  // Le conteneur ne doit rien occuper : seules les cartes déplacées dans le fil ont une
  // taille. `position: fixed` évite qu'un `overflow: hidden` de X ne le rogne.
  host.style.cssText =
    'all: initial; position: fixed; width: 0; height: 0; z-index: 2147483000;'
  doc.documentElement.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })
  const style = doc.createElement('style')
  style.textContent = STYLES
  shadow.appendChild(style)

  return { shadow, host, dispose: () => host.remove() }
}

/**
 * Crée un point d'insertion à l'intérieur du fil de X, dont le contenu vient du Shadow DOM.
 *
 * Le Shadow DOM isole les styles mais ne peut pas *placer* un élément sous un post
 * particulier. On insère donc un conteneur léger dans la page, et on lui attache sa propre
 * racine d'ombre — l'isolation est conservée, le placement devient possible.
 */
export function createIsolatedSlot(doc: Document = document): {
  container: HTMLElement
  shadow: ShadowRoot
} {
  const container = doc.createElement('div')
  container.style.cssText = 'all: initial; display: block; width: 100%;'
  const shadow = container.attachShadow({ mode: 'open' })
  const style = doc.createElement('style')
  style.textContent = STYLES
  shadow.appendChild(style)
  return { container, shadow }
}
