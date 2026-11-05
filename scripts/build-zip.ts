/**
 * Empaquetage pour le Chrome Web Store.
 *
 * Volontairement minimal et sans dépendance : il archive `dist/` tel quel, après avoir
 * vérifié que le build a bien produit ce que le manifest promet. Un zip qui référence un
 * fichier absent est refusé en review, et le message d'erreur du CWS n'aide pas à trouver
 * lequel — d'où la vérification ici.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
const OUT_DIR = 'dist-zip'

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (!existsSync(DIST)) fail('dist/ absent — lance `npm run build` d’abord.')

const manifestPath = join(DIST, 'manifest.json')
if (!existsSync(manifestPath)) fail('dist/manifest.json absent.')

const manifestRaw = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(manifestRaw) as {
  version: string
  side_panel?: { default_path?: string }
  background?: { service_worker?: string }
  icons?: Record<string, string>
  content_scripts?: { matches?: string[] }[]
}

/**
 * Le build E2E ne doit JAMAIS partir au Chrome Web Store.
 *
 * `npm run e2e` construit avec `SWARM_E2E=1`, ce qui ajoute `http://localhost:4319/*` aux
 * cibles du content script pour servir les fixtures DOM localement. Ce bundle reste dans
 * `dist/`, et un `npm run zip` enchaîné juste après empaquetterait donc une extension qui
 * s'injecte dans des pages locales — refus en review dans le meilleur cas, surface d'attaque
 * gratuite dans le pire. C'est arrivé la première fois que les deux commandes ont été
 * lancées de suite ; la garde vient de là.
 *
 * On contrôle les **cibles d'injection**, pas la présence du mot « localhost » dans le
 * fichier : `optional_host_permissions` contient légitimement `http://localhost/*` pour le
 * provider LLM local (Ollama, LM Studio), qui est la seule configuration où aucune donnée ne
 * quitte la machine. Un scan textuel refuserait ce cas légitime — première version de cette
 * garde, corrigée.
 */
const ALLOWED_CONTENT_MATCHES = new Set(['https://x.com/*', 'https://twitter.com/*'])
for (const script of manifest.content_scripts ?? []) {
  for (const match of script.matches ?? []) {
    if (!ALLOWED_CONTENT_MATCHES.has(match)) {
      fail(
        `le content script cible « ${match} », hors des domaines X — c'est un build E2E. ` +
          'Relance `npm run build` (sans SWARM_E2E) avant `npm run zip`.',
      )
    }
  }
}

/** Chaque chemin déclaré dans le manifest doit exister dans le bundle. */
const declared: (string | undefined)[] = [
  manifest.side_panel?.default_path,
  manifest.background?.service_worker,
  ...Object.values(manifest.icons ?? {}),
]

for (const rel of declared) {
  if (rel === undefined) continue
  if (!existsSync(join(DIST, rel))) fail(`le manifest déclare « ${rel} », absent du bundle.`)
}

/**
 * Le bundle du service worker doit contenir le routeur de messages.
 *
 * Garde de dernier recours contre le défaut le plus coûteux rencontré sur ce projet : les deux
 * entrées s'appelaient `index.ts`, @crxjs indexe par nom de base, et le loader du service worker
 * importait le chunk du **content script**. L'extension se chargeait et ne répondait à rien.
 *
 * On suit les imports relatifs depuis le loader et on cherche l'écouteur. Un test unitaire fait
 * déjà cette vérification, mais un zip se construit parfois sans lancer les tests.
 */
const swEntry = manifest.background?.service_worker
if (swEntry !== undefined) {
  const seen = new Set<string>()
  const queue = [swEntry]
  let bundled = ''
  while (queue.length > 0) {
    const rel = queue.pop()!
    if (seen.has(rel)) continue
    seen.add(rel)
    const full = join(DIST, rel)
    if (!existsSync(full)) continue
    const text = readFileSync(full, 'utf8')
    bundled += text
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/g)) {
      const target = match[1]!.slice(2)
      queue.push(dir === '' ? target : `${dir}/${target}`)
    }
  }
  if (!bundled.includes('onMessage.addListener')) {
    fail(
      `le bundle du service worker (« ${swEntry} ») ne contient aucun écouteur de messages : ` +
        'l’extension se chargerait sans répondre à rien. Vérifie que les noms de base des ' +
        'entrées du manifest sont distincts.',
    )
  }
  if (bundled.includes('data-swarm-anchor')) {
    fail(
      'le bundle du service worker contient le code du content script — collision d’entrées @crxjs.',
    )
  }
}

// L'offscreen document est créé au runtime, donc jamais listé dans le manifest — c'est
// exactement pour ça qu'on le vérifie explicitement.
if (!existsSync(join(DIST, 'src/offscreen/index.html'))) {
  fail('src/offscreen/index.html absent du bundle (entrée Rollup manquante ?).')
}

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const zipName = `swarm-${manifest.version}.zip`
execFileSync('zip', ['-r', '-q', join('..', OUT_DIR, zipName), '.'], { cwd: DIST })

console.log(`✓ ${OUT_DIR}/${zipName}`)
