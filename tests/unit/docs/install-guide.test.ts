/**
 * INSTALL.md ne doit pas mentir sur les valeurs par défaut.
 *
 * Un guide qui annonce « 12 réponses par jour » alors que le code en autorise 25 est pire qu'un
 * guide absent : le lecteur croit connaître le comportement du produit. Et ces chiffres sont
 * exactement ceux qu'on ajuste sans penser à relire la doc.
 *
 * Le test lit le guide et le compare aux constantes. Il échouera au prochain changement de
 * plafond — c'est le but.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CAPS, DEFAULT_CADENCE, DEFAULT_WINDOW } from '@/governor/types'
import { DEFAULT_BUDGET } from '@/llm/budget'
import { DEFAULT_VETO_THRESHOLD } from '@/swarm/schemas/critic.io'
import { HARD_LIMITS } from '@/background/settings.handler'
import { bundledPacks } from '@/niches/loader'

const guide = readFileSync(join(process.cwd(), 'INSTALL.md'), 'utf8')

describe('INSTALL.md — les chiffres annoncés sont ceux du code', () => {
  it('plafonds par défaut et maximums', () => {
    expect(guide).toContain(`| Réponses / jour | ${DEFAULT_CAPS.reply} | ${HARD_LIMITS.reply} |`)
    expect(guide).toContain(`| Posts / jour | ${DEFAULT_CAPS.post} | ${HARD_LIMITS.post} |`)
  })

  it('follows et DM sont annoncés à zéro, et le sont', () => {
    // La promesse la plus lue du guide, et celle dont une régression serait la plus grave.
    expect(DEFAULT_CAPS.follow).toBe(0)
    expect(DEFAULT_CAPS.dm).toBe(0)
    expect(HARD_LIMITS.follow).toBe(0)
    expect(HARD_LIMITS.dm).toBe(0)
    expect(guide).toMatch(/Follows, DM \/ jour \| \*\*0\*\*/)
  })

  it('cadence', () => {
    expect(guide).toContain(`${DEFAULT_CADENCE.minMinutes} à ${DEFAULT_CADENCE.maxMinutes} min`)
    expect(guide).toContain(`plancher de ${HARD_LIMITS.cadenceMinMinutes} min`)
  })

  it('fenêtre active', () => {
    const hh = (minutes: number): string =>
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    expect(guide).toContain(`${hh(DEFAULT_WINDOW.startMinute)} → ${hh(DEFAULT_WINDOW.endMinute)}`)
  })

  it('budget', () => {
    expect(guide).toContain(
      `| Budget / jour | ${DEFAULT_BUDGET.dailyEur} € | ${HARD_LIMITS.budgetEur} € |`,
    )
  })

  it('seuil de veto du CRITIC', () => {
    // Écrit avec une virgule décimale, comme partout dans la doc française.
    expect(guide).toContain(String(DEFAULT_VETO_THRESHOLD).replace('.', ','))
  })

  it('les packs livrés sont ceux que le guide nomme', () => {
    for (const pack of bundledPacks()) {
      expect(guide, `le pack « ${pack.id} » n'est pas nommé dans INSTALL.md`).toContain(
        `\`${pack.id}\``,
      )
    }
  })

  /**
   * `ManifestV3Export` est une union (objet, promesse, ou fonction) : le type public ne permet
   * pas de lire un champ directement. Le cast est borné aux deux champs lus ici, et un test qui
   * échoue si le champ disparaît vaut mieux qu'un test qui ne le lit pas.
   */
  const loadManifest = async (): Promise<{
    minimum_chrome_version?: string
    commands?: Record<string, { suggested_key?: { default?: string } }>
  }> => {
    const mod = await import('@/manifest.config')
    return mod.default as {
      minimum_chrome_version?: string
      commands?: Record<string, { suggested_key?: { default?: string } }>
    }
  }

  it('la version minimale de Chrome vient du manifest', async () => {
    const manifest = await loadManifest()
    expect(manifest.minimum_chrome_version).toBeDefined()
    expect(guide).toContain(`Chrome | ≥ ${manifest.minimum_chrome_version}`)
  })

  it('les raccourcis annoncés sont ceux du manifest', async () => {
    const manifest = await loadManifest()
    const commands = Object.entries(manifest.commands ?? {})
    expect(commands.length).toBeGreaterThan(0)
    for (const [name, def] of commands) {
      const key = def.suggested_key?.default
      expect(guide, `le raccourci de « ${name} » n'est pas dans INSTALL.md`).toContain(key ?? '—')
    }
  })

  it('le marqueur de démarrage cité pour le diagnostic est celui du code', () => {
    // Le guide dit d'inspecter `swarm:boot:step` : si la clé change, l'instruction devient fausse
    // au moment précis où quelqu'un en a besoin.
    const sw = readFileSync(join(process.cwd(), 'src/background/service-worker.ts'), 'utf8')
    expect(sw).toContain("'swarm:boot:step'")
    expect(sw).toContain("breadcrumb('listener-registered')")
    expect(guide).toContain('swarm:boot:step')
    expect(guide).toContain('listener-registered')
  })
})
