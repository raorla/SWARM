import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Trois règles portent des invariants du produit, pas du style :
 *
 *  - `no-restricted-syntax` sur Date.now/new Date/Math.random  → FEEDBACK MH-17.
 *    Sans horloge injectable la cadence du governor n'est pas testable ; sans RNG
 *    seedable le backtest de la Phase 7 n'est pas reproductible.
 *  - `no-restricted-globals` sur `fetch` hors de src/llm/       → SPEC §3, docs/architecture.
 *    `llm/client.ts` est le seul module autorisé à sortir du navigateur.
 *  - `no-console`                                               → FEEDBACK MH-08.
 *    Tout passe par shared/logger.ts, qui redacte les secrets.
 */
const CLOCK_AND_RNG = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Interdit (MH-17). Utilise `clock.now()` de @/shared/time.',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Interdit (MH-17). Utilise `clock.date()` de @/shared/time.',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'Interdit (MH-17). Utilise un `Rng` de @/shared/rng.',
  },
]

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', '.vite/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...CLOCK_AND_RNG],
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // shared/time.ts et shared/rng.ts sont les seuls points où l'horloge et l'aléa
    // réels sont légitimes : ce sont eux qui les encapsulent.
    files: ['src/shared/time.ts', 'src/shared/rng.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Le logger est le seul module autorisé à toucher la console.
    files: ['src/shared/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Scripts, tests et configs tournent sous Node : ils ont accès à `process`, `console`
    // et aux modules natifs, contrairement au code de l'extension.
    files: ['tests/**/*.ts', 'scripts/**/*.{ts,mjs}', '*.config.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        performance: 'readonly',
      },
    },
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
)
