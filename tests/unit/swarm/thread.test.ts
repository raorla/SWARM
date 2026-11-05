/**
 * COMPOSEUR DE THREADS et écran d'avertissement — Phase 8.
 *
 * Deux propriétés portent la qualité ici :
 *
 *  1. **On ne coupe jamais au milieu d'une phrase.** Un thread coupé au caractère ne se lit
 *     pas post par post, ce qui annule l'intérêt du format. Mieux vaut refuser.
 *  2. **Le consentement d'autopilote ne peut pas s'obtenir par inadvertance.** Cocher est un
 *     réflexe ; recopier une phrase demande de lire.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_THREAD_POSTS,
  POST_CHAR_LIMIT,
  compareHooks,
  splitIntoThread,
  validateThread,
  type HookVariant,
} from '@/swarm/thread/thread-composer'
import {
  CONFIRMATION_PHRASE,
  isValidAutopilotConsent,
} from '@/sidepanel/tabs/config/AutopilotWarning'
import { AUTOPILOT_IMPLEMENTED } from '@/shared/env'

const sentence = (n: number): string => `Voici une phrase de test numéro ${n} sur la mécanique de liquidité et le float des holders.`

describe('découpage en thread', () => {
  it('un texte court n’est PAS un thread', () => {
    // Le numéroter serait absurde.
    const result = splitIntoThread('une réponse courte qui tient largement')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.thread.posts).toHaveLength(1)
    expect(result.thread.numbering).toBeNull()
    expect(result.thread.posts[0]?.text).not.toContain('1/1')
  })

  it('découpe aux frontières de paragraphe en priorité', () => {
    // Un paragraphe est une unité de sens plus forte qu'une phrase.
    const text = [sentence(1), sentence(2), sentence(3), sentence(4)].join('\n\n')
    const result = splitIntoThread(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const post of result.thread.posts) {
      // Aucun post ne doit finir au milieu d'un mot.
      const body = post.text.replace(/\n\n\d+\/\d+$/, '')
      expect(body.trim()).toMatch(/[.!?…]$/)
    }
  })

  it('descend au niveau de la phrase quand un paragraphe est trop long', () => {
    const longParagraph = Array.from({ length: 6 }, (_, i) => sentence(i)).join(' ')
    const result = splitIntoThread(longParagraph)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.thread.posts.length).toBeGreaterThan(1)
  })

  it('REFUSE plutôt que de couper un mot', () => {
    // Le point central : une phrase indivisible plus longue que la limite ne peut pas être
    // placée, et le dire vaut mieux que produire un thread illisible.
    const monster = 'a'.repeat(400)
    const result = splitIntoThread(monster)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('unsplittable')
    expect(result.error.detail).toContain('reformule')
  })

  it('numérote et réserve la place pour la numérotation', () => {
    const text = Array.from({ length: 5 }, (_, i) => sentence(i)).join('\n\n')
    const result = splitIntoThread(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const count = result.thread.posts.length
    expect(result.thread.posts[0]?.text).toContain(`1/${count}`)
    // Aucun post ne dépasse la limite malgré la numérotation ajoutée.
    for (const post of result.thread.posts) {
      expect(post.charCount, post.text).toBeLessThanOrEqual(POST_CHAR_LIMIT)
      expect(post.overLimit).toBe(false)
    }
  })

  it('peut se passer de numérotation', () => {
    const text = Array.from({ length: 4 }, (_, i) => sentence(i)).join('\n\n')
    const result = splitIntoThread(text, { numbered: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.thread.numbering).toBeNull()
    expect(result.thread.posts[0]?.text).not.toMatch(/\d+\/\d+/)
  })

  it('refuse un thread trop long', () => {
    // Un thread de vingt posts se lit comme un article mal placé.
    const text = Array.from({ length: 40 }, (_, i) => sentence(i)).join('\n\n')
    const result = splitIntoThread(text)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('too-long')
    expect(result.error.detail).toContain(String(MAX_THREAD_POSTS))
  })

  it('refuse un texte vide', () => {
    const result = splitIntoThread('   \n\n   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('empty')
  })

  it('est déterministe', () => {
    const text = Array.from({ length: 5 }, (_, i) => sentence(i)).join('\n\n')
    const a = splitIntoThread(text)
    const b = splitIntoThread(text)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('validation d’un thread', () => {
  it('valide un thread correct', () => {
    const text = Array.from({ length: 4 }, (_, i) => sentence(i)).join('\n\n')
    const result = splitIntoThread(text)
    if (!result.ok) throw new Error('découpage échoué')
    expect(validateThread(result.thread).valid).toBe(true)
  })

  it('détecte un post trop long', () => {
    const check = validateThread({
      posts: [{ index: 0, text: 'x'.repeat(400), charCount: 400, overLimit: true }],
      numbering: null,
      totalChars: 400,
    })
    expect(check.valid).toBe(false)
    expect(check.issues[0]).toContain(String(POST_CHAR_LIMIT))
  })

  it('détecte un post vide au milieu', () => {
    // Il casse la lecture et fait échouer la publication.
    const check = validateThread({
      posts: [
        { index: 0, text: 'premier', charCount: 7, overLimit: false },
        { index: 1, text: '   ', charCount: 3, overLimit: false },
      ],
      numbering: null,
      totalChars: 10,
    })
    expect(check.valid).toBe(false)
    expect(check.issues.join(' ')).toContain('vide')
  })

  it('détecte un thread vide', () => {
    const check = validateThread({ posts: [], numbering: null, totalChars: 0 })
    expect(check.valid).toBe(false)
  })
})

describe('A/B de hooks', () => {
  const hook = (text: string, style: HookVariant['style'] = 'claim'): HookVariant => ({
    text,
    style,
  })

  it('pénalise une ouverture annonçante', () => {
    // « Voici pourquoi… » dit qu'il va parler au lieu de parler.
    const result = compareHooks([
      hook('Voici pourquoi la plupart des lancements meurent en semaine deux, en détail.'),
    ])
    expect(result.notes[0]?.issues.join(' ')).toContain('annonçante')
  })

  it('pénalise un marqueur de thread explicite', () => {
    const result = compareHooks([
      hook('La distribution décide de tout, et presque personne ne le regarde. Thread 👇'),
    ])
    expect(result.notes[0]?.issues.join(' ')).toContain('marqueur de thread')
  })

  it('pénalise le format « N leçons »', () => {
    const result = compareHooks([
      hook('7 leçons que j’ai apprises en observant des centaines de lancements memecoin.'),
    ])
    expect(result.notes[0]?.issues.join(' ')).toContain('épuisé')
  })

  it('pénalise un hook trop long et un hook trop court', () => {
    const tooLong = compareHooks([hook('x'.repeat(250))])
    const tooShort = compareHooks([hook('court')])
    expect(tooLong.notes[0]?.issues.join(' ')).toContain('trop long')
    expect(tooShort.notes[0]?.issues.join(' ')).toContain('trop court')
  })

  it('valorise un chiffre concret et une prise de position', () => {
    const result = compareHooks([
      hook('La plupart des lancements perdent 60 % de leur liquidité en 48 heures.'),
    ])
    const strengths = result.notes[0]?.strengths.join(' ') ?? ''
    expect(strengths).toContain('chiffre')
    expect(strengths).toContain('position')
  })

  it('recommande la meilleure variante', () => {
    const result = compareHooks([
      hook('Voici 7 leçons sur les lancements memecoin, dans ce thread 🧵'),
      hook('La plupart des lancements perdent 60 % de leur liquidité en 48 heures.'),
    ])
    expect(result.recommended).toBe(1)
  })

  it('ne recommande RIEN quand aucune variante ne se distingue', () => {
    // Fabriquer un gagnant sur un écart nul ferait décider sur du bruit.
    const identical = compareHooks([
      hook('Une affirmation neutre de longueur correcte sur le sujet du jour.'),
      hook('Une autre affirmation neutre de longueur correcte sur le même sujet.'),
    ])
    expect(identical.recommended).toBeNull()
  })

  it('ne recommande rien si toutes les variantes sont mauvaises', () => {
    const allBad = compareHooks([hook('Voici 7 leçons 🧵'), hook('court')])
    expect(allBad.recommended).toBeNull()
  })
})

describe('consentement d’autopilote', () => {
  it('exige la phrase EXACTE', () => {
    // Cocher est un réflexe ; recopier demande de lire.
    expect(
      isValidAutopilotConsent({ acceptedAtMs: 1, phraseTyped: CONFIRMATION_PHRASE }),
    ).toBe(true)
    expect(isValidAutopilotConsent({ acceptedAtMs: 1, phraseTyped: 'oui' })).toBe(false)
    expect(isValidAutopilotConsent({ acceptedAtMs: 1, phraseTyped: 'je comprends' })).toBe(false)
  })

  it('tolère la casse et les espaces, pas le contenu', () => {
    expect(
      isValidAutopilotConsent({
        acceptedAtMs: 1,
        phraseTyped: `  ${CONFIRMATION_PHRASE.toUpperCase()}  `,
      }),
    ).toBe(true)
  })

  it('refuse sans horodatage ou sans phrase', () => {
    // Un consentement enregistré sans phrase est un consentement qu'on n'a pas obtenu.
    expect(
      isValidAutopilotConsent({ acceptedAtMs: null, phraseTyped: CONFIRMATION_PHRASE }),
    ).toBe(false)
    expect(isValidAutopilotConsent({ acceptedAtMs: 1, phraseTyped: null })).toBe(false)
  })

  it('la phrase énonce le RISQUE, pas une formule d’acceptation', () => {
    // « J'accepte les conditions » ne fait rien lire ; nommer la conséquence, si.
    expect(CONFIRMATION_PHRASE).toContain('suspendre')
    expect(CONFIRMATION_PHRASE).not.toMatch(/j.accepte les (conditions|termes)/i)
  })

  it('l’autopilote reste NON implémenté — accepter ne l’active pas (SPEC §4.6)', () => {
    // Le garde-fou final : c'est du code absent, pas un réglage désactivé.
    expect(AUTOPILOT_IMPLEMENTED).toBe(false)
  })
})
