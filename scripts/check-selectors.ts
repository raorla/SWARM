/**
 * Vérification des sélecteurs en CI — SPEC §8.
 *
 * Rejoue chaque fixture DOM contre `x-selectors.ts` et rapporte quel sélecteur ne matche
 * plus. Tourne sans navigateur, donc à chaque commit.
 *
 * Ce que ça attrape : une régression de nos propres sélecteurs — quelqu'un « nettoie » une
 * cascade et casse un cas. Ce que ça **n'attrape pas** : un changement de X. Nos fixtures
 * ne changent pas quand X change ; c'est le rôle de `snapshot-on-break.ts` (MH-14). La
 * distinction est écrite ici pour que personne ne se croie couvert par ce script.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import {
  ACTION_BAR,
  COMPOSER_EDITOR,
  COMPOSER_SUBMIT,
  SIDENAV_ACCOUNT,
  SIDENAV_PROFILE_LINK,
  POST_AUTHOR_BLOCK,
  POST_AUTHOR_LINK,
  POST_CONTAINER,
  POST_PERMALINK,
  POST_TEXT,
  POST_TIME,
  REPLY_BUTTON,
  ALL_SELECTORS,
  type SelectorSpec,
} from '../src/content/dom/x-selectors.ts'

const FIXTURES = join(process.cwd(), 'tests/fixtures/x-dom')

/**
 * Chaque fixture déclare ce qu'elle est censée contenir.
 *
 * Une fixture de composeur n'a pas de post, et une fixture de post n'a pas de composeur :
 * exiger l'ensemble des sélecteurs partout produirait des échecs qui n'apprennent rien —
 * et un checker qui crie faux est un checker qu'on désactive.
 */
const POST_SELECTORS: readonly SelectorSpec[] = [
  POST_CONTAINER,
  POST_TEXT,
  POST_AUTHOR_BLOCK,
  POST_AUTHOR_LINK,
  POST_TIME,
  POST_PERMALINK,
  ACTION_BAR,
  REPLY_BUTTON,
]

const COMPOSER_SELECTORS: readonly SelectorSpec[] = [COMPOSER_EDITOR, COMPOSER_SUBMIT]

const SIDENAV_SELECTORS: readonly SelectorSpec[] = [SIDENAV_ACCOUNT, SIDENAV_PROFILE_LINK]

interface FixtureExpectation {
  expect: readonly SelectorSpec[]
  /** Vrai si l'absence des sélecteurs est le comportement attendu (DOM dégradé). */
  shouldFail?: boolean
}

const EXPECTATIONS: Record<string, FixtureExpectation> = {
  'timeline-post.html': { expect: POST_SELECTORS },
  'post-with-media.html': { expect: POST_SELECTORS },
  'reply-in-thread.html': { expect: POST_SELECTORS },
  'high-metrics-post.html': { expect: POST_SELECTORS },
  'post-no-metrics.html': { expect: POST_SELECTORS },
  'promoted-post.html': { expect: POST_SELECTORS },
  'composer-open.html': { expect: COMPOSER_SELECTORS },
  'sidenav-account.html': { expect: SIDENAV_SELECTORS },
  // Simule le changement de DOM de X : l'échec est le résultat attendu.
  'broken-post.html': { expect: POST_SELECTORS, shouldFail: true },
}

function missingIn(doc: Document, specs: readonly SelectorSpec[]): string[] {
  return specs
    .filter(
      (spec) =>
        !spec.candidates.some((c) => {
          try {
            return doc.querySelector(c) !== null
          } catch {
            // Un sélecteur que le moteur refuse (`:has()` sur un vieux moteur) n'est pas
            // une absence : on passe au candidat suivant, comme le fait `query.ts`.
            return false
          }
        }),
    )
    .map((s) => s.name)
}

const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.html'))
const rows: string[] = []
let failures = 0

// Une fixture non déclarée est une erreur, pas un cas ignoré : sinon on ajouterait une
// fixture en croyant l'avoir couverte.
for (const file of files) {
  if (!EXPECTATIONS[file]) {
    rows.push(`✗ ${file} — non déclarée dans EXPECTATIONS`)
    failures += 1
  }
}

for (const [file, expectation] of Object.entries(EXPECTATIONS)) {
  if (!files.includes(file)) {
    rows.push(`✗ ${file} — déclarée mais absente du dossier`)
    failures += 1
    continue
  }

  const { window } = new JSDOM(readFileSync(join(FIXTURES, file), 'utf8'))
  const missing = missingIn(window.document as unknown as Document, expectation.expect)
  const broke = missing.length > 0

  if (expectation.shouldFail && !broke) {
    rows.push(`✗ ${file} — devait échouer sur ses sélecteurs, tout matche`)
    failures += 1
  } else if (!expectation.shouldFail && broke) {
    rows.push(`✗ ${file} — sélecteurs absents : ${missing.join(', ')}`)
    failures += 1
  } else if (expectation.shouldFail) {
    rows.push(`✓ ${file} (échec attendu, confirmé : ${missing.length} sélecteur(s))`)
  } else {
    rows.push(`✓ ${file} (${expectation.expect.length} sélecteurs)`)
  }
}

console.log(rows.sort().join('\n'))
console.log(
  failures === 0
    ? `\n✓ ${ALL_SELECTORS.length} sélecteurs déclarés, ${files.length} fixtures vérifiées`
    : `\n✗ ${failures} problème(s)`,
)
process.exit(failures === 0 ? 0 : 1)
