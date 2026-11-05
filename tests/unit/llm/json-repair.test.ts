import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildRepairInstruction, repairAndParse } from '@/llm/json-repair'

const Schema = z.object({
  variants: z.array(z.object({ text: z.string(), angle: z.string() })).min(1),
  confidence: z.number().min(0).max(1),
})

const valid = { variants: [{ text: 'salut', angle: 'question' }], confidence: 0.8 }

const SMART = String.fromCharCode(8220) // guillemet typographique ouvrant
const SMART_CLOSE = String.fromCharCode(8221)

describe('repairAndParse — SPEC §8', () => {
  it('accepte du JSON propre sans marquer de réparation', () => {
    const r = repairAndParse(JSON.stringify(valid), Schema)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.repaired).toBe(false)
      expect(r.value.value.confidence).toBe(0.8)
    }
  })

  it('retire un bloc markdown', () => {
    const r = repairAndParse('```json\n' + JSON.stringify(valid) + '\n```', Schema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.repaired).toBe(true)
  })

  it('isole le JSON dans un preambule bavard', () => {
    const raw = `Bien sur ! Voici le JSON demande :\n${JSON.stringify(valid)}\nDis-moi si tu veux autre chose.`
    const r = repairAndParse(raw, Schema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.value.variants[0]!.text).toBe('salut')
  })

  it('gere les accolades presentes dans le texte autour', () => {
    // Un indexOf('{') naif casserait ici : le comptage d'equilibre est necessaire.
    const raw = `Note : la syntaxe {cle} n'est pas utilisee. ${JSON.stringify(valid)}`
    expect(repairAndParse(raw, Schema).ok).toBe(true)
  })

  it('corrige les guillemets typographiques', () => {
    const key = (s: string): string => `${SMART}${s}${SMART_CLOSE}`
    const raw = `{${key('variants')}: [{${key('text')}: ${key('ok')}, ${key('angle')}: ${key('data')}}], ${key('confidence')}: 0.5}`
    const r = repairAndParse(raw, Schema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.repaired).toBe(true)
  })

  it('corrige une virgule trainante', () => {
    const raw = '{"variants": [{"text": "ok", "angle": "data"},], "confidence": 0.5,}'
    expect(repairAndParse(raw, Schema).ok).toBe(true)
  })

  it('gere les accolades a l interieur des chaines JSON', () => {
    const withBraces = {
      variants: [{ text: 'utilise {placeholder} ici', angle: 'data' }],
      confidence: 0.5,
    }
    const r = repairAndParse(`preambule ${JSON.stringify(withBraces)}`, Schema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.value.variants[0]!.text).toContain('{placeholder}')
  })

  it('extrait un tableau JSON de premier niveau', () => {
    const ArraySchema = z.array(z.object({ id: z.number() }))
    const r = repairAndParse('Voici : [{"id": 1}, {"id": 2}]', ArraySchema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.value).toHaveLength(2)
  })

  it('echoue proprement sur du JSON valide mais hors schema', () => {
    // Distinction importante : ce n'est pas un probleme de syntaxe, donc reessayer
    // d'autres extractions du meme texte ne sert a rien. On remonte l'ecart au schema.
    const r = repairAndParse('{"variants": [], "confidence": 3}', Schema)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.length).toBeGreaterThan(0)
      expect(r.error.join(' ')).toMatch(/variants|confidence/)
    }
  })

  it('echoue proprement quand il n y a aucun JSON', () => {
    const r = repairAndParse('Je ne peux pas repondre a cette demande.', Schema)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error[0]).toContain('aucun JSON')
  })

  it('ne lance jamais, quelle que soit l entree', () => {
    // Exigence de SPEC §8 : un LLM qui renvoie n'importe quoi ne casse jamais l'app.
    const inputs = ['', '{', '}}}', 'null', '[[[', ' ', '{"a":'.repeat(500), 'x']
    for (const raw of inputs) {
      expect(() => repairAndParse(raw, Schema)).not.toThrow()
      expect(repairAndParse(raw, Schema).ok).toBe(false)
    }
  })
})

describe('buildRepairInstruction', () => {
  it('est imperative et sans politesse', () => {
    // Les consignes polies produisent des preambules, exactement ce qu'on corrige.
    const instruction = buildRepairInstruction(['variants: tableau vide'])
    expect(instruction).toContain('variants')
    expect(instruction).toContain('Aucun texte avant')
    expect(instruction).not.toMatch(/merci/i)
  })

  it('borne le nombre de problemes rapportes', () => {
    const many = Array.from({ length: 50 }, (_, i) => `probleme ${i}`)
    const instruction = buildRepairInstruction(many)
    expect(instruction).not.toContain('probleme 20')
  })
})
