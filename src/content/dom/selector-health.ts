/**
 * Détection de rupture des sélecteurs — SPEC §8 : « alerte utilisateur au lieu d'échec
 * silencieux ».
 *
 * Le point de conception : distinguer une **absence normale** d'une **rupture**.
 *
 *  - Un sélecteur optionnel qui ne matche pas est un état légitime du post (pas de média).
 *  - Un sélecteur requis qui ne matche pas *une fois* peut être un post atypique
 *    (annonce, post supprimé, publicité).
 *  - Un sélecteur requis qui ne matche pas N fois de suite, alors que son conteneur est
 *    bien trouvé, est une rupture.
 *
 * Sans ce seuil, l'alerte se déclencherait sur des cas normaux et l'utilisateur
 * apprendrait à l'ignorer — ce qui vaut moins que pas d'alerte du tout.
 */
import type { AttemptReport } from './query'
import { createLogger } from '@/shared/logger'
import type { Clock } from '@/shared/time'
import { MINUTE } from '@/shared/time'

const log = createLogger('content:selector-health')

/** Nombre d'échecs consécutifs avant de conclure à une rupture. */
export const BREAK_THRESHOLD = 8

/** Délai minimum entre deux alertes pour le même sélecteur. */
export const ALERT_COOLDOWN_MS = 30 * MINUTE

export interface SelectorStats {
  attempts: number
  hits: number
  misses: number
  consecutiveMisses: number
  /** Nombre de fois où un candidat de repli a été nécessaire. */
  fallbackHits: number
  /** Index du dernier candidat qui a fonctionné. */
  lastHitIndex: number
  lastAlertAtMs: number | null
}

export interface BreakEvent {
  selectorName: string
  consecutiveMisses: number
  attempts: number
}

const emptyStats = (): SelectorStats => ({
  attempts: 0,
  hits: 0,
  misses: 0,
  consecutiveMisses: 0,
  fallbackHits: 0,
  lastHitIndex: -1,
  lastAlertAtMs: null,
})

export class SelectorHealth {
  private readonly stats = new Map<string, SelectorStats>()

  constructor(
    private readonly clock: Clock,
    /** Appelé une fois par rupture détectée, hors période de silence. */
    private readonly onBreak: (event: BreakEvent) => void,
    /** Sélecteurs dont l'absence compte comme une rupture. */
    private readonly requiredNames: ReadonlySet<string>,
  ) {}

  /** Sink à passer à `queryOne` / `queryAll`. */
  get sink(): (report: AttemptReport) => void {
    return (report) => this.record(report)
  }

  private record(report: AttemptReport): void {
    const s = this.stats.get(report.name) ?? emptyStats()
    s.attempts += 1

    if (report.hit) {
      s.hits += 1
      s.consecutiveMisses = 0
      s.lastHitIndex = report.candidateIndex
      if (report.usedFallback) {
        s.fallbackHits += 1
        // Un repli qui fonctionne n'est pas une panne, mais c'est un signal précoce :
        // le sélecteur préféré a déjà changé, le repli suivra probablement.
        if (s.fallbackHits === 1) {
          log.info('sélecteur en repli', {
            name: report.name,
            index: report.candidateIndex,
          })
        }
      }
      this.stats.set(report.name, s)
      return
    }

    s.misses += 1
    s.consecutiveMisses += 1
    this.stats.set(report.name, s)

    if (!this.requiredNames.has(report.name)) return
    if (s.consecutiveMisses < BREAK_THRESHOLD) return

    const now = this.clock.now()
    if (s.lastAlertAtMs !== null && now - s.lastAlertAtMs < ALERT_COOLDOWN_MS) return

    s.lastAlertAtMs = now
    this.stats.set(report.name, s)
    log.warn('rupture de sélecteur détectée', {
      name: report.name,
      consecutiveMisses: s.consecutiveMisses,
      attempts: s.attempts,
    })
    this.onBreak({
      selectorName: report.name,
      consecutiveMisses: s.consecutiveMisses,
      attempts: s.attempts,
    })
  }

  snapshot(): Record<string, SelectorStats> {
    return Object.fromEntries([...this.stats].map(([k, v]) => [k, { ...v }]))
  }

  /** Sélecteurs qui n'ont jamais matché sur un nombre significatif de tentatives. */
  brokenSelectors(): string[] {
    return [...this.stats]
      .filter(
        ([name, s]) =>
          this.requiredNames.has(name) && s.consecutiveMisses >= BREAK_THRESHOLD,
      )
      .map(([name]) => name)
  }

  /** Taux de réussite global — affiché dans l'onglet Config comme indicateur de santé. */
  hitRate(): number {
    let attempts = 0
    let hits = 0
    for (const s of this.stats.values()) {
      attempts += s.attempts
      hits += s.hits
    }
    return attempts === 0 ? 1 : hits / attempts
  }

  reset(): void {
    this.stats.clear()
  }
}
