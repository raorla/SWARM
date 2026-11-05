/**
 * Les stores adossés à `chrome.storage.local`.
 *
 * Ils paraissent triviaux, et c'est exactement pourquoi ils méritent des tests : ce sont
 * eux qui portent la persistance du kill switch et des plafonds. Un store qui renvoie un
 * objet vide au lieu de l'état sauvegardé transforme silencieusement un garde-fou en
 * décoration.
 */
import { describe, expect, it } from 'vitest'
import { chromeCapStore, CapsGuard } from '@/governor/caps'
import { chromeCadenceStore, CadenceGuard } from '@/governor/cadence'
import { chromeKillSwitchStore, KillSwitch } from '@/governor/killswitch'
import { chromeBudgetStore, BudgetMeter } from '@/llm/budget'
import { DEFAULT_CADENCE, DEFAULT_CAPS } from '@/governor/types'
import { ZERO_USAGE } from '@/llm/types'
import { FakeClock } from '@/shared/time'
import { SeededRng } from '@/shared/rng'

describe('stores chrome.storage — plafonds', () => {
  it('renvoie un état vide quand rien n’est stocké', async () => {
    expect(await chromeCapStore('test:caps').read()).toEqual({})
  })

  it('fait un aller-retour et survit à un nouveau garde', async () => {
    // Le scénario réel : le service worker meurt, un nouveau `CapsGuard` est construit.
    const clock = new FakeClock('2026-04-01T12:00:00.000Z')
    const first = new CapsGuard(chromeCapStore('test:caps'), clock)
    await first.increment('reply', 2)

    const afterRestart = new CapsGuard(chromeCapStore('test:caps'), clock)
    expect(await afterRestart.used('reply')).toBe(2)
    expect(
      (await afterRestart.check({ ...DEFAULT_CAPS, reply: 2 }, 'reply'))?.reason,
    ).toBe('cap-reached')
  })

  it('isole les clés de stockage distinctes', async () => {
    const clock = new FakeClock()
    await new CapsGuard(chromeCapStore('caps:a'), clock).increment('like')
    expect(await new CapsGuard(chromeCapStore('caps:b'), clock).used('like')).toBe(0)
  })
})

describe('stores chrome.storage — cadence', () => {
  it('renvoie un état neutre quand rien n’est stocké', async () => {
    expect(await chromeCadenceStore('test:cadence').read()).toEqual({
      lastActionAtMs: null,
      nextDelayMs: null,
    })
  })

  it('conserve le délai tiré entre deux instances', async () => {
    const clock = new FakeClock('2026-04-01T12:00:00.000Z')
    const store = chromeCadenceStore('test:cadence')
    const first = new CadenceGuard(store, clock, new SeededRng(5))
    await first.record()
    await first.check(DEFAULT_CADENCE)
    const delay = (await store.read()).nextDelayMs

    const afterRestart = new CadenceGuard(store, clock, new SeededRng(999))
    await afterRestart.check(DEFAULT_CADENCE)
    // Une graine différente ne doit pas retirer un nouveau délai : il est déjà décidé.
    expect((await store.read()).nextDelayMs).toBe(delay)
  })

  it('expose l’instant de disponibilité sans consommer de tirage', async () => {
    const clock = new FakeClock('2026-04-01T12:00:00.000Z')
    const store = chromeCadenceStore('test:cadence2')
    const guard = new CadenceGuard(store, clock, new SeededRng(5))

    expect(await guard.readyAtMs(DEFAULT_CADENCE)).toBe(clock.now())
    await guard.record()
    const readyAt = await guard.readyAtMs(DEFAULT_CADENCE)
    expect(readyAt).toBeGreaterThan(clock.now())
    // Aucun tirage mémorisé : `readyAtMs` est une lecture, pas une décision.
    expect((await store.read()).nextDelayMs).toBeNull()
  })
})

describe('stores chrome.storage — kill switch (MH-03)', () => {
  it('renvoie relâché quand rien n’est stocké', async () => {
    expect(await chromeKillSwitchStore('test:ks').read()).toEqual({
      engaged: false,
      engagedAtMs: null,
      reason: null,
    })
  })

  it('survit à la mort du service worker — le cœur de MH-03', async () => {
    const clock = new FakeClock('2026-04-01T12:00:00.000Z')
    await new KillSwitch(chromeKillSwitchStore('test:ks'), clock).engage('incident réel')

    // Nouveau worker, nouvelle instance, même stockage.
    const afterRestart = new KillSwitch(chromeKillSwitchStore('test:ks'), new FakeClock())
    expect(await afterRestart.isEngaged()).toBe(true)
    expect((await afterRestart.state()).reason).toBe('incident réel')

    await afterRestart.release()
    expect(
      await new KillSwitch(chromeKillSwitchStore('test:ks'), clock).isEngaged(),
    ).toBe(false)
  })
})

describe('stores chrome.storage — budget', () => {
  it('renvoie un état vide quand rien n’est stocké', async () => {
    expect(await chromeBudgetStore('test:budget').read()).toEqual({})
  })

  it('conserve la dépense du jour entre deux instances', async () => {
    const clock = new FakeClock('2026-04-01T12:00:00.000Z')
    const config = { dailyEur: 1, reserveFraction: 0.25 }
    const first = new BudgetMeter(chromeBudgetStore('test:budget'), clock, config)
    await first.record('writer', 0.4, {
      ...ZERO_USAGE,
      inputTokens: 100,
      outputTokens: 50,
    })

    const afterRestart = new BudgetMeter(chromeBudgetStore('test:budget'), clock, config)
    expect((await afterRestart.snapshot()).spentEur).toBeCloseTo(0.4, 6)
  })

  it('accepte un changement de configuration à chaud', async () => {
    const clock = new FakeClock()
    const meter = new BudgetMeter(chromeBudgetStore('test:budget2'), clock, {
      dailyEur: 1,
      reserveFraction: 0.25,
    })
    await meter.record('writer', 0.8, ZERO_USAGE)
    expect((await meter.check('writer', 0.1))?.reason).toBe('budget-exhausted')

    // L'utilisateur relève son budget dans l'onglet Config : l'effet doit être immédiat.
    meter.setConfig({ dailyEur: 5, reserveFraction: 0.25 })
    expect(await meter.check('writer', 0.1)).toBeNull()
  })
})
