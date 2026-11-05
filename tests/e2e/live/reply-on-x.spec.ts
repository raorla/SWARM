/**
 * E2E « live » — sur le vrai x.com, avec un compte de test.
 *
 * **Ne tourne que si `SWARM_E2E_LIVE=1`.** Sans ce garde, chaque commit produirait de
 * l'automatisation non sollicitée sur X : exactement ce que le produit s'interdit. Le garde
 * fait partie de la posture, il n'est pas une commodité de développement.
 *
 * Ce test valide le DoD de la Phase 1 — « je peux répondre à un post avec l'IA sans quitter
 * X » — de bout en bout, avec un vrai DOM et un vrai appel modèle.
 *
 * Prérequis, tous obligatoires :
 *   SWARM_E2E_LIVE=1
 *   SWARM_E2E_PROFILE   chemin d'un profil Chrome déjà connecté au compte de test
 *   une clé API configurée et le coffre déverrouillé dans ce profil
 *
 * Le test **ne publie rien** : il vérifie que le brouillon arrive dans le composeur, et
 * s'arrête là. C'est aussi ce que fait le produit (SPEC §4.6).
 */
import { test, expect, chromium, type BrowserContext } from '@playwright/test'
import { join } from 'node:path'

const LIVE = process.env['SWARM_E2E_LIVE'] === '1'
const PROFILE = process.env['SWARM_E2E_PROFILE']

test.skip(!LIVE, 'E2E live désactivé — passe SWARM_E2E_LIVE=1 pour l’exécuter')
test.skip(!PROFILE, 'SWARM_E2E_PROFILE requis : un profil connecté au compte de test')

let context: BrowserContext

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(PROFILE!, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${join(process.cwd(), 'dist')}`,
      `--load-extension=${join(process.cwd(), 'dist')}`,
    ],
  })
})

test.afterAll(async () => {
  await context?.close()
})

test('DoD Phase 1 : générer une réponse et l’amener dans le composeur, sans publier', async () => {
  const page = await context.newPage()
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' })

  // Un post réel du fil.
  const firstPost = page.locator('article[data-testid="tweet"]').first()
  await expect(firstPost).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => page.locator('[data-swarm-anchor]').count()).toBeGreaterThan(0)

  // Déclencher la génération.
  await firstPost.locator('button', { hasText: 'SWARM' }).first().click()

  // Le brouillon ou un refus motivé : les deux sont des succès du produit. Un refus est un
  // résultat, pas une panne (SPEC §4.5).
  const draft = page.locator('textarea[aria-label*="Brouillon"]')
  const declined = page.getByText(/Rien à apporter ici/)
  await expect(draft.or(declined).first()).toBeVisible({ timeout: 60_000 })

  if (await declined.isVisible()) {
    test.info().annotations.push({
      type: 'note',
      description: 'Le modèle a refusé : comportement valide, rien à mettre en scène.',
    })
    await page.close()
    return
  }

  const text = await draft.inputValue()
  expect(text.trim().length).toBeGreaterThan(0)

  // Mise en scène dans le composeur de X.
  await page.getByRole('button', { name: /Ouvrir dans le composeur/ }).click()

  const editor = page.locator('[data-testid^="tweetTextarea_"]').first()
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await expect(editor).toContainText(text.slice(0, 30), { timeout: 10_000 })

  // La vérification qui compte : le post n'est PAS parti. Le bouton de soumission est
  // toujours là, actif, en attente de l'utilisateur.
  const submit = page.locator('[data-testid="tweetButton"]')
  await expect(submit).toBeVisible()
  expect(await submit.isEnabled()).toBe(true)

  await page.close()
})
