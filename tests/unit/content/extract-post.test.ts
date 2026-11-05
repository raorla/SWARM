/**
 * @vitest-environment jsdom
 *
 * Tests de parsing sur fixtures DOM.
 *
 * Ce que ces tests prouvent : le parseur fait ce qu'on croit. Ce qu'ils ne prouvent pas :
 * que X ressemble aux fixtures. Voir `tests/fixtures/x-dom/README.md` — la distinction est
 * importante, parce que la confondre donnerait une confiance imméritée.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractPost, parsePermalink } from '@/content/scout/extract-post'
import { noopSink } from '@/content/dom/query'
import { FakeClock } from '@/shared/time'

const FIXTURES = join(process.cwd(), 'tests/fixtures/x-dom')

function loadArticle(name: string): Element {
  const html = readFileSync(join(FIXTURES, name), 'utf8')
  document.body.innerHTML = html
  const el = document.body.querySelector('article')
  if (!el) throw new Error(`aucun <article> dans ${name}`)
  return el
}

const clock = new FakeClock('2026-08-25T12:12:00.000Z')

const opts = {
  surface: 'timeline' as const,
  clock,
  report: noopSink,
  ownHandle: null,
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('extractPost — post standard', () => {
  it('extrait tous les champs attendus', () => {
    const result = extractPost(loadArticle('timeline-post.html'), opts)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const p = result.value
    expect(p.postId).toBe('1789456123456789012')
    expect(p.authorHandle).toBe('aliceonchain')
    expect(p.authorDisplayName).toBe('Alice Onchain')
    expect(p.text).toContain('bonding curve')
    expect(p.lang).toBe('en')
    expect(p.postedAtMs).toBe(Date.parse('2026-08-25T10:12:00.000Z'))
    expect(p.replyCount).toBe(12)
    expect(p.repostCount).toBe(4)
    expect(p.likeCount).toBe(88)
    expect(p.hasMedia).toBe(false)
    expect(p.isReply).toBe(false)
    expect(p.surface).toBe('timeline')
    expect(p.permalink).toBe('/aliceonchain/status/1789456123456789012')
  })

  it('lit le handle depuis le href, pas depuis le texte affiché', () => {
    // Le nom affiché peut être traduit, décoré d'unicode ou renommé ; le href est canonique.
    const article = loadArticle('timeline-post.html')
    const nameSpan = article.querySelector('[data-testid="User-Name"] span')
    if (nameSpan) nameSpan.textContent = '𝓐𝓵𝓲𝓬𝓮 ✨ (@notherealhandle)'
    const result = extractPost(article, opts)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.authorHandle).toBe('aliceonchain')
  })

  it('marque les posts de l’utilisateur', () => {
    const result = extractPost(loadArticle('timeline-post.html'), {
      ...opts,
      ownHandle: '@AliceOnChain',
    })
    expect(result.ok).toBe(true)
    // Comparaison insensible à la casse et au @ : X affiche le handle avec sa casse
    // d'origine, l'utilisateur le saisit comme il veut.
    if (result.ok) expect(result.value.isOwnPost).toBe(true)
  })
})

describe('extractPost — variantes', () => {
  it('détecte un média', () => {
    const result = extractPost(loadArticle('post-with-media.html'), opts)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.hasMedia).toBe(true)
      expect(result.value.lang).toBe('fr')
    }
  })

  it('détecte une réponse dans un fil', () => {
    const result = extractPost(loadArticle('reply-in-thread.html'), opts)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.isReply).toBe(true)
      // Le handle de l'auteur de la réponse, pas celui du post racine.
      expect(result.value.authorHandle).toBe('quietbuilder')
    }
  })

  it('écarte un post sponsorisé sans tenter de le parser', () => {
    // Y répondre est du bruit, et le compte annonceur n'a pas de relation à construire.
    const result = extractPost(loadArticle('promoted-post.html'), opts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('promoted')
  })

  it('lit zéro, et non « inconnu », sur un compteur vide', () => {
    // X n'affiche rien à zéro. Renvoyer `null` ferait passer un post sans réponse pour un
    // post dont on ignore la saturation, ce qui n'est pas la même chose.
    const result = extractPost(loadArticle('post-no-metrics.html'), opts)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.replyCount).toBe(0)
      expect(result.value.likeCount).toBe(0)
      expect(result.value.repostCount).toBe(0)
    }
  })

  it('préfère le nombre exact de l’aria-label à l’abréviation affichée', () => {
    // « 2.3K » perdrait 40 réponses de précision, ce qui compte pour la saturation.
    const result = extractPost(loadArticle('high-metrics-post.html'), opts)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.replyCount).toBe(2340)
      expect(result.value.repostCount).toBe(1200)
      expect(result.value.likeCount).toBe(45600)
    }
  })
})

describe('extractPost — échecs propres', () => {
  it('échoue avec un motif sur une structure dégradée', () => {
    // Le scénario réel du changement de DOM de X : jamais d'identifiant inventé.
    const result = extractPost(loadArticle('broken-post.html'), opts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('no-permalink')
  })

  it('échoue si le bloc auteur disparaît', () => {
    const article = loadArticle('timeline-post.html')
    article
      .querySelector('[data-testid="User-Name"]')
      ?.setAttribute('data-testid', 'autre')
    const result = extractPost(article, opts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('no-author')
  })

  it('échoue si l’horodatage est illisible', () => {
    const article = loadArticle('timeline-post.html')
    article.querySelector('time')?.setAttribute('datetime', 'la semaine dernière')
    const result = extractPost(article, opts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('no-timestamp')
  })

  it('accepte un post sans texte s’il a un média', () => {
    // Un post image seule est légitime : chaîne vide, pas échec.
    const article = loadArticle('post-with-media.html')
    article.querySelector('[data-testid="tweetText"]')?.remove()
    const result = extractPost(article, opts)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.text).toBe('')
      expect(result.value.hasMedia).toBe(true)
    }
  })

  it('échoue si le post n’a ni texte ni média', () => {
    const article = loadArticle('timeline-post.html')
    article.querySelector('[data-testid="tweetText"]')?.remove()
    const result = extractPost(article, opts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('no-text')
  })

  it('ne lance jamais, quelle que soit la structure', () => {
    // Un article vide, un article rempli de bruit : l'extraction renvoie un échec, elle
    // ne casse pas la boucle du scout.
    for (const html of [
      '<article></article>',
      '<article><div><span>x</span></div></article>',
    ]) {
      document.body.innerHTML = html
      const el = document.body.querySelector('article')!
      expect(() => extractPost(el, opts)).not.toThrow()
      expect(extractPost(el, opts).ok).toBe(false)
    }
  })
})

describe('parsePermalink', () => {
  it('extrait handle et identifiant', () => {
    expect(parsePermalink('/aliceonchain/status/1789456123456789012')).toEqual({
      handle: 'aliceonchain',
      postId: '1789456123456789012',
    })
  })

  it('accepte une URL absolue', () => {
    expect(parsePermalink('https://x.com/bob/status/1234567890123')).toEqual({
      handle: 'bob',
      postId: '1234567890123',
    })
  })

  it('ignore les suffixes de chemin', () => {
    expect(parsePermalink('/bob/status/1234567890123/photo/1')?.postId).toBe(
      '1234567890123',
    )
  })

  it('rejette ce qui n’est pas un permalien', () => {
    for (const bad of ['/home', '/bob', '/bob/status/abc', '', '/i/bookmarks']) {
      expect(parsePermalink(bad), bad).toBeNull()
    }
  })
})
