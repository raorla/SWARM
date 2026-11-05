import { describe, expect, it } from 'vitest'
import {
  ALERT_COOLDOWN_MS,
  BREAK_THRESHOLD,
  SelectorHealth,
  type BreakEvent,
} from '@/content/dom/selector-health'
import { FakeClock } from '@/shared/time'

function build(required: readonly string[] = ['post.text']): {
  health: SelectorHealth
  events: BreakEvent[]
  clock: FakeClock
} {
  const events: BreakEvent[] = []
  const clock = new FakeClock('2026-08-25T12:00:00.000Z')
  const health = new SelectorHealth(clock, (e) => events.push(e), new Set(required))
  return { health, events, clock }
}

const miss = (name: string) => ({
  name,
  hit: false,
  candidateIndex: -1,
  usedFallback: false,
})
const hit = (name: string, index = 0) => ({
  name,
  hit: true,
  candidateIndex: index,
  usedFallback: index > 0,
})

describe('SelectorHealth — détection de rupture', () => {
  it('ne crie pas sur un échec isolé', () => {
    // Un post atypique (annonce, post supprimé) fait légitimement échouer un sélecteur.
    const { health, events } = build()
    health.sink(miss('post.text'))
    expect(events).toHaveLength(0)
  })

  it('alerte après le seuil d’échecs consécutifs', () => {
    const { health, events } = build()
    for (let i = 0; i < BREAK_THRESHOLD; i++) health.sink(miss('post.text'))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      selectorName: 'post.text',
      consecutiveMisses: BREAK_THRESHOLD,
    })
  })

  it('un succès remet le compteur consécutif à zéro', () => {
    // Sans ça, un sélecteur qui échoue une fois sur deux finirait par alerter, alors qu'il
    // fonctionne.
    const { health, events } = build()
    for (let i = 0; i < BREAK_THRESHOLD - 1; i++) health.sink(miss('post.text'))
    health.sink(hit('post.text'))
    for (let i = 0; i < BREAK_THRESHOLD - 1; i++) health.sink(miss('post.text'))
    expect(events).toHaveLength(0)
  })

  it('n’alerte jamais sur un sélecteur optionnel', () => {
    // Un post sans média n'a pas de nœud média : c'est un état normal, pas une rupture.
    const { health, events } = build(['post.text'])
    for (let i = 0; i < BREAK_THRESHOLD * 3; i++) health.sink(miss('post.media'))
    expect(events).toHaveLength(0)
  })

  it('respecte la période de silence entre deux alertes', () => {
    // Une alerte par post rendrait le signal insupportable, donc désactivé, donc inutile.
    const { health, events, clock } = build()
    for (let i = 0; i < BREAK_THRESHOLD * 5; i++) health.sink(miss('post.text'))
    expect(events).toHaveLength(1)

    clock.advance(ALERT_COOLDOWN_MS + 1)
    health.sink(miss('post.text'))
    expect(events).toHaveLength(2)
  })

  it('suit les sélecteurs indépendamment', () => {
    const { health, events } = build(['post.text', 'post.time'])
    for (let i = 0; i < BREAK_THRESHOLD; i++) health.sink(miss('post.text'))
    for (let i = 0; i < BREAK_THRESHOLD; i++) health.sink(miss('post.time'))
    expect(events.map((e) => e.selectorName)).toEqual(['post.text', 'post.time'])
  })
})

describe('SelectorHealth — diagnostic', () => {
  it('compte les usages de repli comme signal précoce', () => {
    const { health } = build()
    health.sink(hit('post.container', 1))
    health.sink(hit('post.container', 1))
    expect(health.snapshot()['post.container']?.fallbackHits).toBe(2)
    expect(health.snapshot()['post.container']?.lastHitIndex).toBe(1)
  })

  it('calcule un taux de réussite global', () => {
    const { health } = build()
    for (let i = 0; i < 8; i++) health.sink(hit('post.text'))
    for (let i = 0; i < 2; i++) health.sink(miss('post.media'))
    expect(health.hitRate()).toBeCloseTo(0.8, 6)
  })

  it('renvoie 1 quand rien n’a encore été tenté', () => {
    // Zéro tentative n'est pas zéro pourcent : le taux serait alarmant à l'ouverture.
    expect(build().health.hitRate()).toBe(1)
  })

  it('liste les sélecteurs cassés', () => {
    const { health } = build(['post.text'])
    for (let i = 0; i < BREAK_THRESHOLD; i++) health.sink(miss('post.text'))
    for (let i = 0; i < BREAK_THRESHOLD; i++) health.sink(miss('post.media'))
    // Seul le requis est listé : c'est lui qui rend le produit inopérant.
    expect(health.brokenSelectors()).toEqual(['post.text'])
  })

  it('se réinitialise', () => {
    const { health } = build()
    health.sink(miss('post.text'))
    health.reset()
    expect(Object.keys(health.snapshot())).toHaveLength(0)
  })
})
