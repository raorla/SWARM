import { describe, expect, it } from 'vitest'
import {
  Governor,
  createInMemoryGovernor,
  DEFAULT_GOVERNOR_CONFIG,
  memoryAuditStore,
  memoryCapStore,
  memoryCadenceStore,
  memoryKillSwitchStore,
} from '@/governor'
import type { GovernorDeps } from '@/governor'
import { DEFAULT_CAPS } from '@/governor/types'
import { FakeClock, DAY } from '@/shared/time'
import { SeededRng } from '@/shared/rng'

function build(
  overrides: Partial<ConstructorParameters<typeof Governor>[0]> = {},
  deps: Partial<GovernorDeps> = {},
  clock = new FakeClock('2026-03-10T12:00:00.000Z'),
): { governor: Governor; clock: FakeClock } {
  const governor = new Governor(
    {
      mode: 'copilot',
      installSeed: 'test-seed',
      ...DEFAULT_GOVERNOR_CONFIG,
      window: { ...DEFAULT_GOVERNOR_CONFIG.window, dayOffProbability: 0 },
      ...overrides,
    },
    {
      capStore: memoryCapStore(),
      cadenceStore: memoryCadenceStore(),
      killSwitchStore: memoryKillSwitchStore(),
      auditStore: memoryAuditStore(),
      clock,
      rng: new SeededRng(1),
      ...deps,
    },
  )
  return { governor, clock }
}

const req = {
  actionType: 'reply' as const,
  idempotencyKey: 'post-1:draft-abc',
  actor: 'publisher',
}

describe('Governor.requestPermit', () => {
  it('accorde un permis dans des conditions nominales', async () => {
    const { governor } = build()
    const r = await governor.requestPermit(req)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.actionType).toBe('reply')
      expect(r.value.token).toHaveLength(32)
      expect(governor.isPermitValid(r.value)).toBe(true)
    }
  })

  it('le kill switch a la priorité absolue sur tout le reste', async () => {
    const { governor } = build()
    await governor.engageKillSwitch('test')
    const r = await governor.requestPermit(req)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('killswitch')
  })

  it('le mode simulation refuse toute action (MH-15)', async () => {
    const { governor } = build({ mode: 'simulation' })
    const r = await governor.requestPermit(req)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('simulation')
  })

  it('l’autopilote est refusé tant qu’il n’est pas implémenté (SPEC §4.6)', async () => {
    // Le mode existe dans le type parce que la config doit le connaître, mais aucun code
    // ne le met en œuvre. Le governor doit le refuser plutôt que d'agir par défaut.
    const { governor } = build({ mode: 'autopilot' })
    const r = await governor.requestPermit(req)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('action-not-supported')
  })

  it('refuse les actions non implémentées, même si la config les autorise', async () => {
    const { governor } = build({ caps: { ...DEFAULT_CAPS, follow: 10, dm: 10 } })
    for (const actionType of ['follow', 'dm', 'post', 'thread'] as const) {
      const r = await governor.requestPermit({ ...req, actionType })
      expect(r.ok, `${actionType} ne doit pas être autorisé`).toBe(false)
      if (!r.ok) expect(r.error.reason).toBe('action-not-supported')
    }
  })

  it('refuse un doublon avant toute dépense (MH-07)', async () => {
    const { governor } = build({}, { isDuplicate: async () => true })
    const r = await governor.requestPermit(req)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('duplicate')
  })

  it('refuse un auteur sur la blocklist du pack', async () => {
    const { governor } = build()
    const r = await governor.requestPermit({
      ...req,
      targetHandle: '@BadActor',
      packBlocklist: ['badactor'],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('blocked-author')
  })

  it('refuse un sujet écarté par le noyau universel', async () => {
    const { governor } = build()
    const r = await governor.requestPermit({
      ...req,
      targetText: 'this token is going 100x, not financial advice',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('blocked-topic')
  })

  it('refuse hors fenêtre horaire', async () => {
    const { governor } = build({}, {}, new FakeClock('2026-03-10T04:00:00.000Z'))
    const r = await governor.requestPermit(req)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('outside-window')
  })

  it('refuse quand le plafond est atteint', async () => {
    const { governor } = build({ caps: { ...DEFAULT_CAPS, reply: 1 } })
    const first = await governor.requestPermit(req)
    expect(first.ok).toBe(true)
    if (first.ok) await governor.commit(first.value)

    const second = await governor.requestPermit({
      ...req,
      idempotencyKey: 'post-2:draft',
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.reason).toBe('cap-reached')
  })

  it('refuse quand le budget est épuisé', async () => {
    const { governor } = build(
      {},
      {
        budgetCheck: async () => ({
          reason: 'budget-exhausted' as const,
          detail: 'plus de budget',
        }),
      },
    )
    const r = await governor.requestPermit(req)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('budget-exhausted')
  })

  it('refuse pendant la cadence après une action validée', async () => {
    const { governor, clock } = build()
    const first = await governor.requestPermit(req)
    expect(first.ok).toBe(true)
    if (first.ok) await governor.commit(first.value)

    const tooSoon = await governor.requestPermit({ ...req, idempotencyKey: 'k2' })
    expect(tooSoon.ok).toBe(false)
    if (!tooSoon.ok) expect(tooSoon.error.reason).toBe('cadence')

    clock.advanceMinutes(25)
    const later = await governor.requestPermit({ ...req, idempotencyKey: 'k3' })
    expect(later.ok).toBe(true)
  })

  it('ne consomme un quota qu’au commit, pas à l’émission du permis', async () => {
    // Un brouillon ignoré par l'utilisateur ne doit pas coûter un quota, sinon le
    // plafond réel serait plus bas que le plafond promis.
    const { governor } = build({ caps: { ...DEFAULT_CAPS, reply: 2 } })
    const r1 = await governor.requestPermit(req)
    expect(r1.ok).toBe(true)
    const snap = await governor.snapshot()
    expect(snap.caps['reply']?.used).toBe(0)
  })

  it('un permis expire, et une action tardive doit redemander', async () => {
    const { governor, clock } = build()
    const r = await governor.requestPermit(req)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(governor.isPermitValid(r.value)).toBe(true)
    clock.advanceMinutes(15)
    expect(governor.isPermitValid(r.value)).toBe(false)
  })
})

describe('Governor — ordre des vérifications', () => {
  it('journalise la PREMIÈRE raison de refus, la plus absolue', async () => {
    // Un swarm arrêté ET hors fenêtre ET sans budget doit rapporter « killswitch » :
    // c'est la raison actionnable, les autres sont du bruit.
    const { governor } = build(
      { mode: 'copilot' },
      {
        budgetCheck: async () => ({
          reason: 'budget-exhausted' as const,
          detail: 'vide',
        }),
        isDuplicate: async () => true,
      },
      new FakeClock('2026-03-10T04:00:00.000Z'),
    )
    await governor.engageKillSwitch('arrêt manuel')
    const r = await governor.requestPermit(req)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('killswitch')
  })

  it('ne consomme aucun tirage de cadence quand un refus survient plus tôt', async () => {
    // Propriété de coût : un swarm arrêté ne doit rien calculer.
    const store = memoryCadenceStore({ lastActionAtMs: 1, nextDelayMs: null })
    const { governor } = build({ mode: 'simulation' }, { cadenceStore: store })
    await governor.requestPermit(req)
    expect((await store.read()).nextDelayMs).toBeNull()
  })
})

describe('Governor — journal d’audit', () => {
  it('journalise les refus et les autorisations, avec une chaîne intacte', async () => {
    const { governor } = build({ caps: { ...DEFAULT_CAPS, reply: 1 } })
    const granted = await governor.requestPermit(req)
    if (granted.ok) await governor.commit(granted.value)
    await governor.requestPermit({ ...req, idempotencyKey: 'k2' })

    const entries = await governor.audit.entries()
    expect(entries.length).toBeGreaterThanOrEqual(3)
    expect(entries.map((e) => e.type)).toContain('permit.granted')
    expect(entries.map((e) => e.type)).toContain('permit.denied')
    expect(entries.map((e) => e.type)).toContain('action.staged')

    const verified = await governor.audit.verifyChain()
    expect(verified.valid).toBe(true)
  })

  it('remet les compteurs à zéro d’un jour à l’autre', async () => {
    const { governor, clock } = build({ caps: { ...DEFAULT_CAPS, reply: 1 } })
    const r = await governor.requestPermit(req)
    if (r.ok) await governor.commit(r.value)
    expect((await governor.requestPermit({ ...req, idempotencyKey: 'k2' })).ok).toBe(
      false,
    )

    clock.advance(DAY)
    const next = await governor.requestPermit({ ...req, idempotencyKey: 'k3' })
    expect(next.ok).toBe(true)
  })
})

describe('Governor — kill switch et reprise', () => {
  it('journalise la reprise et laisse repasser une action', async () => {
    const { governor } = build()
    await governor.engageKillSwitch('incident')
    expect((await governor.requestPermit(req)).ok).toBe(false)

    await governor.releaseKillSwitch()
    const after = await governor.requestPermit(req)
    expect(after.ok).toBe(true)

    const types = (await governor.audit.entries()).map((e) => e.type)
    expect(types).toContain('killswitch.engaged')
    expect(types).toContain('killswitch.released')
    expect((await governor.audit.verifyChain()).valid).toBe(true)
  })

  it('efface la dette de cadence à l’arrêt', async () => {
    // Au redémarrage, l'utilisateur ne doit pas attendre un délai hérité d'avant l'arrêt.
    const { governor } = build()
    const first = await governor.requestPermit(req)
    if (first.ok) await governor.commit(first.value)

    await governor.engageKillSwitch('arrêt')
    await governor.releaseKillSwitch()

    const after = await governor.requestPermit({ ...req, idempotencyKey: 'k-apres' })
    expect(after.ok).toBe(true)
  })

  it('appelle le vidage de file fourni', async () => {
    const { governor } = build()
    let flushed = false
    await governor.engageKillSwitch('arrêt', async () => {
      flushed = true
    })
    expect(flushed).toBe(true)
  })

  it('expose un instantané exploitable par le cockpit', async () => {
    const { governor } = build({ caps: { ...DEFAULT_CAPS, reply: 5 } })
    const r = await governor.requestPermit(req)
    if (r.ok) await governor.commit(r.value)

    const snap = await governor.snapshot()
    expect(snap.mode).toBe('copilot')
    expect(snap.killSwitchEngaged).toBe(false)
    expect(snap.caps['reply']).toEqual({ used: 1, cap: 5 })
    expect(snap.isDayOff).toBe(false)
    expect(snap.nextActionAtMs).toBeGreaterThan(0)
  })

  it('produit un jeton différent par clé d’idempotence', async () => {
    const { governor, clock } = build({ caps: { ...DEFAULT_CAPS, reply: 5 } })
    const a = await governor.requestPermit({ ...req, idempotencyKey: 'aaa' })
    clock.advanceMinutes(1)
    const b = await governor.requestPermit({ ...req, idempotencyKey: 'bbb' })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.value.token).not.toBe(b.value.token)
  })
})

describe('createInMemoryGovernor', () => {
  it('construit un governor utilisable sans chrome.storage', async () => {
    // Utilisé par les tests et par le mode simulation : il doit marcher hors extension.
    const governor = createInMemoryGovernor(
      { window: { ...DEFAULT_GOVERNOR_CONFIG.window, dayOffProbability: 0 } },
      { clock: new FakeClock('2026-03-10T12:00:00.000Z') },
    )
    const r = await governor.requestPermit(req)
    expect(r.ok).toBe(true)
  })

  it('démarre en copilote, pas en autopilote', async () => {
    const governor = createInMemoryGovernor(
      {},
      { clock: new FakeClock('2026-03-10T12:00:00.000Z') },
    )
    expect((await governor.snapshot()).mode).toBe('copilot')
  })
})
