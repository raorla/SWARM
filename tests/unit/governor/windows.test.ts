import { describe, expect, it } from 'vitest'
import { WindowGuard } from '@/governor/windows'
import { DEFAULT_WINDOW, type WindowConfig } from '@/governor/types'
import { FakeClock, DAY } from '@/shared/time'

const noDayOff: WindowConfig = { ...DEFAULT_WINDOW, dayOffProbability: 0 }

describe('WindowGuard', () => {
  it('autorise dans la fenêtre, refuse en dehors', () => {
    const clock = new FakeClock('2026-03-10T12:00:00.000Z') // 12:00 UTC, tz = UTC
    const guard = new WindowGuard(clock)
    expect(guard.check(noDayOff, 'seed')).toBeNull()

    clock.set('2026-03-10T03:00:00.000Z')
    expect(guard.check(noDayOff, 'seed')?.reason).toBe('outside-window')

    clock.set('2026-03-10T23:30:00.000Z')
    expect(guard.check(noDayOff, 'seed')?.reason).toBe('outside-window')
  })

  it('applique la fenêtre en heure LOCALE, pas en UTC', () => {
    // 08:00 UTC = 10:00 à Paris en été : dans la fenêtre 09:00–23:00 locales, alors
    // qu'une comparaison en UTC la placerait avant l'ouverture.
    const clock = new FakeClock('2026-07-15T08:00:00.000Z', -120)
    expect(new WindowGuard(clock).check(noDayOff, 'seed')).toBeNull()

    const early = new FakeClock('2026-07-15T06:00:00.000Z', -120) // 08:00 locales
    expect(new WindowGuard(early).check(noDayOff, 'seed')?.reason).toBe('outside-window')
  })

  it('refuse un jour de la semaine désactivé', () => {
    // 2026-03-08 est un dimanche.
    const clock = new FakeClock('2026-03-08T12:00:00.000Z')
    const config: WindowConfig = { ...noDayOff, activeDays: [1, 2, 3, 4, 5] }
    expect(new WindowGuard(clock).check(config, 'seed')?.reason).toBe('outside-window')
  })

  it('donne un jour off stable sur 24 h, pas clignotant', () => {
    // La propriété qui compte : un jour off doit être un fait constant sur la journée.
    // Un tirage à chaque appel produirait un état qui change au fil des heures.
    const config: WindowConfig = { ...DEFAULT_WINDOW, dayOffProbability: 0.5 }
    const clock = new FakeClock('2026-03-10T09:30:00.000Z')
    const guard = new WindowGuard(clock)
    const morning = guard.isDayOff(config, 'seed-a')

    for (let h = 0; h < 13; h++) {
      clock.advanceHours(1)
      expect(guard.isDayOff(config, 'seed-a')).toBe(morning)
    }
  })

  it('décorrèle les jours off entre installations', () => {
    // Sans graine par installation, tous les utilisateurs de SWARM feraient une pause
    // les mêmes jours — un signal détectable côté plateforme.
    const config: WindowConfig = { ...DEFAULT_WINDOW, dayOffProbability: 0.5 }
    const clock = new FakeClock('2026-03-10T12:00:00.000Z')
    const guard = new WindowGuard(clock)

    const patterns: Record<string, boolean[]> = {}
    for (const seed of ['install-1', 'install-2', 'install-3']) {
      const c = new FakeClock('2026-03-10T12:00:00.000Z')
      const g = new WindowGuard(c)
      patterns[seed] = Array.from({ length: 30 }, () => {
        const v = g.isDayOff(config, seed)
        c.advance(DAY)
        return v
      })
    }
    expect(patterns['install-1']).not.toEqual(patterns['install-2'])
    expect(patterns['install-2']).not.toEqual(patterns['install-3'])
    void guard
  })

  it('respecte approximativement la probabilité demandée', () => {
    const config: WindowConfig = { ...DEFAULT_WINDOW, dayOffProbability: 1 / 7 }
    const clock = new FakeClock('2026-01-01T12:00:00.000Z')
    const guard = new WindowGuard(clock)
    let off = 0
    const n = 700
    for (let i = 0; i < n; i++) {
      if (guard.isDayOff(config, 'stable-seed')) off++
      clock.advance(DAY)
    }
    expect(off / n).toBeGreaterThan(0.08)
    expect(off / n).toBeLessThan(0.22)
  })
})
