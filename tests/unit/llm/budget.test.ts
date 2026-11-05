import { describe, expect, it } from 'vitest'
import { BudgetMeter, memoryBudgetStore, type BudgetConfig } from '@/llm/budget'
import { ZERO_USAGE, type TokenUsage } from '@/llm/types'
import { FakeClock, DAY } from '@/shared/time'

const usage = (input: number, output: number): TokenUsage => ({
  ...ZERO_USAGE,
  inputTokens: input,
  outputTokens: output,
})

const config: BudgetConfig = { dailyEur: 1, reserveFraction: 0.25 }

describe('BudgetMeter — plafond dur', () => {
  it('autorise en dessous du plafond', async () => {
    const meter = new BudgetMeter(memoryBudgetStore(), new FakeClock(), config)
    expect(await meter.check('writer', 0.01)).toBeNull()
  })

  it('refuse un appel qui dépasserait, avant qu’il ait lieu', async () => {
    // Un plafond qu'on ne constate qu'après n'est pas un plafond.
    const meter = new BudgetMeter(memoryBudgetStore(), new FakeClock(), config)
    const denial = await meter.check('writer', 5)
    expect(denial?.reason).toBe('budget-exhausted')
  })

  it('compte l’usage RÉEL rapporté, pas une estimation', async () => {
    const meter = new BudgetMeter(memoryBudgetStore(), new FakeClock(), config)
    await meter.record('writer', 0.02, usage(1_000, 400))
    const snap = await meter.snapshot()
    expect(snap.spentEur).toBeCloseTo(0.02, 6)
    expect(snap.byRole['writer']).toBeCloseTo(0.02, 6)
  })

  it('cumule les tokens pour le diagnostic', async () => {
    const meter = new BudgetMeter(memoryBudgetStore(), new FakeClock(), config)
    await meter.record('qualifier', 0.01, {
      ...usage(5_000, 1_200),
      cacheReadTokens: 4_000,
      cacheWriteTokens: 500,
    })
    await meter.record('qualifier', 0.01, usage(5_000, 1_200))
    const snap = await meter.snapshot()
    expect(snap.byRole['qualifier']).toBeCloseTo(0.02, 6)
  })
})

describe('BudgetMeter — réserve qualité (MH-05)', () => {
  it('bloque les rôles généraux à la frontière de la réserve', async () => {
    // Le scénario qu'on empêche : un triage vorace épuise l'enveloppe, puis le CRITIC ne
    // peut plus tourner — et le système publie sans contrôle qualité.
    const meter = new BudgetMeter(memoryBudgetStore(), new FakeClock(), config)
    await meter.record('qualifier', 0.75, usage(100_000, 20_000))

    const generalDenial = await meter.check('qualifier', 0.01)
    expect(generalDenial?.reason).toBe('budget-exhausted')
    expect(generalDenial?.detail).toContain('réserve qualité préservée')
  })

  it('laisse le CRITIC puiser dans la réserve', async () => {
    const meter = new BudgetMeter(memoryBudgetStore(), new FakeClock(), config)
    await meter.record('qualifier', 0.75, usage(100_000, 20_000))

    // Le rôle réservé accède au budget total, pas seulement à l'enveloppe générale.
    expect(await meter.check('critic', 0.1)).toBeNull()
    expect(await meter.check('analyst', 0.1)).toBeNull()
  })

  it('finit par refuser même les rôles réservés', async () => {
    const meter = new BudgetMeter(memoryBudgetStore(), new FakeClock(), config)
    await meter.record('critic', 1, usage(1, 1))
    expect((await meter.check('critic', 0.01))?.reason).toBe('budget-exhausted')
  })

  it('expose la réserve dans l’instantané', async () => {
    const meter = new BudgetMeter(memoryBudgetStore(), new FakeClock(), config)
    await meter.record('writer', 0.3, usage(1, 1))
    const snap = await meter.snapshot()
    expect(snap.reserveEur).toBeCloseTo(0.25, 6)
    expect(snap.remainingEur).toBeCloseTo(0.7, 6)
    expect(snap.remainingGeneralEur).toBeCloseTo(0.45, 6)
  })

  it('l’asymétrie est intentionnelle : la réserve protège le contrôle, pas l’inverse', async () => {
    const meter = new BudgetMeter(memoryBudgetStore(), new FakeClock(), config)
    expect(await meter.availableFor('critic')).toBeCloseTo(1, 6)
    expect(await meter.availableFor('qualifier')).toBeCloseTo(0.75, 6)
  })
})

describe('BudgetMeter — remise à zéro quotidienne', () => {
  it('repart de zéro le jour suivant', async () => {
    const clock = new FakeClock('2026-03-10T10:00:00.000Z')
    const meter = new BudgetMeter(memoryBudgetStore(), clock, config)
    await meter.record('writer', 0.9, usage(1, 1))
    expect((await meter.check('writer', 0.2))?.reason).toBe('budget-exhausted')

    clock.advance(DAY)
    expect(await meter.check('writer', 0.2)).toBeNull()
    expect((await meter.snapshot()).spentEur).toBe(0)
  })

  it('signale un prix incertain plutôt que de le taire', async () => {
    // Un coût compté à zéro parce que le prix est inconnu serait une fuite silencieuse
    // du plafond.
    const meter = new BudgetMeter(memoryBudgetStore(), new FakeClock(), config)
    await meter.record('writer', 0.05, usage(1, 1), false)
    expect((await meter.snapshot()).hasEstimatedPrices).toBe(true)
  })

  it('ne conserve que 60 jours d’historique', async () => {
    const clock = new FakeClock('2026-01-01T12:00:00.000Z')
    const store = memoryBudgetStore()
    const meter = new BudgetMeter(store, clock, config)
    for (let i = 0; i < 80; i++) {
      await meter.record('writer', 0.001, usage(1, 1))
      clock.advance(DAY)
    }
    expect(Object.keys(await store.read()).length).toBe(60)
  })
})
