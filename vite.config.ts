import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import { fileURLToPath } from 'node:url'
import manifest from './src/manifest.config.ts'

export default defineConfig({
  plugins: [react(), tailwind(), crx({ manifest })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'chrome116',
    /**
     * **Pas de préchargement de modules.** Vite entoure chaque `import()` dynamique d'un
     * helper `__vitePreload` qui insère un `<link rel="modulepreload">` — donc qui touche
     * `document`.
     *
     * Dans un service worker, `document` n'existe pas : chaque import dynamique échouait avec
     * « document is not defined », ce qui remontait comme une erreur de handler sans rapport
     * apparent avec la cause. Et dans les pages d'extension, le même helper produisait des
     * avertissements « cross-world extension resource mismatch » dans la console, les chunks
     * préchargés n'étant jamais réutilisés.
     *
     * Le préchargement n'apporte rien ici de toute façon : le bundle est déjà sur le disque
     * local, il n'y a aucune latence réseau à masquer.
     */
    modulePreload: false,
    rollupOptions: {
      // L'offscreen document n'est référencé par aucun import : il est créé au runtime par
      // `chrome.offscreen.createDocument()`. Sans entrée explicite, Rollup ne le voit pas et
      // l'appel échoue à l'exécution avec un 404 difficile à relier à sa cause.
      //
      // Cette entrée a été soupçonnée d'écraser celles de @crxjs quand le service worker s'est
      // révélé branché sur le mauvais chunk — à tort : la cause était une collision de noms de
      // base entre les deux entrées `index.ts` (voir `manifest.config.ts`). Vérifié après
      // correction : les deux cohabitent, et `scripts/build-zip.ts` contrôle les deux.
      input: { offscreen: 'src/offscreen/index.html' },
      output: { chunkFileNames: 'assets/chunk-[hash].js' },
    },
  },
  // Le side panel et l'offscreen sont des pages d'extension : pas de HMR websocket
  // sur un port aléatoire, sinon la CSP de l'extension bloque le client.
  server: { port: 5199, strictPort: true, hmr: { port: 5199 } },
})
