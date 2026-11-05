/**
 * Corpus des posts de l'utilisateur — source du Voice Profile.
 *
 * Deux responsabilités qui vont ensemble : stocker, et **qualifier au moment du stockage**.
 * Le drapeau `passesGuard` est calculé à l'écriture, pas à la lecture, parce que le Voice
 * Profile le lira des dizaines de fois et que le classifieur, même gratuit, n'a pas à
 * tourner en boucle (MH-18).
 */
import type { SwarmDb } from '../index'
import type { OwnPost } from '../schema'
import { classifyTopic } from '@/governor/topic-guard'
import type { Clock } from '@/shared/time'

export interface CorpusStats {
  total: number
  passingGuard: number
  excludedByGuard: number
  excludedRatio: number
  oldestPostedAtMs: number | null
  newestPostedAtMs: number | null
}

export type OwnPostInput = Omit<
  OwnPost,
  'id' | 'collectedAtMs' | 'passesGuard' | 'guardCategories'
>

export class OwnPostRepo {
  constructor(
    private readonly database: SwarmDb,
    private readonly clock: Clock,
  ) {}

  /**
   * Insère ou met à jour un post du corpus.
   *
   * `put` et non `add` : recollecter le même post doit rafraîchir ses métriques, pas
   * échouer sur la contrainte d'unicité. Un corpus qu'on ne peut pas re-collecter serait
   * figé au premier passage.
   */
  async upsert(
    input: OwnPostInput,
    packBlockedTopics: readonly string[] = [],
  ): Promise<void> {
    const verdict = classifyTopic(input.text, packBlockedTopics)
    const existing = await this.database.ownPosts
      .where('postId')
      .equals(input.postId)
      .first()

    const record: OwnPost = {
      ...input,
      ...(existing?.id !== undefined ? { id: existing.id } : {}),
      collectedAtMs: this.clock.now(),
      passesGuard: !verdict.blocked,
      guardCategories: [...verdict.categories],
    }
    await this.database.ownPosts.put(record)
  }

  async upsertMany(
    inputs: readonly OwnPostInput[],
    packBlockedTopics: readonly string[] = [],
  ): Promise<{ inserted: number }> {
    for (const input of inputs) await this.upsert(input, packBlockedTopics)
    return { inserted: inputs.length }
  }

  /** Corpus entier — base des statistiques de forme (MH-18). */
  async all(): Promise<OwnPost[]> {
    return this.database.ownPosts.orderBy('postedAtMs').reverse().toArray()
  }

  /** Corpus assaini — base des exemples canoniques et des règles `do` (MH-18). */
  async passingGuard(): Promise<OwnPost[]> {
    return (await this.all()).filter((p) => p.passesGuard)
  }

  async count(): Promise<number> {
    return this.database.ownPosts.count()
  }

  async stats(): Promise<CorpusStats> {
    const all = await this.all()
    const passing = all.filter((p) => p.passesGuard).length
    return {
      total: all.length,
      passingGuard: passing,
      excludedByGuard: all.length - passing,
      excludedRatio: all.length === 0 ? 0 : (all.length - passing) / all.length,
      oldestPostedAtMs:
        all.length === 0 ? null : Math.min(...all.map((p) => p.postedAtMs)),
      newestPostedAtMs:
        all.length === 0 ? null : Math.max(...all.map((p) => p.postedAtMs)),
    }
  }

  /**
   * Requalifie tout le corpus.
   *
   * Nécessaire quand le pack de niche change ses sujets bloqués, ou quand le noyau du
   * topic-guard évolue : sinon `passesGuard` reflèterait des règles qui n'existent plus, et
   * le Voice Profile s'appuierait sur une qualification périmée.
   */
  async requalify(
    packBlockedTopics: readonly string[] = [],
  ): Promise<{ changed: number }> {
    const all = await this.all()
    let changed = 0
    for (const post of all) {
      const verdict = classifyTopic(post.text, packBlockedTopics)
      const passes = !verdict.blocked
      if (passes !== post.passesGuard && post.id !== undefined) {
        await this.database.ownPosts.update(post.id, {
          passesGuard: passes,
          guardCategories: [...verdict.categories],
        })
        changed += 1
      }
    }
    return { changed }
  }

  async clear(): Promise<void> {
    await this.database.ownPosts.clear()
  }
}
