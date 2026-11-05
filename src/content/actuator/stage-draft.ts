/**
 * ACTUATOR — écrit un brouillon dans le composeur de X, et s'arrête là.
 *
 * **Ce fichier ne soumet jamais rien.** Il n'existe aucun appel qui clique « Publier »,
 * et ce n'est pas un réglage désactivé : le code n'est pas écrit (SPEC §4.6). Un
 * commentaire ne suffirait pas à garantir ça, c'est pourquoi un test vérifie que ce module
 * ne référence même pas le sélecteur du bouton de soumission.
 *
 * Le problème technique réel : X utilise un éditeur `contenteditable` piloté par un état
 * interne. Affecter `textContent` change le DOM sans prévenir l'éditeur, qui écrase la
 * modification au premier rendu — le texte apparaît puis disparaît. Il faut passer par les
 * mêmes événements qu'une frappe humaine, et **vérifier que le texte a survécu**.
 */
import { COMPOSER_EDITOR } from '../dom/x-selectors'
import { queryOne, type ReportSink } from '../dom/query'
import { noopSink } from '../dom/query'
import { err, ok, type Result } from '@/shared/result'
import { createLogger } from '@/shared/logger'

const log = createLogger('content:actuator')

export type StageError =
  | { kind: 'no-editor'; detail: string }
  | { kind: 'write-failed'; attempted: readonly string[] }
  | { kind: 'verification-failed'; expected: string; found: string }
  | { kind: 'invalid-permit'; detail: string }

export interface StageOptions {
  text: string
  /** Jeton émis par le governor. Sans lui, l'actuator refuse d'agir. */
  permitToken: string
  root?: ParentNode
  report?: ReportSink
}

export interface StageSuccess {
  /** Méthode qui a fonctionné — utile au diagnostic quand X change son éditeur. */
  method: string
  charactersWritten: number
}

/**
 * Insertion via `execCommand('insertText')`.
 *
 * Déprécié, et pourtant la méthode la plus fiable ici : c'est le seul chemin qui émette la
 * séquence `beforeinput`/`input` exactement comme une frappe, ce que les éditeurs riches
 * attendent. Les alternatives modernes (`InputEvent` construit à la main) ne sont pas
 * fiables parce qu'elles ne sont pas de confiance (`isTrusted: false`).
 */
function writeViaExecCommand(editor: HTMLElement, text: string): boolean {
  editor.focus()
  const selection = editor.ownerDocument.getSelection()
  if (selection) {
    const range = editor.ownerDocument.createRange()
    range.selectNodeContents(editor)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  try {
    return editor.ownerDocument.execCommand('insertText', false, text)
  } catch {
    return false
  }
}

/**
 * Insertion via un événement `paste` synthétique.
 *
 * Repli quand `execCommand` disparaît. Les éditeurs riches implémentent presque toujours
 * un gestionnaire de collage, parce qu'ils doivent nettoyer le HTML collé.
 */
function writeViaPaste(editor: HTMLElement, text: string): boolean {
  editor.focus()
  try {
    const event = new ClipboardEvent('paste', {
      clipboardData: buildClipboardData(text),
      bubbles: true,
      cancelable: true,
    })
    return editor.dispatchEvent(event)
  } catch {
    return false
  }
}

/**
 * `DataTransfer` n'est pas constructible partout — absent de jsdom, et historiquement
 * absent de certains contextes de worker. On se replie sur un objet minimal exposant
 * `getData`, qui est la seule méthode qu'un gestionnaire de collage appelle en pratique.
 * Le cast est confiné ici plutôt que de rendre la fonction dépendante d'une API optionnelle.
 */
function buildClipboardData(text: string): DataTransfer {
  try {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    return data
  } catch {
    return {
      getData: (type: string) => (type === 'text/plain' || type === 'text' ? text : ''),
      types: ['text/plain'],
      items: [],
      files: [],
    } as unknown as DataTransfer
  }
}

/**
 * Dernier repli : écriture directe puis notification.
 *
 * Peu fiable — l'éditeur peut écraser — mais on la tente avant d'échouer, et la
 * vérification qui suit dira si elle a tenu. Mieux vaut essayer et constater que renoncer.
 */
function writeViaTextNode(editor: HTMLElement, text: string): boolean {
  try {
    editor.focus()
    editor.textContent = text
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }))
    return true
  } catch {
    return false
  }
}

function readEditorText(editor: HTMLElement): string {
  // \u200B : espace de largeur nulle. Les éditeurs riches en insèrent pour maintenir
  // un point d'insertion dans un nœud vide ; il fausserait la comparaison.
  return (editor.textContent ?? '').replace(/\u200B/g, '').trim()
}

/**
 * Écrit `text` dans le composeur et **vérifie** le résultat.
 *
 * La vérification est le cœur de la fonction, pas une précaution : sans elle, un échec
 * silencieux de l'éditeur laisserait l'utilisateur croire que le brouillon est prêt, et
 * l'ANALYST enregistrerait une action mise en scène qui n'a jamais existé.
 */
export async function stageDraft(
  opts: StageOptions,
): Promise<Result<StageSuccess, StageError>> {
  if (opts.permitToken.length < 8) {
    return err({ kind: 'invalid-permit', detail: 'jeton absent ou trop court' })
  }

  const root = opts.root ?? document
  const editor = queryOne<HTMLElement>(root, COMPOSER_EDITOR, opts.report ?? noopSink).el
  if (!editor) {
    return err({
      kind: 'no-editor',
      detail: 'zone de saisie introuvable — le composeur est-il ouvert ?',
    })
  }

  const methods: readonly [string, (e: HTMLElement, t: string) => boolean][] = [
    ['execCommand', writeViaExecCommand],
    ['paste', writeViaPaste],
    ['textNode', writeViaTextNode],
  ]

  const attempted: string[] = []
  for (const [name, write] of methods) {
    attempted.push(name)
    if (!write(editor, opts.text)) continue

    // Une frame d'attente : l'éditeur réconcilie son état interne au rendu suivant, et
    // vérifier immédiatement testerait un DOM que l'éditeur n'a pas encore validé.
    await nextFrame(editor.ownerDocument)

    const found = readEditorText(editor)
    if (found.includes(opts.text.trim().slice(0, 40))) {
      log.debug('brouillon mis en scène', { method: name, length: opts.text.length })
      return ok({ method: name, charactersWritten: opts.text.length })
    }
  }

  const found = readEditorText(editor)
  log.warn('mise en scène du brouillon en échec', {
    attempted,
    foundLength: found.length,
  })
  return err(
    found === ''
      ? { kind: 'write-failed', attempted }
      : {
          kind: 'verification-failed',
          expected: opts.text.slice(0, 80),
          found: found.slice(0, 80),
        },
  )
}

function nextFrame(doc: Document): Promise<void> {
  return new Promise((resolve) => {
    const raf = doc.defaultView?.requestAnimationFrame
    if (typeof raf === 'function') raf.call(doc.defaultView, () => resolve())
    else setTimeout(resolve, 16)
  })
}
