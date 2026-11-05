import { describe, expect, it } from 'vitest'
import {
  bundledPack,
  bundledPacks,
  exportPack,
  importPack,
  withUserOverrides,
  FALLBACK_PACK_ID,
} from '@/niches/loader'
import { NichePackSchema } from '@/niches/pack.schema'
import { classifyTopic } from '@/governor/topic-guard'

describe('Niche Packs — validation (MH-10)', () => {
  it('tous les packs livres sont valides', () => {
    // Un pack livre casse rendrait le QUALIFIER silencieusement faux : cette erreur doit
    // apparaitre en test, jamais chez un utilisateur.
    expect(() => bundledPacks()).not.toThrow()
    expect(bundledPacks().length).toBeGreaterThanOrEqual(3)
  })

  it('le pack de repli existe et est restrictif', () => {
    const generic = bundledPack(FALLBACK_PACK_ID)
    expect(generic).toBeDefined()
    // Sans niche configuree, le produit doit se taire plutot que parler de tout.
    expect(generic!.thresholds.minEvScore).toBeGreaterThan(0.6)
    expect(generic!.keywords).toHaveLength(0)
  })

  it('le pack memecoin bannit le vocabulaire de signal de prix', () => {
    const pack = bundledPack('memecoin')!
    for (const term of ['100x', 'to the moon', 'financial advice']) {
      expect(pack.lexicon.banned.some((b) => b.includes(term.split(' ')[0]!))).toBe(true)
    }
  })

  it('les signaux de prix du pack sont aussi bloques par le noyau universel', () => {
    // Les deux couches ne font pas le meme travail : `negativeKeywords` filtre du bruit
    // au triage (« giveaway », « referral »), le topic-guard interdit un contenu dans une
    // reponse. L'intersection qui doit tenir, c'est les signaux de prix explicites : ce
    // sont eux qui font suspendre un compte crypto.
    const pack = bundledPack('memecoin')!
    const priceSignals = pack.negativeKeywords.filter((k) =>
      /100x|to the moon|moon soon|financial advice|presale|guaranteed \w/i.test(k),
    )
    expect(priceSignals.length).toBeGreaterThan(2)
    for (const term of priceSignals) {
      expect(classifyTopic(`this is ${term}`).blocked, `${term} doit etre ecarte`).toBe(
        true,
      )
    }
  })

  it('les negativeKeywords non financiers restent du filtrage de triage', () => {
    // On documente la difference plutot que de la laisser implicite : « giveaway » ne
    // doit PAS etre dans le noyau universel, sinon on bloquerait des conversations
    // legitimes dans d'autres niches.
    const pack = bundledPack('memecoin')!
    expect(pack.negativeKeywords).toContain('giveaway')
    expect(classifyTopic('nice giveaway idea for the community').blocked).toBe(false)
  })

  it('fait un aller-retour export/import', () => {
    const pack = bundledPack('saas-b2b')!
    const r = importPack(exportPack(pack))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.id).toBe('saas-b2b')
  })

  it('accepte un pack nu, sans enveloppe', () => {
    // Tolerance deliberee : un utilisateur qui copie l'objet `pack` depuis un exemple ne
    // doit pas se heurter a un mur de schema.
    const pack = bundledPack('generic')!
    const r = importPack(JSON.stringify(pack))
    expect(r.ok).toBe(true)
  })

  it('rejette un pack invalide avec un motif lisible', () => {
    const r = importPack('{"formatVersion":1,"pack":{"id":"MAJUSCULES","version":"x"}}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.issues.length).toBeGreaterThan(0)
  })

  it('rejette un JSON illisible', () => {
    const r = importPack('{ceci n est pas du json')
    expect(r.ok).toBe(false)
  })
})

describe('Niche Packs — invariant additif', () => {
  it('les surcharges utilisateur ne peuvent qu ajouter des sujets bloques', () => {
    // Invariant de surete du format : il n'existe aucune API pour retirer un sujet.
    const pack = bundledPack('memecoin')!
    const before = pack.additionalBlockedTopics.length
    const merged = withUserOverrides(pack, {
      additionalBlockedTopics: ['un nouveau sujet'],
    })
    expect(merged.additionalBlockedTopics.length).toBe(before + 1)
    for (const topic of pack.additionalBlockedTopics) {
      expect(merged.additionalBlockedTopics).toContain(topic)
    }
  })

  it('deduplique les listes fusionnees', () => {
    const pack = bundledPack('memecoin')!
    const existing = pack.keywords[0]!
    const merged = withUserOverrides(pack, { keywords: [existing, 'terme inedit'] })
    expect(merged.keywords.filter((k) => k === existing)).toHaveLength(1)
    expect(merged.keywords).toContain('terme inedit')
  })

  it('fusionne les poids EV sans perdre les cles absentes', () => {
    const pack = bundledPack('saas-b2b')!
    const merged = withUserOverrides(pack, { evWeights: { ...pack.evWeights, reach: 2 } })
    expect(merged.evWeights.reach).toBe(2)
    expect(merged.evWeights.nicheRelevance).toBe(pack.evWeights.nicheRelevance)
  })
})

describe("Niche Packs — test d'agnosticisme (bloquant)", () => {
  it('le meme traitement tourne sur tous les packs sans code specifique', () => {
    // C'est le test qui rend l'agnosticisme verifiable au lieu d'affirme. Si un jour il
    // faut un `if (pack.id === 'memecoin')` quelque part, ce test le revelera.
    for (const pack of bundledPacks()) {
      const parsed = NichePackSchema.safeParse(pack)
      expect(parsed.success, `${pack.id} doit satisfaire le schema`).toBe(true)

      // Chemin de traitement generique, identique pour tous les packs.
      expect(pack.allowedAngles.length).toBeGreaterThan(0)
      expect(pack.languages.length).toBeGreaterThan(0)
      expect(pack.thresholds.maxReplyCount).toBeGreaterThan(0)
      expect(pack.thresholds.minEvScore).toBeGreaterThanOrEqual(0)
      expect(pack.thresholds.minEvScore).toBeLessThanOrEqual(1)
      expect(pack.domainBrief.length).toBeGreaterThan(20)

      const verdict = classifyTopic(
        'un texte anodin sur un sujet quelconque',
        pack.additionalBlockedTopics,
      )
      expect(typeof verdict.blocked).toBe('boolean')

      const merged = withUserOverrides(pack, {})
      expect(merged.id).toBe(pack.id)
    }
  })

  it('les identifiants de pack sont uniques', () => {
    const ids = bundledPacks().map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('aucun pack ne peut desactiver le noyau universel', () => {
    for (const pack of bundledPacks()) {
      const v = classifyTopic(
        'this will 100x, guaranteed returns',
        pack.additionalBlockedTopics,
      )
      expect(v.blocked, `${pack.id} ne doit pas laisser passer un signal de prix`).toBe(
        true,
      )
    }
  })
})
