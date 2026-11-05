/**
 * Configuration des mesures « live » — celles qui font de VRAIS appels payants.
 *
 * Fichier séparé, et pas un `include` élargi, pour une raison simple : `npm run test` ne doit
 * jamais dépenser d'argent ni dépendre du réseau. La suite unitaire reste hermétique, et ces
 * mesures s'invoquent nommément (`npm run measure:cache`, `measure:qualifier`,
 * `calibrate:critic`).
 *
 * Pourquoi le lanceur de tests plutôt que des scripts `node` : les modules de `src/` utilisent
 * l'alias `@/` et des imports sans extension, que le résolveur ESM de Node ne sait pas suivre.
 * Vitest applique la configuration de résolution du projet, donc les mesures s'exécutent contre
 * **le vrai code de production**, sans copie ni adaptation — ce qui est tout l'intérêt d'une
 * mesure.
 *
 * C'est la même posture que `tests/e2e/live/` : ce qui touche au monde réel est derrière un
 * garde explicite.
 */
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/live/**/*.live.test.ts'],
    // Un appel de modèle peut prendre plusieurs dizaines de secondes, et la calibration en
    // enchaîne dix-neuf. Le défaut de 5 s couperait au milieu et ferait conclure à un échec.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Séquentiel : les mesures partagent un plafond de dépense, et les paralléliser rendrait
    // le coût cumulé non déterministe.
    fileParallelism: false,
    sequence: { concurrent: false },
    coverage: { enabled: false },
    // Ces fichiers **existent pour imprimer** : nombres de tokens, coûts, verdict,
    // recommandation de seuil. L'interception de console de Vitest les regroupe et en avale une
    // partie quand le test passe ; on l'enlève pour que la sortie arrive telle quelle.
    disableConsoleIntercept: true,
    reporters: ['verbose'],
  },
})
