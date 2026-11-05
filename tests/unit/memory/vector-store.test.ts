/**
 * EMBEDDINGS LOCAUX et anti-répétition — ADR 0002 et différenciateur n°3.
 *
 * Le bloc le plus important est le troisième : il dit explicitement **ce que le hachage sait
 * et ne sait pas faire**. Il détecte la reformulation lexicale, pas la synonymie. Le tester
 * plutôt que le supposer évite qu'un futur lecteur croie l'anti-répétition sémantique plus
 * puissante qu'elle ne l'est — et prenne une décision de conception sur cette croyance.
 */
import { describe, expect, it } from 'vitest'
import {
  EMBEDDING_DIM,
  HashingEmbedder,
  cosineSimilarity,
  fromStorable,
  normalizeForEmbedding,
  normalizeVector,
  toStorable,
} from '@/memory/embeddings'
import { VectorStore, memoryVectorBackend } from '@/memory/vector-store'
import {
  NEAR_DUPLICATE_THRESHOLD,
  SAME_GROUND_THRESHOLD,
  checkRedundancy,
  redundancyNote,
  shouldBlock,
} from '@/memory/dedupe'
import { FakeClock } from '@/shared/time'

const embedder = new HashingEmbedder()
const clock = new FakeClock('2026-08-25T12:00:00.000Z')

const store = (): VectorStore => new VectorStore(memoryVectorBackend(), embedder, clock)

describe('embedder par hachage', () => {
  it('produit un vecteur normalisé de dimension fixe', async () => {
    const vector = await embedder.embed('locked liquidity is table stakes now')
    expect(vector).toHaveLength(EMBEDDING_DIM)
    const norm = Math.sqrt([...vector].reduce((sum, v) => sum + v * v, 0))
    expect(norm).toBeCloseTo(1, 5)
  })

  it('est déterministe', async () => {
    const a = await embedder.embed('the float is the actual signal')
    const b = await embedder.embed('the float is the actual signal')
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6)
  })

  it('ignore casse, diacritiques et ponctuation', async () => {
    // Sans ça, l'anti-répétition passerait à côté d'une reformulation triviale.
    const a = await embedder.embed('La liquidité est verrouillée !')
    const b = await embedder.embed('la liquidite est verrouillee')
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.9)
  })

  it('ignore les URL', async () => {
    const withUrl = await embedder.embed('regarde ça https://example.com/a/b/c vraiment')
    const without = await embedder.embed('regarde ça vraiment')
    expect(cosineSimilarity(withUrl, without)).toBeGreaterThan(0.85)
  })

  it('résiste aux variations d’accord et aux troncatures', async () => {
    // Les n-grammes de caractères plutôt que de mots : « holders » et « holder » partagent la
    // quasi-totalité de leurs trigrammes.
    const a = await embedder.embed('les holders decident du float')
    const b = await embedder.embed('le holder decide du float')
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.6)
  })

  it('discrimine deux textes sans rapport', async () => {
    const a = await embedder.embed('locked liquidity and bonding curves on solana')
    const b = await embedder.embed('la retention par cohorte et le churn en saas b2b')
    expect(cosineSimilarity(a, b)).toBeLessThan(0.35)
  })

  it('renvoie un vecteur nul sur un texte vide', async () => {
    const vector = await embedder.embed('   !!!   ')
    expect([...vector].every((v) => v === 0)).toBe(true)
    // Et la similarité avec quoi que ce soit vaut zéro, pas NaN.
    const other = await embedder.embed('un texte réel')
    expect(cosineSimilarity(vector, other)).toBe(0)
  })

  it('la normalisation ne divise jamais par zéro', () => {
    const zero = normalizeVector(new Float32Array(EMBEDDING_DIM))
    expect([...zero].every((v) => v === 0)).toBe(true)
  })

  it('normalizeForEmbedding produit une forme comparable', () => {
    expect(normalizeForEmbedding('Liquidité,  VERROUILLÉE !!')).toBe('liquidite verrouillee')
  })

  it('survit à l’aller-retour de sérialisation', async () => {
    // `Float32Array` ne survit pas au clonage structuré de Dexie.
    const original = await embedder.embed('un texte de test')
    const restored = fromStorable(toStorable(original))
    expect(cosineSimilarity(original, restored)).toBeCloseTo(1, 6)
  })
})

describe('vector store', () => {
  it('indexe et retrouve', async () => {
    const vs = store()
    await vs.index('ourPost', 'p1', 'locked liquidity is table stakes now')
    await vs.index('ourPost', 'p2', 'la retention par cohorte est le vrai sujet')

    const hits = await vs.search('locked liquidity matters')
    expect(hits[0]?.refId).toBe('p1')
    expect(await vs.size()).toBe(2)
  })

  it('l’indexation est idempotente sur (refType, refId)', async () => {
    const vs = store()
    await vs.index('ourPost', 'p1', 'première version')
    await vs.index('ourPost', 'p1', 'version corrigée')
    expect(await vs.size()).toBe(1)
  })

  it('filtre par type de référence', async () => {
    const vs = store()
    await vs.index('ourPost', 'p1', 'locked liquidity is table stakes')
    await vs.index('opportunity', 'o1', 'locked liquidity is table stakes')

    const hits = await vs.search('locked liquidity', { refType: 'ourPost' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.refType).toBe('ourPost')
  })

  it('applique le seuil AVANT le tri', async () => {
    // Renvoyer les 5 plus proches d'un corpus sans rapport donnerait cinq résultats non
    // pertinents avec l'apparence d'un succès.
    const vs = store()
    await vs.index('ourPost', 'p1', 'la retention par cohorte et le churn')
    const hits = await vs.search('bonding curves on solana', { minSimilarity: 0.5 })
    expect(hits).toHaveLength(0)
  })

  it('respecte la limite', async () => {
    const vs = store()
    for (let i = 0; i < 10; i++) {
      await vs.index('ourPost', `p${i}`, `locked liquidity note numéro ${i}`)
    }
    expect(await vs.search('locked liquidity', { limit: 3 })).toHaveLength(3)
  })

  it('supprime une référence', async () => {
    const vs = store()
    await vs.index('ourPost', 'p1', 'un texte')
    await vs.remove('ourPost', 'p1')
    expect(await vs.size()).toBe(0)
  })
})

describe('ce que le hachage sait et NE SAIT PAS faire', () => {
  it('détecte la reformulation lexicale', async () => {
    // Ce pour quoi il est là : on se répète généralement avec les mêmes mots.
    const a = await embedder.embed('locked liquidity is table stakes now')
    const b = await embedder.embed('now, locked liquidity is table stakes')
    expect(cosineSimilarity(a, b)).toBeGreaterThan(NEAR_DUPLICATE_THRESHOLD)
  })

  it('LIMITE CONNUE : ne détecte pas la synonymie', async () => {
    // « liquidité verrouillée » et « LP lock » désignent la même chose et ne partagent aucun
    // n-gramme. Le hachage ne peut pas le voir, et le prétendre serait mentir sur ce que
    // l'anti-répétition garantit.
    //
    // C'est assumé, pas ignoré : c'est ce qu'apportera l'embedder ONNX de l'Offscreen
    // Document. En attendant, l'anti-répétition attrape la reformulation — le cas le plus
    // fréquent — et laisse passer la paraphrase.
    const a = await embedder.embed('la liquidite est verrouillee pour six mois')
    const b = await embedder.embed('le LP lock court sur un semestre')
    expect(cosineSimilarity(a, b)).toBeLessThan(SAME_GROUND_THRESHOLD)
  })
})

describe('anti-répétition', () => {
  async function withHistory(texts: readonly string[]): Promise<VectorStore> {
    const vs = store()
    for (const [index, text] of texts.entries()) {
      await vs.index('ourPost', `p${index}`, text)
    }
    return vs
  }

  it('bloque un quasi-doublon', async () => {
    const vs = await withHistory(['locked liquidity is table stakes now'])
    const check = await checkRedundancy('now locked liquidity is table stakes', vs)
    expect(check.verdict).toBe('near-duplicate')
    expect(shouldBlock(check)).toBe(true)
    expect(check.explanation).toContain('use l’audience')
  })

  it('signale le même terrain SANS bloquer', async () => {
    // Bloquer sur toute similarité rendrait le produit muet dans une niche où l'on parle
    // toujours des mêmes dix sujets.
    const vs = await withHistory(['locked liquidity is table stakes now'])
    const check = await checkRedundancy(
      'locked liquidity is table stakes, but the float matters more than that',
      vs,
    )
    if (check.verdict === 'same-ground') {
      expect(shouldBlock(check)).toBe(false)
      expect(check.explanation).toContain('à vérifier, pas à bloquer')
    } else {
      // Selon le recouvrement lexical, le verdict peut être `unique` : les deux sont des
      // réponses acceptables, l'important est de ne pas bloquer.
      expect(shouldBlock(check)).toBe(false)
    }
  })

  it('laisse passer un texte réellement nouveau', async () => {
    const vs = await withHistory(['locked liquidity is table stakes now'])
    const check = await checkRedundancy('la retention par cohorte est le vrai sujet', vs)
    expect(check.verdict).toBe('unique')
    expect(redundancyNote(check)).toBeNull()
  })

  it('un corpus vide DIT qu’il ne garantit rien', async () => {
    // Un `unique` silencieux laisserait croire à une vérification réussie.
    const check = await checkRedundancy('un texte quelconque', store())
    expect(check.verdict).toBe('unique')
    expect(check.explanation).toContain("pas une garantie d’originalité")
  })

  it('les seuils sont réglables', async () => {
    const vs = await withHistory(['locked liquidity is table stakes now'])
    const strict = await checkRedundancy('locked liquidity matters a lot here', vs, {
      nearDuplicateThreshold: 0.3,
      sameGroundThreshold: 0.2,
    })
    const lax = await checkRedundancy('locked liquidity matters a lot here', vs, {
      nearDuplicateThreshold: 0.99,
      sameGroundThreshold: 0.98,
    })
    expect(strict.verdict).toBe('near-duplicate')
    expect(lax.verdict).toBe('unique')
  })

  it('remonte les voisins les plus proches, triés', async () => {
    const vs = await withHistory([
      'locked liquidity is table stakes now',
      'locked liquidity matters here',
      'la retention par cohorte',
    ])
    const check = await checkRedundancy('locked liquidity is table stakes', vs, { limit: 3 })
    expect(check.closest.length).toBeGreaterThan(0)
    for (let i = 1; i < check.closest.length; i++) {
      expect(check.closest[i]!.similarity).toBeLessThanOrEqual(check.closest[i - 1]!.similarity)
    }
  })

  it('la note pour le CRITIC est absente quand il n’y a rien à signaler', async () => {
    const vs = await withHistory(['un sujet totalement autre'])
    const check = await checkRedundancy('bonding curves on solana', vs)
    expect(redundancyNote(check)).toBeNull()
  })
})
