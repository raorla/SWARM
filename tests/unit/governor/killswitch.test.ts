import { describe, expect, it } from 'vitest'
import {
  KillSwitch,
  memoryKillSwitchStore,
  type KillSwitchState,
} from '@/governor/killswitch'
import { FakeClock } from '@/shared/time'

describe('KillSwitch', () => {
  it('est relâché par défaut', async () => {
    const ks = new KillSwitch(memoryKillSwitchStore(), new FakeClock())
    expect(await ks.isEngaged()).toBe(false)
  })

  it('persiste l’état armé — un nouveau worker le retrouve armé (MH-03)', async () => {
    // Le scénario réel : le service worker meurt après l'arrêt. S'il redémarrait en état
    // « nominal », le kill switch ne servirait à rien précisément quand on en a besoin.
    const store = memoryKillSwitchStore()
    const clock = new FakeClock()
    await new KillSwitch(store, clock).engage('incident')

    const afterRestart = new KillSwitch(store, new FakeClock())
    expect(await afterRestart.isEngaged()).toBe(true)
    expect((await afterRestart.state()).reason).toBe('incident')
  })

  it('est absorbant : rien ne le relâche sauf un release explicite', async () => {
    const clock = new FakeClock()
    const ks = new KillSwitch(memoryKillSwitchStore(), clock)
    await ks.engage('arrêt')
    clock.advanceDays(30)
    expect(await ks.isEngaged()).toBe(true)
    await ks.release()
    expect(await ks.isEngaged()).toBe(false)
  })

  it('persiste l’arrêt AVANT de vider la file', async () => {
    // Ordre critique : si le worker meurt pendant le vidage, l'état arrêté est déjà en
    // base. L'ordre inverse laisserait une fenêtre où la file est vidée mais le swarm se
    // croit actif.
    const store = memoryKillSwitchStore()
    const ks = new KillSwitch(store, new FakeClock())
    let stateAtFlush: KillSwitchState | null = null
    await ks.engage('test', async () => {
      stateAtFlush = await store.read()
    })
    expect(stateAtFlush).not.toBeNull()
    expect(stateAtFlush!.engaged).toBe(true)
  })

  it('reste armé même si le vidage de la file échoue', async () => {
    // L'arrêt a réussi, le nettoyage a échoué. Le nettoyage se rattrape au démarrage
    // suivant ; l'arrêt ne se rattrape pas.
    const ks = new KillSwitch(memoryKillSwitchStore(), new FakeClock())
    await ks.engage('test', async () => {
      throw new Error('échec du vidage')
    })
    expect(await ks.isEngaged()).toBe(true)
  })
})
