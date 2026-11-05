/**
 * BRIEF D'IMAGE — Phase 8.
 *
 * Le test qui porte tout : **un chiffre absent du brouillon ne doit jamais être autorisé dans
 * l'image**. Un graphique inventé publié depuis un compte de projet est un mensonge, et il ne
 * se rattrape pas par un post de suivi.
 */
import { describe, expect, it } from 'vitest'
import {
  ALT_TEXT_LIMIT,
  IMAGE_GENERATION_IMPLEMENTED,
  IMAGE_PROVIDERS,
  buildAltText,
  buildImageBrief,
  extractFactualNumbers,
  pickRegister,
} from '@/swarm/media/image-brief'
import { NichePackSchema } from '@/niches/pack.schema'

const pack = NichePackSchema.parse({
  id: 'test-pack',
  version: '1.0.0',
  label: 'Pack de test',
  domainBrief: 'Une niche de test avec suffisamment de texte pour passer la validation Zod.',
  lexicon: { preferred: [], banned: ['moon', 'pump'] },
})

describe('choix du registre', () => {
  it('deux chiffres ou plus → graphique', () => {
    expect(pickRegister('60 % de la liquidité part en 48 heures')).toBe('data')
  })

  it('aucune comparaison chiffrée → schéma', () => {
    // On préfère se tromper vers le registre qui n'invente rien.
    expect(pickRegister('la distribution décide de tout')).toBe('diagram')
  })

  it('la consigne de l’auteur prime sur l’heuristique', () => {
    expect(pickRegister('60 % en 48 heures', 'plutôt une illustration')).toBe('scene')
    expect(pickRegister('aucune donnée ici', 'fais un graph')).toBe('data')
  })
})

describe('extraction des chiffres', () => {
  it('relève les valeurs avec leur unité', () => {
    const numbers = extractFactualNumbers('60 % en 48 heures, sur 3 mois et 12 k holders')
    expect(numbers.join('|')).toContain('60 %')
    expect(numbers.join('|')).toContain('48 heures')
    expect(numbers.join('|')).toContain('12 k')
  })

  it('déduplique', () => {
    const numbers = extractFactualNumbers('60 % puis encore 60 %')
    expect(numbers.filter((n) => n.startsWith('60')).length).toBe(1)
  })

  it('ne renvoie rien sur un texte sans chiffre', () => {
    expect(extractFactualNumbers('aucune valeur ici')).toEqual([])
  })
})

describe('construction du brief', () => {
  it('N’AUTORISE que les chiffres présents dans le brouillon', () => {
    // Le garde-fou central du module.
    const brief = buildImageBrief({
      draftText: 'La liquidité chute de 60 % en 48 heures après le lancement.',
      pack,
    })
    expect(brief.prompt).toContain('Chiffres autorisés')
    expect(brief.prompt).toContain('60 %')
    expect(brief.prompt).toContain("N'ajoute aucune valeur")
  })

  it('dit explicitement de ne pas produire de graphique quand il n’y a pas de chiffre', () => {
    // Registre « données » sans donnée : on nomme la contradiction au lieu de la laisser
    // combler par le générateur.
    const brief = buildImageBrief({
      draftText: 'Une idée sans aucune donnée derrière.',
      pack,
      userHint: 'fais un graph',
    })
    expect(brief.prompt).toContain('ne produis aucun graphique chiffré')
  })

  it('reporte le vocabulaire banni du pack', () => {
    const brief = buildImageBrief({ draftText: 'Un texte neutre.', pack })
    expect(brief.prompt).toContain('moon')
  })

  it('interdit visages, logos et marques dans tous les cas', () => {
    const brief = buildImageBrief({ draftText: 'Un texte neutre.', pack })
    expect(brief.prompt).toContain('aucun visage')
    expect(brief.prompt).toContain('aucun logo')
  })

  it('avertit sur la vérification des chiffres, en premier', () => {
    const brief = buildImageBrief({
      draftText: 'Chute de 60 % en 48 heures.',
      pack,
    })
    expect(brief.cautions[0]).toContain('Vérifie chaque valeur')
  })

  it('rappelle toujours que l’ajout au post est manuel', () => {
    const brief = buildImageBrief({ draftText: 'Un texte neutre.', pack })
    expect(brief.cautions.join(' ')).toContain('manuel')
  })

  it('est déterministe', () => {
    const input = { draftText: 'Chute de 60 % en 48 heures.', pack }
    expect(buildImageBrief(input)).toEqual(buildImageBrief(input))
  })
})

describe('texte alternatif', () => {
  it('décrit le registre et le sujet', () => {
    expect(buildAltText('La liquidité chute vite. Et ensuite ?', 'data')).toBe(
      'Graphique illustrant : La liquidité chute vite',
    )
  })

  it('respecte la limite de X', () => {
    const alt = buildAltText('a'.repeat(3_000), 'diagram')
    expect(alt.length).toBeLessThanOrEqual(ALT_TEXT_LIMIT)
    expect(alt.endsWith('…')).toBe(true)
  })
})

describe('garde-fou de dépense', () => {
  it('aucun fournisseur d’images n’est livré — le produit ne dépense rien en images', () => {
    // À 1 €/jour, deux images mangeraient le budget de qualification de la journée entière.
    expect(IMAGE_PROVIDERS).toHaveLength(0)
    expect(IMAGE_GENERATION_IMPLEMENTED).toBe(false)
  })
})
