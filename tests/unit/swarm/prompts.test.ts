/**
 * Le hachage des prompts est le champ dont l'absence rendrait le différenciateur n°2
 * mensonger (FEEDBACK MH-04). Ces tests protègent cette propriété : un hash qui change
 * quand il ne devrait pas, ou qui ne change pas quand il devrait, casse la boucle
 * d'apprentissage en silence.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  availablePrompts,
  combinedHash,
  loadPrompt,
  resetPromptCache,
  SHARED_GUARDRAILS,
} from '@/swarm/prompts'

beforeEach(() => resetPromptCache())

describe('registre de prompts', () => {
  it('charge le prompt quick-reply', async () => {
    const p = await loadPrompt('quick-reply')
    expect(p.id).toBe('quick-reply')
    expect(p.content.length).toBeGreaterThan(500)
    expect(p.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('inclut les garde-fous partages dans le contenu assemble', async () => {
    const p = await loadPrompt('quick-reply')
    expect(p.content).toContain(
      'Regles non negociables'
        .replace('Regles', 'Règles')
        .replace('negociables', 'négociables'),
    )
    expect(p.content).toContain('deuil')
  })

  it('les garde-fous couvrent les interdits de SPEC 2.2', async () => {
    // Le prompt doit enoncer ce que le topic-guard applique : les deux couches doivent
    // dire la meme chose, sinon le modele produit ce que le code rejette ensuite.
    for (const forbidden of [
      'prix',
      'investissement',
      'sante',
      'deuil',
      'politique',
      'crise',
    ]) {
      const normalized = SHARED_GUARDRAILS.normalize('NFD').replace(/[̀-ͯ]/g, '')
      expect(normalized.toLowerCase(), forbidden).toContain(forbidden)
    }
  })

  it('lance sur un prompt non enregistre au lieu de renvoyer du vide', async () => {
    // Une chaine vide passerait silencieusement et produirait un comportement de modele
    // sans consigne : le pire des deux mondes.
    // @ts-expect-error identifiant volontairement invalide
    await expect(loadPrompt('inexistant')).rejects.toThrow(/non enregistr/)
  })

  it('memorise le resultat : meme hash a chaque appel', async () => {
    const a = await loadPrompt('quick-reply')
    const b = await loadPrompt('quick-reply')
    expect(b.hash).toBe(a.hash)
    expect(b).toBe(a)
  })

  it('le hash survit au vidage du cache', async () => {
    // Le hash doit etre une fonction pure du contenu : sinon deux sessions attribueraient
    // des identites differentes au meme prompt, et l'apprentissage comparerait des choses
    // non comparables.
    const before = (await loadPrompt('quick-reply')).hash
    resetPromptCache()
    expect((await loadPrompt('quick-reply')).hash).toBe(before)
  })

  it('liste les prompts disponibles sans pretendre aux autres', () => {
    // Les prompts des phases suivantes (qualifier, strategist, analyst) ne doivent pas
    // apparaitre comme disponibles : `loadPrompt` lance dessus plutot que de renvoyer du vide.
    expect([...availablePrompts()].sort()).toEqual([
      'critic',
      'qualifier',
      'quick-reply',
      'writer',
    ])
  })

  it('charge les prompts de rédaction et de triage avec leurs garde-fous', async () => {
    // Le QUALIFIER les reçoit aussi : il doit reconnaitre les sujets interdits pour les
    // noter a zero, ce qui est le premier filtre avant toute depense de redaction.
    for (const id of ['writer', 'critic', 'qualifier'] as const) {
      const p = await loadPrompt(id)
      expect(p.content.length, id).toBeGreaterThan(800)
      expect(p.content, id).toContain('deuil')
      expect(p.hash, id).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('chaque prompt a un hash distinct', async () => {
    // Deux prompts au meme hash rendraient l'attribution de performance impossible (MH-04).
    const hashes = await Promise.all(
      (['quick-reply', 'writer', 'critic'] as const).map(
        async (id) => (await loadPrompt(id)).hash,
      ),
    )
    expect(new Set(hashes).size).toBe(3)
  })
})

describe('combinedHash', () => {
  it('est stable independamment de l ordre des agents', async () => {
    // L'ordre d'appel ne doit pas changer l'identite de la combinaison : sinon deux
    // actions identiques paraitraient produites differemment.
    const a = await combinedHash([
      { role: 'writer', hash: 'aaaa' },
      { role: 'critic', hash: 'bbbb' },
    ])
    const b = await combinedHash([
      { role: 'critic', hash: 'bbbb' },
      { role: 'writer', hash: 'aaaa' },
    ])
    expect(a).toBe(b)
  })

  it('change si un seul hash de la chaine change', async () => {
    const a = await combinedHash([{ role: 'writer', hash: 'aaaa' }])
    const b = await combinedHash([{ role: 'writer', hash: 'aaab' }])
    expect(a).not.toBe(b)
  })

  it('distingue le meme hash sur des roles differents', async () => {
    const a = await combinedHash([{ role: 'writer', hash: 'same' }])
    const b = await combinedHash([{ role: 'critic', hash: 'same' }])
    expect(a).not.toBe(b)
  })

  it('produit une chaine de longueur fixe', async () => {
    expect(await combinedHash([])).toMatch(/^[0-9a-f]{16}$/)
    expect(
      await combinedHash([
        { role: 'writer', hash: 'a' },
        { role: 'critic', hash: 'b' },
        { role: 'analyst', hash: 'c' },
      ]),
    ).toMatch(/^[0-9a-f]{16}$/)
  })
})
