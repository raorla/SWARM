/**
 * Accès aux actions — porte l'invariant d'idempotence (MH-07).
 */
import type { SwarmDb } from '../index'
import type { Action } from '../schema'
import type { Clock } from '@/shared/time'
import { err, ok, type Result } from '@/shared/result'

export type StageError =
  { kind: 'duplicate'; existingId: number } | { kind: 'db'; detail: string }

export class ActionRepo {
  constructor(
    private readonly database: SwarmDb,
    private readonly clock: Clock,
  ) {}

  /** Vrai si cette clé a déjà produit une action. Branché sur `Governor.isDuplicate`. */
  async exists(idempotencyKey: string): Promise<boolean> {
    return (
      (await this.database.actions
        .where('idempotencyKey')
        .equals(idempotencyKey)
        .count()) > 0
    )
  }

  /**
   * Insère une action mise en scène.
   *
   * L'unicité est garantie par l'index `&idempotencyKey`, pas par un `exists()` préalable :
   * une vérification applicative peut courir contre elle-même si le service worker
   * redémarre entre la lecture et l'écriture. On laisse donc la base refuser, et on
   * traduit son erreur de contrainte.
   */
  async stage(action: Omit<Action, 'id'>): Promise<Result<number, StageError>> {
    try {
      const id = await this.database.actions.add(action as Action)
      return ok(id as number)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/constraint/i.test(msg)) {
        const existing = await this.database.actions
          .where('idempotencyKey')
          .equals(action.idempotencyKey)
          .first()
        return err({ kind: 'duplicate', existingId: existing?.id ?? -1 })
      }
      return err({ kind: 'db', detail: msg })
    }
  }

  /** Confirme qu'une action a réellement été publiée par l'utilisateur (MH-09). */
  async confirmPublished(idempotencyKey: string, xPostId: string | null): Promise<void> {
    await this.database.actions
      .where('idempotencyKey')
      .equals(idempotencyKey)
      .modify({ outcome: 'published', publishedAtMs: this.clock.now(), xPostId })
  }

  /**
   * Marque une action comme abandonnée : le brouillon a été mis en scène mais l'humain
   * n'a pas publié. Ce n'est pas un échec — c'est un signal d'apprentissage, le
   * désaccord silencieux de l'utilisateur avec le CRITIC.
   */
  async markAbandoned(idempotencyKey: string): Promise<void> {
    await this.database.actions
      .where('idempotencyKey')
      .equals(idempotencyKey)
      .modify({ outcome: 'abandoned' })
  }

  /** Actions en attente de confirmation, pour la reprise après réveil du worker. */
  async pending(): Promise<Action[]> {
    return this.database.actions.where('outcome').equals('pending').toArray()
  }

  /** Actions publiées dont la mesure à J+`offset` est due. */
  async dueForMeasurement(dayOffset: 1 | 7, nowMs: number): Promise<Action[]> {
    const cutoff = nowMs - dayOffset * 86_400_000
    const published = await this.database.actions
      .where('outcome')
      .equals('published')
      .toArray()
    const measured = new Set(
      (await this.database.outcomes.where('dayOffset').equals(dayOffset).toArray()).map(
        (o) => o.actionId,
      ),
    )
    return published.filter(
      (a) =>
        a.publishedAtMs !== null && a.publishedAtMs <= cutoff && !measured.has(a.id!),
    )
  }

  async countToday(startOfDayMs: number): Promise<number> {
    return this.database.actions.where('stagedAtMs').above(startOfDayMs).count()
  }

  /** Taux d'abandon — métrique de l'onglet Analytics (MH-09). */
  async abandonRate(): Promise<{ rate: number; sample: number }> {
    const settled = await this.database.actions
      .where('outcome')
      .anyOf('published', 'abandoned')
      .toArray()
    if (settled.length === 0) return { rate: 0, sample: 0 }
    const abandoned = settled.filter((a) => a.outcome === 'abandoned').length
    return { rate: abandoned / settled.length, sample: settled.length }
  }
}
