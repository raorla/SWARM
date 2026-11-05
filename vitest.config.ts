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
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/sidepanel/**', 'src/**/index.html'],
      // Le governor est le module dont une régression est la plus coûteuse.
      thresholds: {
        'src/governor/**': { branches: 90, functions: 90, lines: 90, statements: 90 },
      },
    },
  },
})
