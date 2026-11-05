/**
 * GARDE D'EGRESS — l'invariant produit le plus facile à casser sans le remarquer.
 *
 * SPEC §1 : « Zéro donnée sortant du navigateur sauf vers le provider LLM choisi par
 * l'utilisateur. » C'est une promesse écrite dans `PRIVACY.md`, reprise dans la fiche du
 * Chrome Web Store, et attestée dans le formulaire d'utilisation limitée du magasin.
 *
 * Une promesse de ce genre ne se tient pas par relecture. Un `fetch` de télémétrie, un
 * Sentry ajouté « le temps de déboguer », une police Google chargée depuis un CSS : chacun
 * est une ligne, chacun passe en revue de code, et chacun rend la fiche mensongère. Ce test
 * lit donc les sources et refuse toute primitive réseau **hors de `src/llm/`**, qui est le
 * seul module autorisé à sortir.
 *
 * Il échouera un jour sur un ajout légitime. C'est voulu : la liste d'exceptions est le
 * bon endroit pour discuter d'un nouveau canal de sortie, et elle est courte exprès.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(process.cwd(), 'src')

/** Le seul répertoire autorisé à ouvrir une connexion sortante. */
const EGRESS_ALLOWED_PREFIX = 'llm/'

/**
 * Primitives d'egress. On cherche le nom, pas l'appel : `const f = fetch` compte aussi.
 */
const EGRESS_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'fetch', re: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket', re: /\bnew\s+WebSocket\b/ },
  { name: 'EventSource', re: /\bnew\s+EventSource\b/ },
  { name: 'sendBeacon', re: /\bsendBeacon\s*\(/ },
  { name: 'importScripts', re: /\bimportScripts\s*\(/ },
  // Un `<script src>` ou un `<img src>` construit à la main est un canal de sortie complet.
  { name: 'injection de script', re: /createElement\s*\(\s*['"`]script['"`]/ },
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(full)
  }
  return out
}

const files = walk(SRC).map((full) => ({
  rel: relative(SRC, full).split('\\').join('/'),
  text: readFileSync(full, 'utf8'),
}))

describe('aucune sortie réseau hors du client LLM', () => {
  it('les sources existent bien (le test ne passe pas par le vide)', () => {
    // Sans ça, une erreur de chemin transformerait ce test en test toujours vert.
    expect(files.length).toBeGreaterThan(50)
  })

  for (const { name, re } of EGRESS_PATTERNS) {
    it(`aucun \`${name}\` hors de src/${EGRESS_ALLOWED_PREFIX}`, () => {
      const offenders = files
        .filter(({ rel }) => !rel.startsWith(EGRESS_ALLOWED_PREFIX))
        .filter(({ text }) => re.test(text))
        .map(({ rel }) => rel)
      expect(offenders, `${name} trouvé dans : ${offenders.join(', ')}`).toEqual([])
    })
  }
})

describe('aucun endpoint de collecte', () => {
  /**
   * Hôtes admis dans les sources.
   *
   * `x.com`/`twitter.com` sont les cibles du content script ; les hôtes de fournisseurs
   * vivent dans `optional_host_permissions` et sont demandés à l'usage ; `localhost` sert
   * au provider local et aux fixtures E2E ; `schema.org`/`w3.org`/`json-schema.org`
   * apparaissent comme identifiants de schéma, jamais appelés.
   *
   * Deux entrées méritent leur justification, parce qu'elles ressemblent à ce que ce test
   * cherche :
   *
   *  - `example.invalid` — remplaçant des liens dans les snapshots de sélecteur cassé. Le
   *    TLD `.invalid` est réservé par la RFC 6761 et **ne résout jamais** : c'est
   *    précisément pourquoi il est utilisé plutôt qu'un domaine d'apparence neutre.
   *  - `github.com` — valeur de l'en-tête `HTTP-Referer` d'OpenRouter, qui identifie
   *    l'application appelante. Ce n'est pas une destination : rien n'est envoyé là.
   */
  const ALLOWED_HOSTS = [
    'x.com',
    'twitter.com',
    'openrouter.ai',
    'api.anthropic.com',
    'api.openai.com',
    'generativelanguage.googleapis.com',
    'api.x.ai',
    'localhost',
    '127.0.0.1',
    'json-schema.org',
    'schema.org',
    'w3.org',
    'developer.chrome.com',
    'chromewebstore.google.com',
    'help.x.com',
    'docs.x.com',
    'example.invalid',
    'github.com',
  ]

  it('toute URL http(s) présente dans les sources est sur un hôte admis', () => {
    const found = new Map<string, string[]>()
    for (const { rel, text } of files) {
      for (const url of text.match(/https?:\/\/[^\s'"`)*,;]+/g) ?? []) {
        let host: string
        try {
          host = new URL(url).hostname
        } catch {
          continue
        }
        if (ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
          continue
        }
        found.set(host, [...(found.get(host) ?? []), rel])
      }
    }
    expect(
      [...found.entries()].map(([host, where]) => `${host} (${where.join(', ')})`),
      'hôte inattendu dans les sources',
    ).toEqual([])
  })

  it('aucun SDK de télémétrie n’est importé', () => {
    // Le mode de défaillance réel : personne n'écrit `fetch('https://collecte')`, on installe
    // une dépendance qui le fait.
    const TELEMETRY = ['sentry', 'posthog', 'mixpanel', 'amplitude', 'datadog', 'gtag', 'analytics.js']
    const offenders: string[] = []
    for (const { rel, text } of files) {
      for (const sdk of TELEMETRY) {
        if (new RegExp(`from\\s+['"\`][^'"\`]*${sdk}`, 'i').test(text)) {
          offenders.push(`${sdk} → ${rel}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('aucune clé ne peut partir dans une URL', () => {
  it('aucun gabarit d’URL n’interpole de secret', () => {
    // SPEC §1 : « jamais dans une URL ». Une clé en query string finit dans les logs du
    // fournisseur, dans le referer, et dans l'historique — trois endroits qu'on ne contrôle
    // pas et qu'on ne peut pas nettoyer après coup.
    const offenders: string[] = []
    for (const { rel, text } of files) {
      for (const line of text.split('\n')) {
        if (!/https?:\/\/|`\/|\?/.test(line)) continue
        if (/[?&](?:api_?key|key|token|secret|passphrase)=/i.test(line)) {
          offenders.push(`${rel}: ${line.trim().slice(0, 100)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
