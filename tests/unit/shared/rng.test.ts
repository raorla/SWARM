import { describe, expect, it } from 'vitest'
import { SeededRng, chance, gaussian, randomInt } from '@/shared/rng'

describe('SeededRng — reproductibilite (MH-17)', () => {
  it('produit la meme sequence a graine egale', () => {
    // Prerequis du backtest de la Phase 7 : sans ca, comparer deux configs n'a pas de sens.
    const a = new SeededRng(12345)
    const b = new SeededRng(12345)
    const seqA = Array.from({ length: 100 }, () => a.next())
    expect(Array.from({ length: 100 }, () => b.next())).toEqual(seqA)
  })

  it('produit des sequences differentes a graines differentes', () => {
    const a = new SeededRng(1)
    const b = new SeededRng(2)
    expect(a.next()).not.toBe(b.next())
  })

  it('reste dans [0, 1)', () => {
    const rng = new SeededRng(7)
    for (let i = 0; i < 20_000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('a une moyenne proche de 0,5', () => {
    const rng = new SeededRng(99)
    let sum = 0
    const n = 50_000
    for (let i = 0; i < n; i++) sum += rng.next()
    expect(sum / n).toBeCloseTo(0.5, 2)
  })

  it('se repartit uniformement entre les deciles', () => {
    const rng = new SeededRng(2026)
    const buckets = new Array(10).fill(0)
    const n = 100_000
    for (let i = 0; i < n; i++) buckets[Math.floor(rng.next() * 10)]!++
    for (const [i, count] of buckets.entries()) {
      expect(count / n, `decile ${i}`).toBeGreaterThan(0.085)
      expect(count / n, `decile ${i}`).toBeLessThan(0.115)
    }
  })

  it('sort d un etat degenere', () => {
    // Un etat tout a zero est un point fixe de xoshiro : il ne doit pas etre atteignable.
    const rng = new SeededRng(0)
    const values = Array.from({ length: 20 }, () => rng.next())
    expect(new Set(values).size).toBeGreaterThan(15)
  })
})

describe('gaussian', () => {
  it('a une moyenne proche de 0 et un ecart-type proche de 1', () => {
    const rng = new SeededRng(4242)
    const n = 50_000
    const values = Array.from({ length: n }, () => gaussian(rng))
    const mean = values.reduce((a, b) => a + b, 0) / n
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n
    expect(mean).toBeCloseTo(0, 1)
    expect(Math.sqrt(variance)).toBeCloseTo(1, 1)
  })

  it('ne produit jamais Infinity ni NaN', () => {
    // log(0) donnerait -Infinity : le garde-fou sur u === 0 doit tenir.
    const rng = new SeededRng(31337)
    for (let i = 0; i < 50_000; i++) {
      expect(Number.isFinite(gaussian(rng))).toBe(true)
    }
  })
})

describe('helpers', () => {
  it('randomInt couvre les bornes inclusivement', () => {
    const rng = new SeededRng(11)
    const seen = new Set<number>()
    for (let i = 0; i < 5_000; i++) seen.add(randomInt(rng, 3, 7))
    expect([...seen].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7])
  })

  it('chance respecte la probabilite', () => {
    const rng = new SeededRng(13)
    let hits = 0
    const n = 20_000
    for (let i = 0; i < n; i++) if (chance(rng, 0.3)) hits++
    expect(hits / n).toBeCloseTo(0.3, 1)
  })

  it('chance(0) est toujours faux et chance(1) toujours vrai', () => {
    const rng = new SeededRng(17)
    for (let i = 0; i < 500; i++) {
      expect(chance(rng, 0)).toBe(false)
      expect(chance(rng, 1)).toBe(true)
    }
  })
})
