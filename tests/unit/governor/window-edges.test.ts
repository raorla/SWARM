/**
 * Cas limites des fenêtres horaires et du calcul de reprise.
 *
 * Le `retryAtMs` d'un refus n'est pas cosmétique : c'est lui qui décide quand
 * l'orchestrateur se réveille. S'il tombe dans le passé, le swarm boucle ; s'il tombe
 * trop loin, il rate sa fenêtre.
 */
import { describe, expect, it } from 'vitest'
import { WindowGuard } from '@/governor/windows'
import { CapsGuard, memoryCapStore } from '@/governor/caps'
import { DEFAULT_CAPS, DEFAULT_WINDOW, type WindowConfig } from '@/governor/types'
import { FakeClock, HOUR } from '@/shared/time'

const noDayOff: WindowConfig = { ...DEFAULT_WINDOW, dayOffProbability: 0 }

describe('retryAtMs des refus', () => {
  it('avant l’ouverture, pointe vers l’ouverture du jour même', () => {
    const clock = new FakeClock('2026-03-10T06:00:00.000Z') // 06:00, fenêtre 09:00–23:00
    const denial = new WindowGuard(clock).check(noDayOff, 'seed')
    expect(denial).not.toBeNull()
    const retryAt = denial!.retryAtMs!
    expect(retryAt).toBeGreaterThan(clock.now())
    expect(retryAt - clock.now()).toBeCloseTo(3 * HOUR, -4)
  })

  it('après la fermeture, pointe vers l’ouverture du lendemain', () => {
    const clock = new FakeClock('2026-03-10T23:30:00.000Z')
    const retryAt = new WindowGuard(clock).check(noDayOff, 'seed')!.retryAtMs!
    // 23:30 → 09:00 le lendemain = 9h30.
    expect(retryAt - clock.now()).toBeCloseTo(9.5 * HOUR, -4)
  })

  it('un jour off pointe vers minuit, pas vers l’ouverture', () => {
    // Attendre l'ouverture ne servirait à rien : le jour entier est off.
    const config: WindowConfig = { ...DEFAULT_WINDOW, dayOffProbability: 1 }
    const clock = new FakeClock('2026-03-10T12:00:00.000Z')
    const denial = new WindowGuard(clock).check(config, 'seed')
    expect(denial?.reason).toBe('day-off')
    const retryAt = denial!.retryAtMs!
    expect(retryAt - clock.now()).toBeCloseTo(12 * HOUR, -4)
  })

  it('un plafond atteint pointe vers minuit local', async () => {
    const clock = new FakeClock('2026-07-15T20:00:00.000Z', -120) // 22:00 à Paris
    const guard = new CapsGuard(memoryCapStore(), clock)
    await guard.increment('reply')
    const denial = await guard.check({ ...DEFAULT_CAPS, reply: 1 }, 'reply')
    // Minuit LOCAL, soit dans 2 h, pas minuit UTC dans 4 h.
    expect(denial!.retryAtMs! - clock.now()).toBeCloseTo(2 * HOUR, -4)
  })

  it('formate les bornes de fenêtre lisiblement dans le motif', () => {
    const clock = new FakeClock('2026-03-10T02:15:00.000Z')
    const denial = new WindowGuard(clock).check(noDayOff, 'seed')
    expect(denial?.detail).toContain('02:15')
    expect(denial?.detail).toContain('09:00')
    expect(denial?.detail).toContain('23:00')
  })

  it('une fenêtre couvrant toute la journée n’exclut rien', () => {
    const allDay: WindowConfig = { ...noDayOff, startMinute: 0, endMinute: 1440 }
    for (const hour of [0, 4, 12, 23]) {
      const clock = new FakeClock(
        `2026-03-10T${String(hour).padStart(2, '0')}:30:00.000Z`,
      )
      expect(new WindowGuard(clock).check(allDay, 'seed')).toBeNull()
    }
  })

  it('probabilité de jour off à 1 : tous les jours sont off', () => {
    const config: WindowConfig = { ...DEFAULT_WINDOW, dayOffProbability: 1 }
    const clock = new FakeClock('2026-03-10T12:00:00.000Z')
    const guard = new WindowGuard(clock)
    for (let i = 0; i < 10; i++) {
      expect(guard.isDayOff(config, 'seed')).toBe(true)
      clock.advanceDays(1)
    }
  })
})
