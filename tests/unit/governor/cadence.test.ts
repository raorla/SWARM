import { describe, expect, it } from 'vitest'
import { CadenceGuard, memoryCadenceStore } from '@/governor/cadence'
import { DEFAULT_CADENCE } from '@/governor/types'
import { FakeClock, MINUTE } from '@/shared/time'
import { SeededRng, logNormalDelay } from '@/shared/rng'

describe('CadenceGuard', () => {
  it('n’impose aucun délai avant la première action', async () => {
    const guard = new CadenceGuard(
      memoryCadenceStore(),
      new FakeClock(),
      new SeededRng(1),
    )
    expect(await guard.check(DEFAULT_CADENCE)).toBeNull()
  })

  it('refuse pendant le délai puis autorise après', async () => {
    const clock = new FakeClock('2026-03-10T10:00:00.000Z')
    const guard = new CadenceGuard(memoryCadenceStore(), clock, new SeededRng(42))

    await guard.record()
    const denial = await guard.check(DEFAULT_CADENCE)
    expect(denial?.reason).toBe('cadence')
    expect(denial?.retryAtMs).toBeGreaterThan(clock.now())

    // Le maximum configuré borne le tirage : après maxMinutes, c'est toujours autorisé.
    clock.advanceMinutes(DEFAULT_CADENCE.maxMinutes + 1)
    expect(await guard.check(DEFAULT_CADENCE)).toBeNull()
  })

  it('tire le délai une seule fois et ne le retire pas à chaque vérification', async () => {
    // C'est l'invariant qui empêche le biais : retirer à chaque appel finirait par
    // produire un tirage court, vidant la contrainte de son sens.
    const clock = new FakeClock('2026-03-10T10:00:00.000Z')
    const store = memoryCadenceStore()
    const guard = new CadenceGuard(store, clock, new SeededRng(7))

    await guard.record()
    await guard.check(DEFAULT_CADENCE)
    const firstDelay = (await store.read()).nextDelayMs

    for (let i = 0; i < 20; i++) await guard.check(DEFAULT_CADENCE)
    expect((await store.read()).nextDelayMs).toBe(firstDelay)
  })

  it('réarme un nouveau délai après chaque action enregistrée', async () => {
    const clock = new FakeClock('2026-03-10T10:00:00.000Z')
    const store = memoryCadenceStore()
    const guard = new CadenceGuard(store, clock, new SeededRng(3))

    await guard.record()
    await guard.check(DEFAULT_CADENCE)
    const first = (await store.read()).nextDelayMs

    clock.advanceMinutes(30)
    await guard.record()
    expect((await store.read()).nextDelayMs).toBeNull()
    await guard.check(DEFAULT_CADENCE)
    const second = (await store.read()).nextDelayMs

    expect(second).not.toBe(first)
  })

  it('efface la dette de délai au reset (kill switch)', async () => {
    const clock = new FakeClock()
    const guard = new CadenceGuard(memoryCadenceStore(), clock, new SeededRng(1))
    await guard.record()
    expect(await guard.check(DEFAULT_CADENCE)).not.toBeNull()
    await guard.reset()
    expect(await guard.check(DEFAULT_CADENCE)).toBeNull()
  })
})

describe('logNormalDelay', () => {
  it('reste borné dans [min, max] sur un grand échantillon', () => {
    const rng = new SeededRng(1234)
    const min = 4 * MINUTE
    const max = 18 * MINUTE
    for (let i = 0; i < 5_000; i++) {
      const d = logNormalDelay(rng, min, max)
      expect(d).toBeGreaterThanOrEqual(min)
      expect(d).toBeLessThanOrEqual(max)
    }
  })

  it('produit une distribution asymétrique vers le bas de l’intervalle', () => {
    // C'est la propriété qui rend la cadence « humaine » plutôt qu'uniforme : beaucoup de
    // délais courts, une queue longue.
    const rng = new SeededRng(99)
    const min = 4 * MINUTE
    const max = 18 * MINUTE
    const mid = (min + max) / 2
    let below = 0
    const n = 5_000
    for (let i = 0; i < n; i++) if (logNormalDelay(rng, min, max) < mid) below++
    expect(below / n).toBeGreaterThan(0.55)
  })

  it('est reproductible à graine égale — prérequis du backtest (MH-17)', () => {
    const a = new SeededRng(2026)
    const b = new SeededRng(2026)
    const seqA = Array.from({ length: 50 }, () => logNormalDelay(a, 1000, 9000))
    const seqB = Array.from({ length: 50 }, () => logNormalDelay(b, 1000, 9000))
    expect(seqA).toEqual(seqB)
  })

  it('dégrade proprement si min >= max', () => {
    const rng = new SeededRng(5)
    expect(logNormalDelay(rng, 5000, 5000)).toBe(5000)
    expect(logNormalDelay(rng, 5000, 1000)).toBe(5000)
  })
})
