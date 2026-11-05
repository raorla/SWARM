/**
 * Purge de rétention — FEEDBACK MH-13.
 *
 * Deux raisons de purger, dont une seule est technique. La technique : une base qui
 * grossit sans borne finit par se faire évincer par le navigateur, et on perd alors les
 * données de valeur en même temps que le remplissage. L'autre : on garderait par défaut
 * du contenu de tiers qui n'a servi à rien.
 *
 * Ce qui est purgé : le **texte brut** des opportunités non retenues. Ce qui reste : le
 * score, le motif de rejet, les patterns. On garde ce qui apprend, on jette ce qui ne
 * fait que peser.
 */
import type { SwarmDb } from './index'
import { DAY, type Clock } from '@/shared/time'
import { createLogger } from '@/shared/logger'

const log = createLogger('db:retention')

export interface PurgeReport {
  opportunitiesRedacted: number
  opportunitiesDeleted: number
  embeddingsDeleted: number
  cutoffMs: number
}

/** Marqueur laissé à la place du texte purgé — distingue « purgé » de « jamais eu de texte ». */
export const PURGED_MARKER = '«purgé»'

const REJECTED_STATUSES = ['rejected-qualifier', 'rejected-critic', 'expired'] as const

export async function purgeExpired(
  database: SwarmDb,
  clock: Clock,
  retentionDays: number,
): Promise<PurgeReport> {
  const cutoff = clock.now() - Math.max(1, retentionDays) * DAY
  const report: PurgeReport = {
    opportunitiesRedacted: 0,
    opportunitiesDeleted: 0,
    embeddingsDeleted: 0,
    cutoffMs: cutoff,
  }

  const stale = await database.opportunities.where('createdAtMs').below(cutoff).toArray()

  for (const opp of stale) {
    if (opp.id === undefined) continue

    // Une opportunité rejetée n'a plus aucune valeur en tant que texte : on ne garde que
    // le motif, qui est ce qui sert à régler les seuils.
    if ((REJECTED_STATUSES as readonly string[]).includes(opp.status)) {
      await database.opportunities.delete(opp.id)
      report.opportunitiesDeleted++
      const removed = await database.embeddings
        .where('[refType+refId]')
        .equals(['opportunity', String(opp.id)])
        .delete()
      report.embeddingsDeleted += removed
      continue
    }

    // Une opportunité aboutie garde sa trace (elle est liée à une action mesurée), mais
    // son texte brut n'a plus d'usage : le pattern appris est déjà dans `patterns`.
    if (opp.text !== PURGED_MARKER) {
      await database.opportunities.update(opp.id, { text: PURGED_MARKER })
      report.opportunitiesRedacted++
    }
  }

  log.info('purge de rétention effectuée', report)
  return report
}
