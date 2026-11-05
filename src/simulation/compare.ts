/**
 * COMPARAISON DE CONFIGURATIONS — l'usage réel du backtest.
 *
 * Rejouer une archive ne sert à rien en soi. Ce qui sert, c'est de savoir si un seuil relevé
 * améliore la sélection ou l'appauvrit. Ce module produit cette réponse, et surtout dit
 * **quand il ne peut pas la donner**.
 *
 * ## Ce que la comparaison ne peut pas dire
 *
 * Le backtest rejoue des verdicts archivés : il compare des **politiques de sélection**, pas
 * des qualités de rédaction. Il répond à « ce seuil aurait-il retenu ce post ? », jamais à
 * « la réponse aurait-elle été meilleure ? ». Deux configurations qui retiennent le même
 * nombre de posts de qualité comparable sont indistinguables ici, et le dire est plus utile
 * que de fabriquer un écart.
 */
import type { Archive, ReplayConfig, ReplayReport } from './replay'
import { replayArchive } from './replay'

export interface ComparisonRow {
  label: string
  queued: number
  repliesPerDay: number
  avgQueuedEv: number
  /** Part des posts vus qui atteignent la file. */
  selectivity: number
  /** Répartition des motifs de rejet, les plus fréquents d'abord. */
  topRejectionReasons: { decision: string; count: number }[]
}

export interface ComparisonResult {
  rows: ComparisonRow[]
  /** Configuration recommandée, ou `null` si aucune ne se distingue. */
  recommended: string | null
  verdict: string
  /** Vrai si l'archive est trop mince pour conclure. */
  insufficientArchive: boolean
}

/** En dessous, l'archive ne permet pas de conclure. */
export const MIN_ARCHIVE_POSTS = 200

/** En dessous, deux configurations sont considérées équivalentes. */
export const MEANINGFUL_DIFFERENCE = 0.15

/**
 * Rejoue la même archive sous plusieurs configurations et compare.
 *
 * Le critère de recommandation n'est **pas** « le plus de réponses ». Un seuil bas retient
 * tout, ce qui maximise le volume et minimise la qualité — c'est exactement le comportement
 * que le produit existe pour éviter. On cherche le meilleur compromis : un volume proche du
 * plafond configuré, avec le meilleur EV moyen.
 */
export function compareConfigs(
  archive: Archive,
  configs: readonly ReplayConfig[],
): ComparisonResult {
  const reports = configs.map((config) => replayArchive(archive, config))
  const rows = reports.map((report) => toRow(report, archive.posts.length))

  if (archive.posts.length < MIN_ARCHIVE_POSTS) {
    return {
      rows,
      recommended: null,
      insufficientArchive: true,
      verdict:
        `Archive de ${archive.posts.length} posts : trop mince pour conclure ` +
        `(il en faut au moins ${MIN_ARCHIVE_POSTS}). Les écarts observés peuvent venir de l’échantillon.`,
    }
  }

  if (rows.length < 2) {
    return {
      rows,
      recommended: rows[0]?.label ?? null,
      insufficientArchive: false,
      verdict: 'Une seule configuration rejouée : rien à comparer.',
    }
  }

  const targetPerDay = medianRepliesPerDay(rows)
  const scored = rows.map((row) => ({
    row,
    // Un volume proche de la médiane du groupe, pondéré par la qualité moyenne. Maximiser le
    // volume seul récompenserait le seuil le plus laxiste.
    score: row.avgQueuedEv * volumeFit(row.repliesPerDay, targetPerDay),
  }))

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a))
  const worst = scored.reduce((a, b) => (b.score < a.score ? b : a))

  const relativeGap =
    worst.score === 0 ? Infinity : (best.score - worst.score) / Math.abs(worst.score)

  if (relativeGap < MEANINGFUL_DIFFERENCE) {
    // Fabriquer un gagnant sur un écart de 3 % ferait prendre une décision sur du bruit.
    return {
      rows,
      recommended: null,
      insufficientArchive: false,
      verdict: `Aucune configuration ne se distingue (écart de ${(relativeGap * 100).toFixed(0)} %, seuil ${(MEANINGFUL_DIFFERENCE * 100).toFixed(0)} %). Garde la plus simple.`,
    }
  }

  return {
    rows,
    recommended: best.row.label,
    insufficientArchive: false,
    verdict:
      `« ${best.row.label} » retient ${best.row.queued} opportunités ` +
      `(${best.row.repliesPerDay.toFixed(1)}/jour, EV moyen ${(best.row.avgQueuedEv * 100).toFixed(0)} %), ` +
      `soit ${(relativeGap * 100).toFixed(0)} % de mieux que « ${worst.row.label} ».`,
  }
}

function toRow(report: ReplayReport, totalPosts: number): ComparisonRow {
  const rejections = Object.entries(report.counts)
    .filter(([decision]) => decision !== 'queued')
    .map(([decision, count]) => ({ decision, count }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  return {
    label: report.label,
    queued: report.queued,
    repliesPerDay: report.repliesPerDay,
    avgQueuedEv: report.avgQueuedEv,
    selectivity: totalPosts === 0 ? 0 : report.queued / totalPosts,
    topRejectionReasons: rejections,
  }
}

function medianRepliesPerDay(rows: readonly ComparisonRow[]): number {
  const values = rows.map((r) => r.repliesPerDay).sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)] ?? 0
}

/**
 * Adéquation du volume à la cible, dans [0, 1].
 *
 * Pénalise autant le trop que le trop peu : une configuration qui ne retient rien est aussi
 * inutile qu'une qui retient tout.
 */
function volumeFit(actual: number, target: number): number {
  if (target === 0) return actual === 0 ? 1 : 0
  const ratio = actual / target
  return ratio <= 1 ? ratio : 1 / ratio
}

/**
 * Vérifie que deux rejeux de la même configuration sont identiques.
 *
 * C'est la propriété sans laquelle tout le module ne sert à rien : si le même run donne deux
 * résultats, un écart entre deux configurations peut venir du hasard, et le backtest produit
 * des conclusions au lieu de les vérifier.
 */
export function verifyDeterminism(
  archive: Archive,
  config: ReplayConfig,
  runs = 3,
): { deterministic: boolean; detail: string } {
  const fingerprints = Array.from({ length: runs }, () =>
    replayArchive(archive, config)
      .outcomes.map((o) => `${o.postId}:${o.decision}:${o.evScore.toFixed(6)}`)
      .join('|'),
  )

  const unique = new Set(fingerprints)
  return {
    deterministic: unique.size === 1,
    detail:
      unique.size === 1
        ? `${runs} rejeux identiques : le backtest est reproductible.`
        : `${unique.size} résultats différents sur ${runs} rejeux — une source de non-déterminisme subsiste, les comparaisons ne valent rien.`,
  }
}
