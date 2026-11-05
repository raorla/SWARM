/**
 * E2E local — l'extension chargée dans un vrai Chromium, sur nos fixtures DOM servies en
 * local. Aucun compte X, aucun réseau : déterministe et exécutable en CI.
 *
 * Ce que cet E2E prouve, et que les tests unitaires ne peuvent pas : que l'extension se
 * charge réellement en MV3, que le content script s'injecte, que le Shadow DOM se monte
 * dans une page hostile, et que le bouton apparaît sous chaque post.
 */
import { test, expect, chromium, type BrowserContext } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXTENSION_PATH = join(process.cwd(), 'dist')
const FIXTURE_URL = 'http://localhost:4319/'

let context: BrowserContext

test.beforeAll(async () => {
  // Une extension MV3 ne se charge qu'avec un contexte persistant et un Chromium complet :
  // le headless classique ne charge pas les extensions.
  context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), 'swarm-e2e-')),
    {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
      ],
    },
  )
})

test.afterAll(async () => {
  await context?.close()
})

test('l’extension se charge et enregistre son service worker', async () => {
  // Sans ça, tout le reste échouerait avec des symptômes trompeurs.
  const workers = context.serviceWorkers()
  if (workers.length === 0) {
    await context.waitForEvent('serviceworker', { timeout: 15_000 })
  }
  const sw = context.serviceWorkers()[0]
  expect(sw, 'aucun service worker : le manifest ou le build est cassé').toBeDefined()
  expect(sw!.url()).toContain('chrome-extension://')
})

test('le content script s’injecte sur une page de type X', async () => {
  const page = await context.newPage()
  await page.goto(FIXTURE_URL)

  // On observe un effet DANS LE DOM, pas un marqueur sur `window`.
  //
  // Un content script tourne dans un « monde isolé » : son `window` n'est pas celui de la
  // page, donc `page.evaluate` ne verra jamais `__swarmContentScriptLoaded`. Le seul signal
  // observable depuis la page est ce que le script écrit dans le DOM partagé — ici
  // l'attribut d'ancre. C'est aussi le bon signal fonctionnellement : il prouve que le
  // script a tourné ET qu'il a fait son travail.
  await expect
    .poll(() => page.locator('[data-swarm-anchor]').count(), { timeout: 15_000 })
    .toBeGreaterThan(0)
  await page.close()
})

test('un bouton SWARM apparaît sous chaque post, en Shadow DOM isolé', async () => {
  const page = await context.newPage()
  await page.goto(FIXTURE_URL)

  // On compte les ancres d'overlay : le sélecteur d'attribut traverse le DOM de la page,
  // pas l'ombre — c'est justement l'intérêt de l'isolation.
  await expect
    .poll(() => page.locator('[data-swarm-anchor]').count(), { timeout: 15_000 })
    .toBeGreaterThan(0)

  const anchors = await page.locator('[data-swarm-anchor]').count()
  const articles = await page.locator('article[data-testid="tweet"]').count()
  expect(anchors).toBe(articles)

  // Le bouton lui-même vit dans une racine d'ombre : Playwright le traverse, un script de
  // la page ne le pourrait pas.
  const label = await page
    .locator('article[data-testid="tweet"]')
    .first()
    .locator('button', { hasText: 'SWARM' })
    .first()
    .textContent()
  expect(label).toContain('SWARM')

  await page.close()
})

test('les styles de l’overlay ne fuient pas sur la page', async () => {
  // X change ses classes en continu ; l'isolation doit tenir dans les deux sens.
  const page = await context.newPage()
  await page.goto(FIXTURE_URL)
  await expect.poll(() => page.locator('[data-swarm-anchor]').count()).toBeGreaterThan(0)

  const pageHasOurStyles = await page.evaluate(() =>
    [...document.styleSheets].some((sheet) => {
      try {
        return [...(sheet.cssRules ?? [])].some(
          (r) => r.cssText.includes('9999px') && r.cssText.includes('.btn'),
        )
      } catch {
        return false
      }
    }),
  )
  expect(pageHasOurStyles, 'nos styles ont fui hors du Shadow DOM').toBe(false)
  await page.close()
})

test('le content script ne bloque pas le fil principal pendant le scroll', async () => {
  // SPEC §8.
  //
  // On ne compte PAS les images par seconde. `requestAnimationFrame` est fortement bridé
  // dans un onglet non visible, ce qui est le cas par défaut en CI : le test mesurerait le
  // bridage du navigateur, pas notre coût, et échouerait pour une raison qui n'a rien à
  // voir avec le produit.
  //
  // On mesure à la place la **latence du fil principal**, qui n'est pas bridée : on planifie
  // des minuteurs à 0 ms pendant un défilement et on relève le pire retard. Un content
  // script qui parse 40 articles d'un bloc fait exploser cette latence — c'est exactement
  // le mode de défaillance que le découpage en tranches existe pour empêcher.
  const page = await context.newPage()
  await page.goto(FIXTURE_URL)
  await page.bringToFront()
  await expect
    .poll(() => page.locator('[data-swarm-anchor]').count(), { timeout: 15_000 })
    .toBeGreaterThan(0)

  const worstLatencyMs = await page.evaluate(async () => {
    return new Promise<number>((resolve) => {
      let worst = 0
      const start = performance.now()
      const probe = (): void => {
        const scheduled = performance.now()
        window.scrollBy(0, 120)
        setTimeout(() => {
          worst = Math.max(worst, performance.now() - scheduled)
          if (performance.now() - start < 2_000) probe()
          else resolve(worst)
        }, 0)
      }
      probe()
    })
  })

  // Seuil généreux : une machine de CI est lente et partagée, et un test de performance qui
  // échoue une fois sur trois est un test qu'on finit par désactiver. 250 ms de retard sur un
  // minuteur à 0 ms détecte un blocage franc, qui est le seul mode de défaillance qui compte
  // ici — pas une variation de quelques millisecondes.
  expect(worstLatencyMs, `pire latence ${Math.round(worstLatencyMs)} ms`).toBeLessThan(
    250,
  )
  await page.close()
})

/**
 * Le parcours de première ouverture — c'est le test qui répond à « est-ce installable ? ».
 *
 * Il existe à cause d'un défaut trouvé en préparant la première installation dans Chrome :
 * `hasConsented()` gardait le triage et la rédaction, et **aucun écran ne permettait
 * d'accorder le consentement**. L'extension se chargeait, affichait ses onglets, et refusait
 * tout en silence. Un test unitaire ne pouvait pas le voir : chaque garde était correcte, et
 * les tests des handlers accordaient le consentement eux-mêmes dans leur préparation.
 *
 * D'où l'ordre ici : profil neuf → porte de consentement → cockpit. C'est le seul test de la
 * suite qui vérifie que le produit est **atteignable**, et pas seulement correct.
 */
test('première ouverture : la porte de consentement précède le cockpit', async () => {
  const workers = context.serviceWorkers()
  const extensionId = workers[0]?.url().split('/')[2]
  expect(extensionId).toBeTruthy()

  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`)

  // Sur un profil neuf, les onglets ne doivent PAS être la première chose visible : ils
  // laisseraient croire que le produit fonctionne alors que tout est bloqué en aval.
  await expect(page.getByRole('heading', { name: /Avant de commencer/i })).toBeVisible()
  const activate = page.getByRole('button', { name: /Activer SWARM/i })
  await expect(activate).toBeDisabled()

  // Le refus existe et n'a aucune conséquence : un consentement qu'on ne peut pas refuser
  // n'en est pas un.
  await page.getByRole('button', { name: /Pas maintenant/i }).click()
  await expect(page.getByText(/Rien n’a été activé/i)).toBeVisible()
  await page.getByRole('button', { name: /revoir les conditions/i }).click()

  await page.getByRole('checkbox').check()
  await expect(activate).toBeEnabled()
  await activate.click()

  // Puis le cockpit, et le kill switch accessible en un clic (SPEC §2.3).
  await expect(page.getByRole('tab', { name: /Swarm/i })).toBeVisible()
  await expect(page.getByRole('tab', { name: /Flux|Feed/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /Kill switch/i })).toBeVisible()

  // Le consentement est persisté : rouvrir ne redemande pas.
  await page.reload()
  await expect(page.getByRole('tab', { name: /Swarm/i })).toBeVisible()

  // Et l'écran de configuration initiale est atteignable : sans lui, le produit reste complet
  // et inutilisable — c'était le cas avant que `ProviderPanel` existe.
  await page.getByRole('tab', { name: /Config/i }).click()
  await expect(page.getByText(/Clé API/i)).toBeVisible()
  await expect(page.getByText(/Pack de niche/i)).toBeVisible()
  await expect(page.getByText(/Plafonds et cadence/i)).toBeVisible()
  await expect(page.getByText(/Sauvegarde chiffrée/i)).toBeVisible()

  // Le pack doit être CHOISISSABLE : sans ça, le compte pilote tourne sur `generic` et tout le
  // tri est hors sujet, sans que rien ne le signale.
  const packSelect = page.locator('select').last()
  await packSelect.selectOption('memecoin')
  await expect(packSelect).toHaveValue('memecoin')

  await page.close()
})
