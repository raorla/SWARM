import { describe, expect, it } from 'vitest'
import { CapsGuard, memoryCapStore } from '@/governor/caps'
import { DEFAULT_CAPS, type DailyCaps } from '@/governor/types'
import { FakeClock, DAY } from '@/shared/time'

const caps: DailyCaps = { ...DEFAULT_CAPS, reply: 3 }

describe('CapsGuard', () => {
  it('autorise jusqu’au plafond puis refuse', async () => {
    const clock = new FakeClock('2026-03-10T10:00:00.000Z')
    const guard = new CapsGuard(memoryCapStore(), clock)

    for (let i = 0; i < 3; i++) {
      expect(await guard.check(caps, 'reply')).toBeNull()
      await guard.increment('reply')
    }
    const denial = await guard.check(caps, 'reply')
    expect(denial?.reason).toBe('cap-reached')
    expect(denial?.detail).toContain('3/3')
  })

  it('remet les compteurs à zéro au changement de jour local', async () => {
    const clock = new FakeClock('2026-03-10T10:00:00.000Z')
    const guard = new CapsGuard(memoryCapStore(), clock)

    await guard.increment('reply')
    await guard.increment('reply')
    await guard.increment('reply')
    expect((await guard.check(caps, 'reply'))?.reason).toBe('cap-reached')

    clock.advance(DAY)
    expect(await guard.check(caps, 'reply')).toBeNull()
    expect(await guard.used('reply')).toBe(0)
  })

  it('partitionne par jour LOCAL, pas par jour UTC', async () => {
    // 23:30 heure de Paris en été = 21:30 UTC. Un compteur calé sur UTC se
    // réinitialiserait à 02:00 locales, doublant de fait le plafond de la soirée.
    const clock = new FakeClock('2026-07-15T21:30:00.000Z', -120)
    const guard = new CapsGuard(memoryCapStore(), clock)
    await guard.increment('reply')

    clock.advance(60 * 60 * 1000) // 22:30 UTC → 00:30 locales, jour local suivant
    expect(await guard.used('reply')).toBe(0)
  })

  it('refuse les DM quel que soit le plafond configuré', async () => {
    const clock = new FakeClock()
    const guard = new CapsGuard(memoryCapStore(), clock)
    // Une config corrompue ou une UI buguée pourrait proposer un plafond de DM ; le
    // module doit tenir l'engagement de SPEC §2.2 sans faire confiance à la config.
    const tampered: DailyCaps = { ...caps, dm: 50 }
    const denial = await guard.check(tampered, 'dm')
    expect(denial?.reason).toBe('cap-reached')
    expect(denial?.detail).toContain('conception')
  })

  it('ne conserve que 30 jours de compteurs', async () => {
    const clock = new FakeClock('2026-01-01T12:00:00.000Z')
    const store = memoryCapStore()
    const guard = new CapsGuard(store, clock)
    for (let i = 0; i < 40; i++) {
      await guard.increment('like')
      clock.advance(DAY)
    }
    expect(Object.keys(await store.read()).length).toBe(30)
  })

  it('expose un instantané avec les plafonds désactivés visibles', async () => {
    const guard = new CapsGuard(memoryCapStore(), new FakeClock())
    await guard.increment('reply', 2)
    const snap = await guard.snapshot(caps)
    expect(snap['reply']).toEqual({ used: 2, cap: 3 })
    // follow et dm à 0 restent affichés : c'est ce qui rend l'engagement vérifiable.
    expect(snap['follow']).toEqual({ used: 0, cap: 0 })
    expect(snap['dm']).toEqual({ used: 0, cap: 0 })
  })
})
