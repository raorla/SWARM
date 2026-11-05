/**
 * @vitest-environment jsdom
 *
 * L'anonymisation est la garantie qui rend MH-14 acceptable : une capture qui fuit serait
 * pire que pas de capture, parce qu'elle transformerait un outil de débogage en canal
 * d'exfiltration. Ces tests sont donc des tests de sécurité, pas de format.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  anonymizeElement,
  captureBreakContext,
  containsIdentifiableData,
} from '@/content/dom/snapshot-on-break'

const FIXTURES = join(process.cwd(), 'tests/fixtures/x-dom')

function load(name: string): Element {
  document.body.innerHTML = readFileSync(join(FIXTURES, name), 'utf8')
  const el = document.body.firstElementChild
  if (!el) throw new Error(name)
  return el
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('anonymisation', () => {
  it('conserve les attributs qui portent la structure', () => {
    // C'est tout l'intérêt : le fragment doit rester utilisable comme fixture de test.
    const out = anonymizeElement(load('timeline-post.html'))
    expect(out).toContain('data-testid="tweet"')
    expect(out).toContain('data-testid="tweetText"')
    expect(out).toContain('data-testid="reply"')
    expect(out).toContain('role="group"')
    expect(out).toContain('lang="en"')
  })

  it('détruit le texte du post', () => {
    const out = anonymizeElement(load('timeline-post.html'))
    expect(out).not.toContain('bonding curve')
    expect(out).not.toContain('locked liquidity')
  })

  it('détruit le handle et le nom d’affichage', () => {
    const out = anonymizeElement(load('timeline-post.html'))
    expect(out).not.toContain('aliceonchain')
    expect(out).not.toContain('Alice Onchain')
  })

  it('remplace l’identifiant du post mais garde la forme du chemin', () => {
    // La forme `/user/status/id` est ce que nos sélecteurs exploitent ; la valeur non.
    const out = anonymizeElement(load('timeline-post.html'))
    expect(out).not.toContain('1789456123456789012')
    expect(out).toContain('/status/')
  })

  it('conserve les nombres des aria-label, utiles au débogage des métriques', () => {
    // Ils ne sont pas identifiants, et c'est précisément le parsing de métriques qu'on
    // débogue le plus souvent.
    const out = anonymizeElement(load('high-metrics-post.html'))
    expect(out).toMatch(/2,340|2340/)
  })

  it('écarte classes, styles et identifiants générés', () => {
    const out = anonymizeElement(load('broken-post.html'))
    expect(out).not.toContain('css-1dbjc4n')
    expect(out).not.toContain('class=')
  })

  it('normalise l’horodatage', () => {
    const out = anonymizeElement(load('timeline-post.html'))
    expect(out).toContain('datetime="2026-01-01T00:00:00.000Z"')
    expect(out).not.toContain('2026-08-25T10:12')
  })

  it('anonymise les URL absolues', () => {
    document.body.innerHTML =
      '<div><a href="https://tracker.example.com/u/12345">x</a></div>'
    const out = anonymizeElement(document.body.firstElementChild!)
    expect(out).not.toContain('tracker.example.com')
  })

  it('borne la profondeur de récursion', () => {
    let html = '<div>'
    for (let i = 0; i < 40; i++) html += '<div>'
    html += 'x'
    for (let i = 0; i < 40; i++) html += '</div>'
    html += '</div>'
    document.body.innerHTML = html
    const out = anonymizeElement(document.body.firstElementChild!)
    expect(out).toContain('profondeur max')
  })
})

describe('containsIdentifiableData — garde de sortie', () => {
  it('valide chaque fixture anonymisée', () => {
    // Le test qui compte : aucune de nos captures ne doit contenir de donnée identifiante.
    for (const name of [
      'timeline-post.html',
      'post-with-media.html',
      'reply-in-thread.html',
      'high-metrics-post.html',
      'broken-post.html',
    ]) {
      const out = anonymizeElement(load(name))
      expect(containsIdentifiableData(out), `${name} laisse fuir une donnée`).toBe(false)
    }
  })

  it('détecte un handle laissé en clair', () => {
    expect(containsIdentifiableData('<span>@aliceonchain</span>')).toBe(true)
  })

  it('détecte un identifiant de post laissé en clair', () => {
    expect(containsIdentifiableData('<a href="/x/status/1789456123456789012">')).toBe(
      true,
    )
  })

  it('détecte des classes ou styles laissés en place', () => {
    expect(containsIdentifiableData('<div class="css-1dbjc4n">')).toBe(true)
    expect(containsIdentifiableData('<div style="color:red">')).toBe(true)
  })

  it('accepte le chemin neutralisé', () => {
    expect(containsIdentifiableData('<a href="/user/status/0000000000000000000">')).toBe(
      false,
    )
  })
})

describe('captureBreakContext', () => {
  it('renvoie null plutôt qu’un fragment vide', () => {
    // Un fragment vide laisserait croire à une capture réussie.
    expect(captureBreakContext(null)).toBeNull()
  })

  it('tronque un fragment démesuré en le signalant', () => {
    document.body.innerHTML = `<div>${'<span>abcdefghij</span>'.repeat(4000)}</div>`
    const out = captureBreakContext(document.body.firstElementChild)
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThan(21_000)
    expect(out).toContain('tronqué')
  })
})
