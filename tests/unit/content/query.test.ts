/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  exists,
  parseCompactNumber,
  queryAll,
  queryOne,
  readMetric,
} from '@/content/dom/query'
import type { AttemptReport } from '@/content/dom/query'
import { POST_CONTAINER, POST_TEXT } from '@/content/dom/x-selectors'

beforeEach(() => {
  document.body.innerHTML = ''
})

function collector(): { sink: (r: AttemptReport) => void; reports: AttemptReport[] } {
  const reports: AttemptReport[] = []
  return { sink: (r) => reports.push(r), reports }
}

describe('cascade de sélecteurs', () => {
  it('prend le premier candidat qui matche', () => {
    document.body.innerHTML = '<article data-testid="tweet"><p>x</p></article>'
    const { sink, reports } = collector()
    const res = queryOne(document, POST_CONTAINER, sink)
    expect(res.el).not.toBeNull()
    expect(res.candidateIndex).toBe(0)
    expect(reports[0]).toMatchObject({ hit: true, usedFallback: false })
  })

  it('descend dans la cascade et signale l’usage d’un repli', () => {
    // C'est le signal précoce qui compte : le sélecteur préféré a déjà changé.
    document.body.innerHTML = '<article role="article"><p>x</p></article>'
    const { sink, reports } = collector()
    const res = queryOne(document, POST_CONTAINER, sink)
    expect(res.el).not.toBeNull()
    expect(res.candidateIndex).toBe(1)
    expect(reports[0]?.usedFallback).toBe(true)
  })

  it('signale un échec quand aucun candidat ne matche', () => {
    document.body.innerHTML = '<div>rien</div>'
    const { sink, reports } = collector()
    expect(queryOne(document, POST_CONTAINER, sink).el).toBeNull()
    expect(reports[0]).toMatchObject({ hit: false, candidateIndex: -1 })
  })

  it('ignore un sélecteur invalide au lieu d’abandonner la cascade', () => {
    // `:has()` lance une SyntaxError sur les moteurs anciens. Une cascade ne doit pas
    // s'arrêter au premier sélecteur que le navigateur refuse.
    document.body.innerHTML =
      '<article data-testid="tweet"><a href="/a/status/123">x</a></article>'
    const spec = {
      name: 'test',
      describes: 'test',
      required: true,
      candidates: ['article:has(> :nonsense-pseudo)', 'article[data-testid="tweet"]'],
    }
    expect(() => queryOne(document, spec)).not.toThrow()
    expect(queryOne(document, spec).el).not.toBeNull()
  })

  it('queryAll déduplique les nœuds trouvés par plusieurs candidats', () => {
    // Ces deux articles matchent à la fois `article[data-testid="tweet"]` et
    // `article[role="article"]`. Sans déduplication, chaque post serait compté deux fois.
    document.body.innerHTML =
      '<article data-testid="tweet" role="article"></article><article data-testid="tweet" role="article"></article>'
    const { els } = queryAll(document, POST_CONTAINER)
    expect(els).toHaveLength(2)
  })

  it('queryAll prend l’UNION des candidats — déploiement progressif de X', () => {
    // Cas réel : X déploie ses changements de DOM progressivement, et l'ancienne et la
    // nouvelle structure coexistent dans le même fil pendant des jours. « Premier candidat
    // gagnant » ignorerait la moitié de la timeline en silence, sans qu'aucun sélecteur ne
    // paraisse cassé.
    document.body.innerHTML =
      '<article data-testid="tweet"><p>nouveau</p></article>' +
      '<article role="article"><p>ancien</p></article>'
    const { els } = queryAll(document, POST_CONTAINER)
    expect(els).toHaveLength(2)
  })

  it('queryAll renvoie les nœuds dans l’ordre du document', () => {
    // Le fil se traite de haut en bas : l'ordre d'insertion dans le Set ne le garantit pas.
    document.body.innerHTML =
      '<article role="article"><p>premier</p></article>' +
      '<article data-testid="tweet"><p>second</p></article>'
    const { els } = queryAll(document, POST_CONTAINER)
    expect(els[0]?.textContent).toBe('premier')
    expect(els[1]?.textContent).toBe('second')
  })

  it('queryAll signale un repli quand un candidat secondaire apporte des nœuds', () => {
    // Signal précoce d'un déploiement en cours : le candidat préféré ne couvre plus tout.
    document.body.innerHTML =
      '<article data-testid="tweet"></article><article role="article"></article>'
    const { sink, reports } = collector()
    queryAll(document, POST_CONTAINER, sink)
    expect(reports[0]?.usedFallback).toBe(true)
  })

  it('exists ne produit aucun rapport de santé', () => {
    document.body.innerHTML = '<div data-testid="tweetText">x</div>'
    expect(exists(document, POST_TEXT)).toBe(true)
    expect(exists(document, POST_CONTAINER)).toBe(false)
  })
})

describe('parseCompactNumber', () => {
  it('lit les nombres simples', () => {
    expect(parseCompactNumber('0')).toBe(0)
    expect(parseCompactNumber('12')).toBe(12)
    expect(parseCompactNumber('999')).toBe(999)
  })

  it('lit les abréviations', () => {
    expect(parseCompactNumber('1.2K')).toBe(1200)
    expect(parseCompactNumber('45.6K')).toBe(45600)
    expect(parseCompactNumber('2.3M')).toBe(2_300_000)
    expect(parseCompactNumber('1B')).toBe(1_000_000_000)
    expect(parseCompactNumber('3k')).toBe(3000)
  })

  it('désambiguïse séparateur de milliers et séparateur décimal', () => {
    // « 1,234 » est mille deux cent trente-quatre ; « 1,2 » est un virgule deux. On tranche
    // sur le nombre de chiffres après le séparateur.
    expect(parseCompactNumber('1,234')).toBe(1234)
    expect(parseCompactNumber('45,600')).toBe(45600)
    expect(parseCompactNumber('1,2K')).toBe(1200)
    expect(parseCompactNumber('1.234')).toBe(1234)
  })

  it('gère les séparateurs de milliers du format français', () => {
    // Construits par code point : ce test ne doit pas dépendre de caractères invisibles
    // dans sa propre source — ce serait exactement le piège qu'on a retiré du module.
    const NBSP = String.fromCharCode(0x00a0)
    const NNBSP = String.fromCharCode(0x202f)
    const THIN = String.fromCharCode(0x2009)
    expect(parseCompactNumber(`1${NBSP}234`)).toBe(1234)
    expect(parseCompactNumber(`45${NNBSP}600`)).toBe(45600)
    expect(parseCompactNumber(`2${THIN}300`)).toBe(2300)
    // Un espace ordinaire est traité pareil.
    expect(parseCompactNumber('1 234')).toBe(1234)
  })

  it('renvoie null sur un format non reconnu, jamais zéro', () => {
    // Renvoyer 0 ferait passer un post à 2 000 réponses pour un post frais.
    for (const bad of ['', '   ', 'beaucoup', 'Reply', '1.2.3.4X', null, undefined]) {
      expect(parseCompactNumber(bad), String(bad)).toBeNull()
    }
  })
})

describe('readMetric', () => {
  it('préfère le nombre exact de l’aria-label', () => {
    document.body.innerHTML =
      '<button aria-label="2,340 Replies. Reply"><span>2.3K</span></button>'
    // L'abréviation perdrait 40 réponses de précision.
    expect(readMetric(document.querySelector('button'))).toBe(2340)
  })

  it('retombe sur le texte visible sans aria-label exploitable', () => {
    document.body.innerHTML = '<button aria-label="Reply"><span>17</span></button>'
    expect(readMetric(document.querySelector('button'))).toBe(17)
  })

  it('lit zéro sur un bouton sans compteur', () => {
    document.body.innerHTML = '<button aria-label="Reply"><span></span></button>'
    expect(readMetric(document.querySelector('button'))).toBe(0)
  })

  it('renvoie null sur un bouton absent', () => {
    expect(readMetric(null)).toBeNull()
  })
})
