/**
 * SIMULATION / BACKTEST — différenciateur n°6.
 *
 * Le premier bloc est le seul qui compte vraiment : **la reproductibilité**. Sans elle, un
 * écart entre deux configurations peut venir de la config ou du hasard, on ne peut pas savoir
 * lequel, et le backtest devient pire qu'inutile — il produit des conclusions.
 */
import { describe, expect, it } from 'vitest'
import {
  replayArchive,
  type Archive,
  type ArchivedPost,
  type ReplayConfig,
} from '@/simulation/replay'
import {
  MEANINGFUL_DIFFERENCE,
  MIN_ARCHIVE_POSTS,
  compareConfigs,
  verifyDeterminism,
} from '@/simulation/compare'
import {
  ARCHIVE_TTL_MS,
  MAX_ARCHIVE_POSTS,
  describeArchive,
  emptyRecorder,
  isCompatible,
  prune,
  record,
  seal,
} from '@/simulation/recorder'
import { bundledPack } from '@/niches/loader'
import { DEFAULT_CAPS } from '@/governor/types'
import { DAY, FakeClock, HOUR } from '@/shared/time'
import type { ExtractedPost } from '@/content/dom/dom-schemas'

const pack = bundledPack('memecoin')!
const START = Date.parse('2026-07-01T10:00:00.000Z')

function archivedPost(index: number, overrides: Partial<ArchivedPost> = {}): ArchivedPost {
  const observedAtMs = START + index * HOUR
  return {
    postId: `178945600000000${String(index).padStart(4, '0')}`,
    authorHandle: `author${index % 20}`,
    authorFollowers: null,
    text: `discussion sur la mecanique de liquidite et le float, variante ${index}`,
    lang: 'en',
    postedAtMs: observedAtMs - 5 * 60_000,
    observedAtMs,
    replyCount: 5,
    likeCount: 40,
    repostCount: 2,
    hasMedia: false,
    isReply: false,
    surface: 'timeline',
    archivedRelevance: 0.75,
    archivedAngle: 'data',
    ...overrides,
  }
}

function archive(
  count: number,
  overrides: (i: number) => Partial<ArchivedPost> = () => ({}),
): Archive {
  const posts = Array.from({ length: count }, (_, i) => archivedPost(i, overrides(i)))
  return {
    meta: {
      formatVersion: 1,
      recordedFromMs: posts[0]?.observedAtMs ?? 0,
      recordedToMs: posts[posts.length - 1]?.observedAtMs ?? 0,
      postCount: posts.length,
      nichePackId: 'memecoin',
      nichePackVersion: pack.version,
    },
    posts,
  }
}

function config(overrides: Partial<ReplayConfig> = {}): ReplayConfig {
  return {
    label: 'reference',
    pack,
    caps: { ...DEFAULT_CAPS, reply: 12 },
    seed: 2026,
    cadence: { minMinutes: 4, maxMinutes: 18 },
    window: { startMinute: 0, endMinute: 1440 },
    ...overrides,
  }
}

describe('reproductibilite — la propriete sans laquelle rien ne sert', () => {
  it('deux rejeux de la meme configuration sont IDENTIQUES', () => {
    const data = archive(120)
    const a = replayArchive(data, config())
    const b = replayArchive(data, config())

    expect(a.queued).toBe(b.queued)
    expect(a.avgQueuedEv).toBe(b.avgQueuedEv)
    expect(a.outcomes.map((o) => `${o.postId}:${o.decision}`)).toEqual(
      b.outcomes.map((o) => `${o.postId}:${o.decision}`),
    )
  })

  it('verifyDeterminism le confirme sur plusieurs rejeux', () => {
    const result = verifyDeterminism(archive(120), config(), 5)
    expect(result.deterministic).toBe(true)
    expect(result.detail).toContain('reproductible')
  })

  it('n appelle aucun modele : les verdicts sont archives', () => {
    // C'est ce qui rend le rejeu deterministe. Un verdict recalcule rendrait deux runs
    // differents, et la comparaison sans valeur.
    const data = archive(50, (i) => ({ archivedRelevance: i % 2 === 0 ? 0.9 : 0.05 }))
    const report = replayArchive(data, config())
    expect(report.counts['rejected-threshold']).toBeGreaterThan(0)
  })
})

describe('rejeu des filtres', () => {
  it('applique le garde-fou de sujet', () => {
    const data = archive(10, (i) =>
      i < 3 ? { text: 'this is going 100x, guaranteed returns' } : {},
    )
    expect(replayArchive(data, config()).counts['rejected-guard']).toBe(3)
  })

  it('ecarte les posts perimes au seuil du pack', () => {
    const data = archive(10, (i) =>
      i < 4 ? { postedAtMs: START + i * HOUR - 200 * 60_000 } : {},
    )
    expect(replayArchive(data, config()).counts['rejected-stale']).toBe(4)
  })

  it('ecarte les conversations saturees', () => {
    const data = archive(10, (i) => (i < 2 ? { replyCount: 500 } : {}))
    expect(replayArchive(data, config()).counts['rejected-saturated']).toBe(2)
  })

  it('applique le plafond journalier et le remet a zero chaque jour', () => {
    const data = archive(72)
    const report = replayArchive(data, config({ caps: { ...DEFAULT_CAPS, reply: 3 } }))
    expect(report.counts['skipped-cap']).toBeGreaterThan(0)
    // Trois jours d'archive, trois reponses par jour maximum.
    expect(report.queued).toBeGreaterThan(3)
    expect(report.queued).toBeLessThanOrEqual(12)
  })

  it('applique la fenetre horaire', () => {
    const data = archive(48)
    const narrow = replayArchive(
      data,
      config({ window: { startMinute: 10 * 60, endMinute: 12 * 60 } }),
    )
    const wide = replayArchive(data, config())
    expect(narrow.counts['skipped-window']).toBeGreaterThan(0)
    expect(narrow.queued).toBeLessThan(wide.queued)
  })

  it('applique la cadence sur des posts rapproches', () => {
    const posts = Array.from({ length: 20 }, (_, i) =>
      archivedPost(i, {
        observedAtMs: START + i * 60_000,
        postedAtMs: START + i * 60_000 - 30_000,
      }),
    )
    const data: Archive = { ...archive(1), posts }
    expect(replayArchive(data, config()).counts['skipped-cadence']).toBeGreaterThan(0)
  })

  it('gere une archive vide sans NaN', () => {
    const report = replayArchive({ ...archive(1), posts: [] }, config())
    expect(report.postsReplayed).toBe(0)
    expect(Number.isFinite(report.avgQueuedEv)).toBe(true)
    expect(Number.isFinite(report.repliesPerDay)).toBe(true)
  })
})

describe('comparaison de configurations', () => {
  it('refuse de conclure sur une archive trop mince', () => {
    const result = compareConfigs(archive(20), [config({ label: 'A' }), config({ label: 'B' })])
    expect(result.insufficientArchive).toBe(true)
    expect(result.recommended).toBeNull()
    expect(result.verdict).toContain(String(MIN_ARCHIVE_POSTS))
  })

  it('ne fabrique PAS de gagnant sur un ecart negligeable', () => {
    // Prendre une decision sur un ecart de 3 % serait decider sur du bruit.
    const data = archive(MIN_ARCHIVE_POSTS + 50)
    const result = compareConfigs(data, [
      config({ label: 'identique-1' }),
      config({ label: 'identique-2' }),
    ])
    expect(result.recommended).toBeNull()
    expect(result.verdict).toContain('se distingue')
    expect(MEANINGFUL_DIFFERENCE).toBeGreaterThan(0)
  })

  it('un seuil laxiste retient plus mais avec un EV moyen plus faible', () => {
    // Maximiser le volume recompenserait exactement le comportement que le produit existe
    // pour eviter.
    const data = archive(MIN_ARCHIVE_POSTS + 100, (i) => ({
      archivedRelevance: i % 3 === 0 ? 0.95 : 0.25,
    }))
    const permissive = config({
      label: 'tout-passe',
      pack: { ...pack, thresholds: { ...pack.thresholds, minEvScore: 0 } },
      caps: { ...DEFAULT_CAPS, reply: 200 },
    })
    const selective = config({
      label: 'selectif',
      pack: { ...pack, thresholds: { ...pack.thresholds, minEvScore: 0.55 } },
      caps: { ...DEFAULT_CAPS, reply: 200 },
    })

    const result = compareConfigs(data, [permissive, selective])
    const permissiveRow = result.rows.find((r) => r.label === 'tout-passe')!
    const selectiveRow = result.rows.find((r) => r.label === 'selectif')!
    expect(permissiveRow.queued).toBeGreaterThan(selectiveRow.queued)
    expect(selectiveRow.avgQueuedEv).toBeGreaterThan(permissiveRow.avgQueuedEv)
  })

  it('expose les principaux motifs de rejet', () => {
    const data = archive(MIN_ARCHIVE_POSTS + 20, (i) => (i % 5 === 0 ? { replyCount: 500 } : {}))
    const row = compareConfigs(data, [config({ label: 'A' })]).rows[0]!
    expect(row.topRejectionReasons.length).toBeGreaterThan(0)
    expect(row.topRejectionReasons[0]?.count).toBeGreaterThan(0)
  })

  it('une seule configuration : rien a comparer, et le dit', () => {
    const result = compareConfigs(archive(MIN_ARCHIVE_POSTS + 10), [config()])
    expect(result.verdict).toContain('rien a comparer'.replace('a comparer', 'à comparer'))
  })
})

describe('enregistreur', () => {
  const clock = new FakeClock('2026-08-25T12:00:00.000Z')

  function extracted(index: number): ExtractedPost {
    return {
      postId: `178945600000000${String(index).padStart(4, '0')}`,
      authorHandle: `author${index}`,
      authorDisplayName: null,
      text: `post ${index}`,
      lang: 'en',
      postedAtMs: clock.now() - 5 * 60_000,
      replyCount: 3,
      likeCount: 20,
      repostCount: 1,
      hasMedia: false,
      hasQuote: false,
      isReply: false,
      isOwnPost: false,
      surface: 'timeline',
      observedAtMs: clock.now() - index * 1000,
      permalink: `/author${index}/status/x`,
    }
  }

  it('n enregistre RIEN tant que ce n est pas active (MH-13)', () => {
    // L'archive est l'exception explicite a la purge de retention : elle doit etre un choix
    // nomme, pas un effet de bord.
    const state = record(emptyRecorder(), extracted(1), { relevance: 0.8, angle: 'data' }, clock)
    expect(state.posts).toHaveLength(0)
  })

  it('enregistre avec le verdict de pertinence', () => {
    const enabled = { ...emptyRecorder(), enabled: true }
    const state = record(enabled, extracted(1), { relevance: 0.77, angle: 'question' }, clock)
    expect(state.posts[0]?.archivedRelevance).toBe(0.77)
    expect(state.posts[0]?.archivedAngle).toBe('question')
  })

  it('deduplique : le scout revoit les memes posts', () => {
    let state = { ...emptyRecorder(), enabled: true }
    state = record(state, extracted(1), { relevance: 0.5, angle: null }, clock)
    state = record(state, extracted(1), { relevance: 0.9, angle: 'data' }, clock)
    expect(state.posts).toHaveLength(1)
    expect(state.posts[0]?.archivedRelevance).toBe(0.9)
  })

  it('garde les plus RECENTS quand l archive sature', () => {
    let state = { ...emptyRecorder(), enabled: true }
    for (let i = 0; i < MAX_ARCHIVE_POSTS + 100; i++) {
      state = record(state, extracted(i), { relevance: 0.5, angle: null }, clock)
    }
    expect(state.posts).toHaveLength(MAX_ARCHIVE_POSTS)
  })

  it('purge au-dela de sa duree de vie propre', () => {
    const localClock = new FakeClock('2026-08-25T12:00:00.000Z')
    let state = { ...emptyRecorder(), enabled: true }
    state = record(state, extracted(1), { relevance: 0.5, angle: null }, localClock)
    localClock.advance(ARCHIVE_TTL_MS + DAY)
    expect(prune(state, localClock).posts).toHaveLength(0)
  })

  it('scelle une archive triee avec son pack', () => {
    let state = { ...emptyRecorder(), enabled: true }
    for (let i = 3; i >= 0; i--) {
      state = record(state, extracted(i), { relevance: 0.5, angle: null }, clock)
    }
    const sealed = seal(state, pack)
    expect(sealed.meta.nichePackId).toBe('memecoin')
    expect(sealed.meta.postCount).toBe(4)
    for (let i = 1; i < sealed.posts.length; i++) {
      expect(sealed.posts[i]!.observedAtMs).toBeGreaterThanOrEqual(
        sealed.posts[i - 1]!.observedAtMs,
      )
    }
  })

  it('REFUSE de rejouer une archive d un autre pack', () => {
    // Un verdict de pertinence n'est comparable qu'a pack egal.
    const saas = bundledPack('saas-b2b')!
    const result = isCompatible(archive(10), saas)
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('comparables')
  })

  it('avertit sur une version de pack differente sans refuser', () => {
    // Refuser rendrait toute archive inutilisable au premier ajustement de pack.
    const result = isCompatible(archive(10), { ...pack, version: '9.9.9' })
    expect(result.compatible).toBe(true)
    expect(result.reason).toContain('derive'.replace('derive', 'dérivé'))
  })

  it('decrit l archive lisiblement', () => {
    expect(describeArchive(archive(48))).toMatch(/48 posts sur \d+ jours/)
    expect(describeArchive({ ...archive(1), posts: [] })).toContain('vide')
  })
})
