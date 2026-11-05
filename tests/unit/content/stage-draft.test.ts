/**
 * @vitest-environment jsdom
 *
 * Deux choses sont testées ici, et la seconde est la plus importante :
 *
 *  1. Que l'écriture dans le composeur fonctionne, et qu'elle **échoue explicitement**
 *     quand l'éditeur refuse — un échec silencieux ferait croire à l'utilisateur que son
 *     brouillon est prêt, et ferait enregistrer par l'ANALYST une action inexistante.
 *  2. Que ce module ne peut structurellement pas publier (SPEC §4.6).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stageDraft } from '@/content/actuator/stage-draft'

const FIXTURES = join(process.cwd(), 'tests/fixtures/x-dom')

function loadComposer(): HTMLElement {
  document.body.innerHTML = readFileSync(join(FIXTURES, 'composer-open.html'), 'utf8')
  return document.querySelector<HTMLElement>('[data-testid="tweetTextarea_0"]')!
}

const PERMIT = 'overlay-manual-request'

/**
 * Shim minimal de l'API de collage, absente de jsdom.
 * Installé explicitement par les tests qui en ont besoin, jamais globalement : les autres
 * doivent voir un moteur sans clipboard, ce qui est aussi un cas réel à couvrir.
 */
function installClipboardShim(): void {
  class FakeClipboardEvent extends Event {
    readonly clipboardData: { getData(type: string): string }
    constructor(type: string, init: { clipboardData?: unknown } & EventInit) {
      super(type, init)
      this.clipboardData = (init.clipboardData as { getData(type: string): string }) ?? {
        getData: () => '',
      }
    }
  }
  Object.defineProperty(globalThis, 'ClipboardEvent', {
    configurable: true,
    writable: true,
    value: FakeClipboardEvent,
  })
}

function removeClipboardShim(): void {
  Reflect.deleteProperty(globalThis, 'ClipboardEvent')
}

beforeEach(() => {
  document.body.innerHTML = ''
  removeClipboardShim()
  vi.restoreAllMocks()
  // jsdom n'implémente pas execCommand : on le simule pour tester le chemin principal.
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    writable: true,
    value: vi.fn(() => false),
  })
})

describe('stageDraft — écriture', () => {
  it('écrit via execCommand quand il fonctionne', async () => {
    const editor = loadComposer()
    vi.mocked(document.execCommand).mockImplementation(((
      cmd: string,
      _ui,
      text?: string,
    ) => {
      if (cmd !== 'insertText') return false
      editor.textContent = text ?? ''
      return true
    }) as typeof document.execCommand)

    const result = await stageDraft({
      text: 'locked liquidity is table stakes',
      permitToken: PERMIT,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.method).toBe('execCommand')
    expect(editor.textContent).toContain('locked liquidity')
  })

  it('retombe sur l’événement paste quand execCommand disparaît', async () => {
    // Scénario réaliste : execCommand est déprécié et finira par être retiré.
    //
    // jsdom n'implémente ni `ClipboardEvent` ni `DataTransfer`. On les shime le temps du
    // test pour vérifier NOTRE logique de dispatch — que l'événement part, avec le texte
    // récupérable. La sémantique réelle du collage dans un éditeur riche ne peut être
    // vérifiée que dans un vrai navigateur : c'est le rôle de l'E2E Playwright.
    installClipboardShim()
    const editor = loadComposer()
    editor.addEventListener('paste', (e) => {
      const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
      editor.textContent = text
    })

    const result = await stageDraft({ text: 'un brouillon', permitToken: PERMIT })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.method).toBe('paste')
    expect(editor.textContent).toBe('un brouillon')
  })

  it('se replie proprement quand ClipboardEvent est absent du moteur', async () => {
    // Sans shim, jsdom reproduit un moteur sans API de collage : la méthode doit être
    // écartée sans faire échouer la chaîne, et l'écriture directe doit prendre le relais.
    const editor = loadComposer()
    const result = await stageDraft({ text: 'sans clipboard', permitToken: PERMIT })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.method).toBe('textNode')
    expect(editor.textContent).toBe('sans clipboard')
  })

  it('retombe sur l’écriture directe en dernier recours', async () => {
    loadComposer()
    const result = await stageDraft({ text: 'dernier recours', permitToken: PERMIT })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.method).toBe('textNode')
  })

  it('émet un événement input pour prévenir l’éditeur', async () => {
    // Modifier le DOM sans notifier l'éditeur ferait écraser le texte au rendu suivant :
    // il apparaîtrait puis disparaîtrait.
    const editor = loadComposer()
    const events: string[] = []
    editor.addEventListener('input', () => events.push('input'))
    await stageDraft({ text: 'texte', permitToken: PERMIT })
    expect(events).toContain('input')
  })
})

describe('stageDraft — échecs explicites', () => {
  it('échoue quand le composeur n’est pas ouvert', async () => {
    document.body.innerHTML = '<div>pas de composeur</div>'
    const result = await stageDraft({ text: 'x', permitToken: PERMIT })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('no-editor')
  })

  it('détecte que l’éditeur a écrasé le texte', async () => {
    // C'est le mode de défaillance réel d'un éditeur riche, et le seul moyen de le voir
    // est de relire après une frame.
    const editor = loadComposer()
    Object.defineProperty(editor, 'textContent', {
      configurable: true,
      get: () => '',
      set: () => undefined, // l'éditeur ignore l'écriture
    })
    const result = await stageDraft({ text: 'ce texte sera perdu', permitToken: PERMIT })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('write-failed')
  })

  it('signale un texte partiellement écrit', async () => {
    const editor = loadComposer()
    let stored = ''
    Object.defineProperty(editor, 'textContent', {
      configurable: true,
      get: () => stored,
      set: (v: string) => {
        stored = v.slice(0, 5) // l'éditeur tronque
      },
    })
    const result = await stageDraft({
      text: 'un texte beaucoup plus long que ce que l’éditeur accepte',
      permitToken: PERMIT,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('verification-failed')
  })

  it('refuse d’agir sans jeton', async () => {
    loadComposer()
    const result = await stageDraft({ text: 'x', permitToken: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('invalid-permit')
  })

  it('liste les méthodes tentées, pour le diagnostic', async () => {
    document.body.innerHTML = `
      <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div>`
    const editor = document.querySelector<HTMLElement>('[data-testid="tweetTextarea_0"]')!
    Object.defineProperty(editor, 'textContent', {
      configurable: true,
      get: () => '',
      set: () => undefined,
    })
    const result = await stageDraft({ text: 'x', permitToken: PERMIT })
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'write-failed') {
      expect(result.error.attempted).toEqual(['execCommand', 'paste', 'textNode'])
    }
  })
})

describe('garantie structurelle : ce module ne publie jamais (SPEC §4.6)', () => {
  it('n’appelle jamais le bouton de soumission', async () => {
    // Test comportemental : on espionne le clic sur le bouton Publier de la fixture.
    const editor = loadComposer()
    const submit = document.querySelector<HTMLElement>('[data-testid="tweetButton"]')!
    const clickSpy = vi.spyOn(submit, 'click')
    void editor

    await stageDraft({ text: 'un brouillon qui ne doit pas partir', permitToken: PERMIT })
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('ne référence même pas le sélecteur de soumission', () => {
    // Test structurel, plus fort que le précédent : on lit le code source. Un commentaire
    // « ne publie jamais » ne garantit rien ; l'absence de la référence, si.
    const source = readFileSync(
      join(process.cwd(), 'src/content/actuator/stage-draft.ts'),
      'utf8',
    )
    expect(source).not.toContain('COMPOSER_SUBMIT')
    expect(source).not.toContain('tweetButton')
    expect(source).not.toMatch(/\.click\(\)/)
  })

  it('aucun module de l’actuator ne clique un bouton de soumission', () => {
    const dir = join(process.cwd(), 'src/content/actuator')
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8')
      expect(source, `${file} référence le bouton Publier`).not.toContain(
        'COMPOSER_SUBMIT',
      )
      expect(source, `${file} référence tweetButton`).not.toContain('tweetButton')
    }
  })
})
