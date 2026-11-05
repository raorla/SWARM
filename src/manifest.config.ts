import { defineManifest } from '@crxjs/vite-plugin'
import pkg from '../package.json' with { type: 'json' }

/**
 * Cible E2E locale.
 *
 * Les tests E2E servent nos fixtures DOM sur `localhost:4319` pour être déterministes et
 * exécutables en CI sans compte X. Le content script doit donc pouvoir s'y injecter — mais
 * **uniquement** dans un build explicitement marqué E2E.
 *
 * Le garde est une variable d'environnement dédiée, pas le mode de build : un développeur
 * qui lance `npm run dev` ne doit pas se retrouver avec une extension qui s'injecte sur
 * tous ses serveurs locaux. `npm run build` et `npm run build:e2e` produisent donc des
 * manifestes différents, et seul le second contient cette entrée.
 */
const E2E = process.env['SWARM_E2E'] === '1'
const E2E_MATCHES = ['http://localhost:4319/*'] as const

/**
 * Manifest MV3 — chaque permission est justifiée dans docs/architecture.md#permissions.
 *
 * Principe de conception : demander le minimum à l'installation, et déplacer tout ce
 * qui dépend d'un choix de l'utilisateur (son provider LLM) dans
 * `optional_host_permissions`, demandé au runtime. Réclamer sept domaines de providers
 * à l'installation pour n'en utiliser qu'un est un mauvais signal en review Chrome Web
 * Store, et un mauvais signal pour l'utilisateur.
 */
export default defineManifest({
  manifest_version: 3,
  name: 'SWARM',
  version: pkg.version,
  description:
    'Copilote multi-agents local-first pour votre compte X. Vous gardez la main sur chaque publication.',
  minimum_chrome_version: '116',

  action: { default_title: 'SWARM' },
  side_panel: { default_path: 'src/sidepanel/index.html' },
  /**
   * **Le nom de fichier compte.** Il s'appelait `src/background/index.ts`, comme le content
   * script `src/content/index.ts` — et @crxjs indexe ses entrées par *nom de base*. Les deux
   * entrées collisionnaient, et le `service-worker-loader.js` généré importait le chunk du
   * **content script** : le service worker exécutait le code du scout, n'enregistrait aucun
   * écouteur de message, et tous les messages expiraient sans un mot.
   *
   * Symptôme observé : le side panel restait indéfiniment sur « Lecture de la configuration… »
   * et `chrome.runtime.onMessage.hasListeners()` renvoyait `false` dans le worker. Aucun test
   * unitaire ne pouvait le voir — le défaut est dans l'assemblage, pas dans le code.
   *
   * Les deux entrées portent donc des noms distincts, et un test de packaging vérifie que le
   * bundle du service worker contient bien le routeur.
   */
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },

  content_scripts: [
    {
      matches: E2E
        ? ['https://x.com/*', 'https://twitter.com/*', ...E2E_MATCHES]
        : ['https://x.com/*', 'https://twitter.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],

  permissions: [
    'sidePanel', // UI principale : le popup est trop exigu pour un cockpit.
    'storage', // config + clés chiffrées (chrome.storage.local).
    'unlimitedStorage', // vector store + archive de backtest dépassent le quota par défaut.
    'alarms', // seul réveil fiable du SW : cadence, J+1/J+7, reset budget, purge.
    'offscreen', // embeddings WASM hors de la fenêtre de ~30 s du SW.
    'scripting', // réinjection du content script après update, sans recharger X.
    'tabs', // lire url/status de l'onglet ouvert par ANALYST pour savoir qu'il a chargé.
  ],

  optional_permissions: [
    'notifications', // alerte de rupture de sélecteur : SPEC §8 interdit l'échec silencieux.
    'downloads', // export du journal d'audit et de la sauvegarde chiffrée (MH-06).
    'idle', // suspendre le swarm quand l'utilisateur est absent.
  ],

  host_permissions: E2E
    ? ['https://x.com/*', 'https://twitter.com/*', ...E2E_MATCHES]
    : ['https://x.com/*', 'https://twitter.com/*'],

  // Demandés au runtime, selon le provider que l'utilisateur configure lui-même.
  // Pas d'api.twitter.com : le produit ne publie pas via l'API X (décision D-04).
  optional_host_permissions: [
    'https://openrouter.ai/*',
    'https://api.anthropic.com/*',
    'https://api.openai.com/*',
    'https://generativelanguage.googleapis.com/*',
    'https://api.x.ai/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
  ],

  commands: {
    'kill-switch': {
      suggested_key: { default: 'Alt+Shift+K' },
      description: 'Kill switch : arrête le swarm et vide la file d’actions en attente',
    },
    'open-panel': {
      suggested_key: { default: 'Alt+Shift+S' },
      description: 'Ouvrir le side panel SWARM',
    },
  },

  // 'wasm-unsafe-eval' : requis par le runtime ONNX des embeddings locaux (ADR 0002)
  // et par hnswlib-wasm. Aucune autre source de script n'est autorisée.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },

  web_accessible_resources: [
    {
      resources: ['assets/*', 'wasm/*'],
      matches: E2E
        ? ['https://x.com/*', 'https://twitter.com/*', ...E2E_MATCHES]
        : ['https://x.com/*', 'https://twitter.com/*'],
    },
  ],

  icons: {
    16: 'icons/16.png',
    32: 'icons/32.png',
    48: 'icons/48.png',
    128: 'icons/128.png',
  },
})
