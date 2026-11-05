/**
 * GARDE : aucun secret ne peut atterrir dans le bundle.
 *
 * ## Le scénario exact qu'on empêche
 *
 * Un `.env` existe maintenant à la racine, pour les scripts de mesure. Vite le charge
 * automatiquement et expose au code client **toute variable préfixée `VITE_`**. Il suffit donc
 * de nommer une variable `VITE_OPENROUTER_KEY` — ce qui paraît naturel — pour que la clé soit
 * inlinée dans `dist/`, puis empaquetée dans le zip, puis publiée au Chrome Web Store. Aucune
 * erreur ne se produirait : l'extension marcherait, mieux même, puisqu'elle n'aurait plus
 * besoin du coffre.
 *
 * C'est exactement pour ça que c'est dangereux. Deux contrôles, complémentaires :
 *
 *  1. **Statique** : `src/` ne lit aucune variable d'environnement autre que `MODE`.
 *  2. **Sur le bundle** : si `dist/` existe, il ne contient aucun motif de clé.
 *
 * Le second est le plus important, et il ne peut pas être garanti par relecture : il regarde
 * l'artefact qu'on livre, pas l'intention du code.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseEnvFile, checkOpenRouterKey, keyFingerprint } from '../../../scripts/lib/env.ts'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const DIST = join(ROOT, 'dist')

function walk(dir: string, exts: RegExp): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, exts))
    else if (exts.test(entry)) out.push(full)
  }
  return out
}

/**
 * Motifs de clés des providers visés. Volontairement larges : on préfère un faux positif — qui
 * se lève en dix secondes — à une clé publiée.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'OpenRouter', re: /sk-or-v1-[A-Za-z0-9]{20,}/ },
  { name: 'Anthropic', re: /sk-ant-[A-Za-z0-9-]{20,}/ },
  { name: 'OpenAI', re: /sk-proj-[A-Za-z0-9-]{20,}/ },
  { name: 'Google', re: /AIza[A-Za-z0-9_-]{30,}/ },
  { name: 'xAI', re: /xai-[A-Za-z0-9]{20,}/ },
]

describe('aucune variable d’environnement secrète exposée au client', () => {
  it('src/ ne lit que `MODE` depuis import.meta.env', () => {
    // Vite n'expose au client que `VITE_*` et quelques variables intégrées. Lire autre chose
    // est soit inutile, soit le début d'une fuite.
    const offenders: string[] = []
    for (const file of walk(SRC, /\.(ts|tsx)$/)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/import\.meta\.env\??\.([A-Za-z0-9_]+)/g)) {
        const name = match[1]!
        if (name !== 'MODE' && name !== 'DEV' && name !== 'PROD' && name !== 'BASE_URL') {
          offenders.push(`${relative(ROOT, file)}: ${name}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('aucune variable `VITE_` n’est définie dans .env ni .env.example', () => {
    // La ligne rouge : un nom en `VITE_` suffit à inliner la valeur dans dist/.
    for (const name of ['.env', '.env.example']) {
      const path = join(ROOT, name)
      if (!existsSync(path)) continue
      const vars = Object.keys(parseEnvFile(readFileSync(path, 'utf8')))
      expect(
        vars.filter((v) => v.startsWith('VITE_')),
        `${name} définit une variable VITE_ — elle finirait dans le bundle`,
      ).toEqual([])
    }
  })

  it('`.env` est ignoré par git', () => {
    // Sans cette ligne, la première clé collée part au premier commit.
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    expect(gitignore).toMatch(/^\.env$/m)
  })

  it('`.env.example` ne contient AUCUNE valeur de clé', () => {
    // Le fichier est commité : il documente les noms, jamais les valeurs.
    const path = join(ROOT, '.env.example')
    if (!existsSync(path)) return
    const content = readFileSync(path, 'utf8')
    for (const { name, re } of SECRET_PATTERNS) {
      expect(re.test(content), `.env.example contient ce qui ressemble à une clé ${name}`).toBe(
        false,
      )
    }
    // Et la variable de clé y est vide, pas préremplie.
    const parsed = parseEnvFile(content)
    expect(parsed['SWARM_OPENROUTER_KEY'] ?? '').toBe('')
  })
})

describe('le bundle livré ne contient aucun secret', () => {
  /**
   * Ce test est **conditionnel à la présence de `dist/`**, et c'est assumé : il passe
   * trivialement sur une machine qui n'a pas encore construit. Ce qui compte est qu'il tourne
   * avant l'empaquetage, et `npm run check` est lancé dans la même séquence que `npm run
   * build`. La garde de dernier recours reste `scripts/build-zip.ts`.
   */
  it('dist/ ne contient aucun motif de clé API', () => {
    if (!existsSync(DIST)) {
      expect(true).toBe(true)
      return
    }
    const offenders: string[] = []
    for (const file of walk(DIST, /\.(js|html|json|css|map)$/)) {
      const text = readFileSync(file, 'utf8')
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(text)) offenders.push(`${relative(ROOT, file)}: motif ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('dist/ ne contient pas les noms de nos variables de script', () => {
    // Si `SWARM_OPENROUTER_KEY` apparaît dans le bundle, c'est que du code de script y a été
    // entraîné par un import — même sans valeur, c'est le signe d'une frontière franchie.
    if (!existsSync(DIST)) return
    const offenders: string[] = []
    for (const file of walk(DIST, /\.(js|html)$/)) {
      if (readFileSync(file, 'utf8').includes('SWARM_OPENROUTER_KEY')) {
        offenders.push(relative(ROOT, file))
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('validation de la clé avant de dépenser un appel', () => {
  it('refuse une clé absente avec une instruction, pas une erreur', async () => {
    const check = checkOpenRouterKey(null)
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('.env')
  })

  it('reconnaît une clé d’un autre provider', async () => {
    // Le cas réel : on colle une clé Anthropic dans la variable OpenRouter. Un 401 nu ferait
    // chercher un problème de compte.
    const check = checkOpenRouterKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('sk-or-v1-')
  })

  it('détecte une clé tronquée', async () => {
    const check = checkOpenRouterKey('sk-or-v1-abc')
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('tronquée')
  })

  it('détecte un espace interne, signe d’un copier-coller coupé', async () => {
    // Les espaces de bord sont retirés par le chargeur ; un espace au milieu ne peut venir
    // que d'une sélection partielle, et le 401 qui s'ensuivrait ne le dirait pas.
    const check = checkOpenRouterKey(`sk-or-v1-${'a'.repeat(20)} ${'b'.repeat(20)}`)
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('espace')
  })

  it('accepte une clé bien formée', async () => {
    expect(checkOpenRouterKey(`sk-or-v1-${'a'.repeat(64)}`).ok).toBe(true)
  })

  it('l’empreinte ne révèle jamais le milieu de la clé', async () => {
    // L'empreinte sert à confirmer *quelle* clé est utilisée. Elle ne doit pas suffire à la
    // reconstituer, et elle ne va jamais dans un fichier — seulement sur le terminal.
    const key = `sk-or-v1-${'a'.repeat(20)}${'z'.repeat(20)}`
    const print = keyFingerprint(key)
    expect(print.length).toBeLessThan(20)
    expect(key.includes(print)).toBe(false)
  })
})

describe('parsing du .env', () => {
  it('ignore commentaires et lignes vides', () => {
    const parsed = parseEnvFile('# commentaire\n\nA=1\n  B = 2  \n')
    expect(parsed).toEqual({ A: '1', B: '2' })
  })

  it('retire les guillemets encadrants', () => {
    // Les coller est le réflexe le plus courant, et une clé entre guillemets échoue côté API
    // avec un message qui ne dit pas pourquoi.
    expect(parseEnvFile('K="sk-or-v1-abc"').K).toBe('sk-or-v1-abc')
    expect(parseEnvFile("K='sk-or-v1-abc'").K).toBe('sk-or-v1-abc')
  })

  it('garde une valeur contenant un `=`', () => {
    expect(parseEnvFile('URL=http://x/y?a=b').URL).toBe('http://x/y?a=b')
  })

  it('ignore une ligne sans `=`', () => {
    expect(parseEnvFile('juste du texte\nA=1')).toEqual({ A: '1' })
  })
})
