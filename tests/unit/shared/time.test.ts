import { describe, expect, it } from 'vitest'
import {
  DAY,
  FakeClock,
  HOUR,
  localDayKey,
  localDayOfWeek,
  localMinutesOfDay,
  MINUTE,
} from '@/shared/time'

describe('FakeClock (MH-17)', () => {
  it('n avance que sur demande', () => {
    const clock = new FakeClock('2026-03-10T12:00:00.000Z')
    const t0 = clock.now()
    expect(clock.now()).toBe(t0)
    clock.advance(MINUTE)
    expect(clock.now()).toBe(t0 + MINUTE)
  })

  it('cumule les avances', () => {
    const clock = new FakeClock('2026-03-10T00:00:00.000Z')
    clock.advanceHours(2).advanceMinutes(30)
    expect(clock.now()).toBe(new Date('2026-03-10T02:30:00.000Z').getTime())
  })
})

describe('helpers de jour local', () => {
  it('localDayKey suit le jour local, pas UTC', () => {
    // 22:30 UTC = 00:30 le lendemain a Paris (ete). Un compteur cale sur UTC
    // se reinitialiserait au milieu de la soiree de l'utilisateur.
    const utc = new FakeClock('2026-07-15T22:30:00.000Z', 0)
    const paris = new FakeClock('2026-07-15T22:30:00.000Z', -120)
    expect(localDayKey(utc)).toBe('2026-07-15')
    expect(localDayKey(paris)).toBe('2026-07-16')
  })

  it('localMinutesOfDay reflete l heure locale', () => {
    const paris = new FakeClock('2026-07-15T08:00:00.000Z', -120)
    expect(localMinutesOfDay(paris)).toBe(10 * 60)
  })

  it('localDayOfWeek suit le decalage', () => {
    // 2026-07-15 est un mercredi (3). A 23:00 UTC avec +2h, on est jeudi (4).
    expect(localDayOfWeek(new FakeClock('2026-07-15T12:00:00.000Z', 0))).toBe(3)
    expect(localDayOfWeek(new FakeClock('2026-07-15T23:00:00.000Z', -120))).toBe(4)
  })

  it('gere un decalage a l ouest de Greenwich', () => {
    // New York, UTC-5 : 02:00 UTC est encore la veille a 21:00.
    const ny = new FakeClock('2026-01-15T02:00:00.000Z', 300)
    expect(localDayKey(ny)).toBe('2026-01-14')
    expect(localMinutesOfDay(ny)).toBe(21 * 60)
  })

  it('expose des constantes coherentes', () => {
    expect(MINUTE).toBe(60_000)
    expect(HOUR).toBe(60 * MINUTE)
    expect(DAY).toBe(24 * HOUR)
  })
})
