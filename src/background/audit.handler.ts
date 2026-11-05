/**
 * JOURNAL D'AUDIT — lecture pour l'UI (Phase 4).
 *
 * Le journal est chaîné par hash (`governor/audit.ts`) : chaque entrée contient le hash de la
 * précédente. Une entrée modifiée ou supprimée en base casse la chaîne, et la rupture est
 * détectable.
 *
 * ## Pourquoi l'UI affiche le résultat de la vérification, et pas seulement les lignes
 *
 * Un journal « inaltérable » qui n'est jamais vérifié est un journal ordinaire. La promesse
 * n'a de valeur que si quelqu'un contrôle la chaîne, et l'endroit où ce contrôle a une chance
 * d'être vu est l'écran qui affiche le journal. On le fait donc à chaque lecture — le coût est
 * un hachage par entrée, imperceptible aux volumes en jeu, et il tombe du bon côté du
 * compromis.
 *
 * Une rupture n'est pas forcément malveillante : une purge de rétention mal faite, un import
 * partiel, un bug de migration la produisent aussi. Le message ne l'interprète donc pas — il
 * indique où la chaîne se casse et laisse conclure.
 */
import { db, type SwarmDb } from '@/db'
import { AuditLog, type AuditEntry } from '@/governor/audit'
import { systemClock, type Clock } from '@/shared/time'

/** Fenêtre par défaut : ce qu'un humain peut relire, pas ce que la base peut rendre. */
export const AUDIT_PAGE_SIZE = 100

export interface AuditDeps {
  database: SwarmDb
  clock: Clock
}

const defaultDeps = (): AuditDeps => ({ database: db(), clock: systemClock })

export interface AuditListing {
  /** Les entrées les plus récentes d'abord — l'ordre de lecture d'un journal. */
  entries: AuditEntry[]
  total: number
  chain: { valid: boolean; brokenAtSeq: number | null }
  /** Phrase prête à afficher sur l'état de la chaîne. */
  chainLabel: string
}

export async function listAudit(
  limit = AUDIT_PAGE_SIZE,
  deps: AuditDeps = defaultDeps(),
): Promise<AuditListing> {
  const { database, clock } = deps
  const total = await database.auditLog.count()

  // `reverse()` sur l'index `seq` : on veut la fin du journal, pas son début, et remonter
  // toute la table pour en couper 100 lignes serait absurde sur un journal d'un an.
  const entries = await database.auditLog.orderBy('seq').reverse().limit(limit).toArray()

  const store = {
    append: async () => {
      throw new Error('lecture seule')
    },
    last: async () => database.auditLog.orderBy('seq').last(),
    all: async () => database.auditLog.orderBy('seq').toArray(),
  }
  const chain = await new AuditLog(store, clock).verifyChain()

  return {
    entries,
    total,
    chain,
    chainLabel: describeChain(chain, total),
  }
}

export function describeChain(
  chain: { valid: boolean; brokenAtSeq: number | null },
  total: number,
): string {
  if (total === 0) return 'Journal vide — aucune action n’a encore été effectuée.'
  if (chain.valid) return `Chaîne vérifiée : ${total} entrée${total > 1 ? 's' : ''} intacte${total > 1 ? 's' : ''}.`
  return (
    `Chaîne rompue à l’entrée ${chain.brokenAtSeq ?? '?'}. ` +
    'Les entrées suivantes ne peuvent plus être considérées comme une preuve. ' +
    'Causes possibles : purge de rétention, import partiel, modification manuelle de la base.'
  )
}
