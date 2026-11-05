/**
 * File d'opportunités.
 *
 * Trois responsabilités, et la troisième est celle qu'on oublie :
 *
 *  1. **Enregistrer** ce que le triage a produit, décomposé du score compris.
 *  2. **Servir la file** triée par EV décroissant.
 *  3. **La faire expirer.** Une file qui ne se vide pas devient un cimetière : l'utilisateur
 *     ouvre le Flux et voit des posts de la veille en tête, ce qui est pire que voir une file
 *     vide. La fraîcheur est un facteur du score, donc une opportunité non traitée perd sa
 *     raison d'être avec le temps — et le produit doit l'admettre.
 */
import type { SwarmDb } from '../index'
import type {
  Opportunity,
  OpportunityStatus,
  ScoreBreakdown as StoredBreakdown,
} from '../schema'
import type { ScoreBreakdown } from '@/scoring/ev'
import { expiresAtMs } from '@/scoring/freshness'
import type { Clock } from '@/shared/time'
import { err, ok, type Result } from '@/shared/result'

export type UpsertError =
  { kind: 'duplicate'; existingId: number } | { kind: 'db'; detail: string }

export interface QueueEntry extends Opportunity {
  id: number
}

/** Conversion du décomposé de calcul vers la forme stockée. */
export function toStoredBreakdown(breakdown: ScoreBreakdown): StoredBreakdown {
  return {
    reach: breakdown.factors.reach,
    nicheRelevance: breakdown.factors.nicheRelevance,
    freshness: breakdown.factors.freshness,
    saturation: breakdown.factors.saturationInverse,
    authorAffinity: breakdown.factors.authorAffinity,
    ev: breakdown.ev,
  }
}

export class OpportunityRepo {
  constructor(
    private readonly database: SwarmDb,
    private readonly clock: Clock,
  ) {}

  /**
   * Insère une opportunité, ou met à jour son score si elle existe déjà.
   *
   * Le même post peut être revu au fil du scroll, et ses métriques auront changé — un post
   * qui a pris 40 réponses depuis n'est plus la même opportunité. Rafraîchir plutôt que
   * refuser est donc le bon comportement, **sauf** si l'opportunité a déjà été traitée :
   * remettre en file un post déjà rédigé ou déjà rejeté ferait retravailler dessus.
   */
  async upsert(
    opportunity: Omit<Opportunity, 'id'>,
  ): Promise<Result<number, UpsertError>> {
    try {
      const existing = await this.database.opportunities
        .where('postId')
        .equals(opportunity.postId)
        .first()

      if (existing?.id !== undefined) {
        if (TERMINAL_STATUSES.includes(existing.status)) {
          return err({ kind: 'duplicate', existingId: existing.id })
        }
        await this.database.opportunities.update(existing.id, {
          evScore: opportunity.evScore,
          scoreBreakdown: opportunity.scoreBreakdown,
          metrics: opportunity.metrics,
          observedAtMs: opportunity.observedAtMs,
          status: opportunity.status,
          rejectionReason: opportunity.rejectionReason,
        })
        return ok(existing.id)
      }

      const id = await this.database.opportunities.add(opportunity as Opportunity)
      return ok(id as number)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      return err({ kind: 'db', detail })
    }
  }

  async upsertMany(
    opportunities: readonly Omit<Opportunity, 'id'>[],
  ): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0
    let skipped = 0
    for (const opportunity of opportunities) {
      const result = await this.upsert(opportunity)
      if (result.ok) inserted += 1
      else skipped += 1
    }
    return { inserted, skipped }
  }

  /**
   * File de travail, triée par EV décroissant.
   *
   * Les opportunités périmées sont **exclues à la lecture** en plus d'être purgées : la purge
   * tourne sur alarme, la lecture est immédiate. Sans ce double filtre, l'utilisateur qui
   * ouvre le Flux juste avant une purge verrait des posts morts en tête de file.
   */
  async queue(limit = 50, maxAgeMinutes = 90): Promise<QueueEntry[]> {
    const now = this.clock.now()
    const rows = await this.database.opportunities
      .where('status')
      .anyOf('qualified', 'drafted', 'queued')
      .toArray()

    return rows
      .filter((row): row is QueueEntry => row.id !== undefined)
      .filter((row) => expiresAtMs(row.postedAtMs, maxAgeMinutes) > now)
      .sort((a, b) => b.evScore - a.evScore)
      .slice(0, limit)
  }

  /** Tête de file — l'opportunité que le Flux propose en premier. */
  async next(maxAgeMinutes = 90): Promise<QueueEntry | null> {
    return (await this.queue(1, maxAgeMinutes))[0] ?? null
  }

  async setStatus(
    id: number,
    status: OpportunityStatus,
    rejectionReason: string | null = null,
  ): Promise<void> {
    await this.database.opportunities.update(id, { status, rejectionReason })
  }

  async get(id: number): Promise<QueueEntry | null> {
    const row = await this.database.opportunities.get(id)
    return row?.id !== undefined ? (row as QueueEntry) : null
  }

  async byPostId(postId: string): Promise<QueueEntry | null> {
    const row = await this.database.opportunities.where('postId').equals(postId).first()
    return row?.id !== undefined ? (row as QueueEntry) : null
  }

  /**
   * Marque comme expirées les opportunités trop vieilles.
   *
   * On ne les supprime pas : le motif d'expiration est une donnée d'analyse — un taux
   * d'expiration élevé signifie que l'utilisateur ne suit pas le rythme de sa file, et
   * c'est un réglage de plafond à revoir, pas un bug à masquer.
   */
  async expireStale(maxAgeMinutes = 90): Promise<{ expired: number }> {
    const now = this.clock.now()
    const rows = await this.database.opportunities
      .where('status')
      .anyOf('qualified', 'drafted', 'queued')
      .toArray()

    let expired = 0
    for (const row of rows) {
      if (row.id === undefined) continue
      if (expiresAtMs(row.postedAtMs, maxAgeMinutes) > now) continue
      await this.database.opportunities.update(row.id, {
        status: 'expired',
        rejectionReason: 'périmée avant traitement',
      })
      expired += 1
    }
    return { expired }
  }

  /** Statistiques de file, pour le cockpit et l'onglet Analytics. */
  async stats(maxAgeMinutes = 90): Promise<QueueStats> {
    const all = await this.database.opportunities.toArray()
    const byStatus = new Map<OpportunityStatus, number>()
    for (const row of all) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1)

    const live = await this.queue(1_000, maxAgeMinutes)
    const evScores = live.map((row) => row.evScore)

    return {
      total: all.length,
      queued: live.length,
      byStatus: Object.fromEntries(byStatus) as Record<OpportunityStatus, number>,
      avgEv:
        evScores.length === 0 ? 0 : evScores.reduce((a, b) => a + b, 0) / evScores.length,
      topEv: evScores.length === 0 ? 0 : Math.max(...evScores),
      // Un taux d'expiration élevé dit que la file produit plus que l'utilisateur ne
      // consomme : c'est un réglage, pas une panne.
      expiredRate: all.length === 0 ? 0 : (byStatus.get('expired') ?? 0) / all.length,
      criticRejectedRate:
        all.length === 0 ? 0 : (byStatus.get('rejected-critic') ?? 0) / all.length,
      qualifierRejectedRate:
        all.length === 0 ? 0 : (byStatus.get('rejected-qualifier') ?? 0) / all.length,
    }
  }

  /** Vrai si ce post a déjà été vu — évite de repayer un triage. */
  async isKnown(postId: string): Promise<boolean> {
    return (await this.database.opportunities.where('postId').equals(postId).count()) > 0
  }

  /** Identifiants déjà connus parmi une liste — filtre de lot avant triage. */
  async knownPostIds(postIds: readonly string[]): Promise<Set<string>> {
    const known = new Set<string>()
    // `anyOf` sur un index unique : une seule requête plutôt qu'une par identifiant.
    const rows = await this.database.opportunities
      .where('postId')
      .anyOf([...postIds])
      .toArray()
    for (const row of rows) known.add(row.postId)
    return known
  }
}

export interface QueueStats {
  total: number
  queued: number
  byStatus: Record<OpportunityStatus, number>
  avgEv: number
  topEv: number
  expiredRate: number
  criticRejectedRate: number
  qualifierRejectedRate: number
}

/**
 * États terminaux : une opportunité dans un de ces états ne revient jamais en file.
 *
 * `rejected-critic` en fait partie, et c'est important : sans ça, un post rejeté serait
 * requalifié au prochain passage dans le viewport, repayé, et rejeté à nouveau. La boucle
 * coûterait du budget indéfiniment sans rien produire.
 */
export const TERMINAL_STATUSES: readonly OpportunityStatus[] = [
  'rejected-qualifier',
  'rejected-critic',
  'published',
  'abandoned',
  'expired',
]
