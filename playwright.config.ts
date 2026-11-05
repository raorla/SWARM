import { defineConfig } from '@playwright/test'

/**
 * E2E sur une extension Chrome — contraintes du support :
 *
 *  - Une extension MV3 ne se charge qu'avec un contexte **persistant** (`launchPersistentContext`)
 *    et un vrai Chromium, pas en headless classique.
 *  - Un seul worker : les tests partagent un profil de navigateur.
 *  - Aucune parallélisation, aucun retry par défaut — un test E2E instable qu'on relance
 *    jusqu'au vert est pire qu'un test absent, parce qu'il donne une fausse assurance.
 *
 * Deux catégories de tests, séparées volontairement :
 *
 *  `tests/e2e/local/`  — tourne sur un serveur local servant nos fixtures DOM. Aucun compte
 *                        X, aucun réseau, déterministe, exécutable en CI.
 *  `tests/e2e/live/`   — tourne sur le vrai x.com avec un compte de test. Ne tourne QUE si
 *                        `SWARM_E2E_LIVE=1` : sans ça, on ferait de l'automatisation non
 *                        sollicitée sur X à chaque commit, ce que le produit s'interdit.
 */
const runLive = process.env['SWARM_E2E_LIVE'] === '1'

export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: runLive ? [] : ['**/live/**'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Sert `tests/e2e/fixtures-site/` : une page qui reproduit la structure DOM de X à
    // partir de nos fixtures. C'est ce qui rend l'E2E déterministe et exécutable en CI.
    command: 'node scripts/serve-fixtures.mjs',
    port: 4319,
    reuseExistingServer: true,
    stdout: 'ignore',
  },
})
