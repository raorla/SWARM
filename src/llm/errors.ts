/**
 * Classification des erreurs LLM — FEEDBACK MH-16.
 *
 * La distinction retryable / non-retryable n'est pas cosmétique : un retry aveugle sur
 * un 400 brûle du budget sans jamais aboutir, et un abandon sur un 429 fige le swarm
 * alors qu'attendre trois secondes aurait suffi.
 */

export type LlmErrorKind =
  | 'auth' // 401/403 — clé invalide ou révoquée
  | 'rate-limit' // 429
  | 'server' // 5xx
  | 'network' // échec de transport, DNS, offline
  | 'timeout'
  | 'aborted' // annulation volontaire (kill switch)
  | 'bad-request' // 400 — notre requête est fausse
  | 'context-length' // prompt trop long
  | 'content-filter' // refus du modèle
  | 'invalid-json' // réponse illisible ou hors schéma après réparation
  | 'truncated' // le modèle a été coupé par `max_tokens` — voir le commentaire ci-dessous
  | 'budget-exhausted'
  | 'no-permission' // host permission non accordée
  | 'unknown'

/**
 * Pourquoi `truncated` est distinct de `invalid-json`.
 *
 * Une réponse coupée par `max_tokens` **est** un JSON illisible : elle s'arrête au milieu d'un
 * objet. Les confondre envoie chercher le bug dans le parseur, alors que le correctif est de
 * relever le plafond de sortie ou de réduire la taille du lot. Constaté le 2026-08-26 : quatre
 * lots de triage sur quatre rapportaient « réponse illisible malgré réparation », et le prompt
 * comme le parseur étaient corrects — le modèle émettait 1 711 tokens là où le plafond en
 * autorisait 2 000, et le dépassait dès que les notes s'allongeaient.
 *
 * Conséquence pratique : `truncated` **ne se réessaie pas à l'identique**. Le même appel
 * tronquera au même endroit.
 */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly detail?: {
      status?: number
      provider?: string
      model?: string
      retryAfterMs?: number
    },
  ) {
    super(message)
    this.name = 'LlmError'
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind)
  }
}

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set<LlmErrorKind>([
  'rate-limit',
  'server',
  'network',
  'timeout',
  // 'invalid-json' est retryable une fois : la réparation passe par un second appel avec
  // une consigne plus stricte, ce qui aboutit souvent.
  'invalid-json',
  // 'truncated' est volontairement ABSENT : le même appel tronquera au même endroit. Réessayer
  // paierait deux fois pour le même échec.
])

/** Traduit un statut HTTP en `LlmErrorKind`. */
export function kindFromStatus(status: number, body?: string): LlmErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status >= 500) return 'server'
  if (status === 400) {
    const b = (body ?? '').toLowerCase()
    if (b.includes('context') && (b.includes('length') || b.includes('window'))) {
      return 'context-length'
    }
    if (b.includes('content') && (b.includes('filter') || b.includes('policy'))) {
      return 'content-filter'
    }
    return 'bad-request'
  }
  return 'unknown'
}

/** Extrait `Retry-After` (secondes ou date HTTP) en millisecondes. */
export function retryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined
}

export function describeLlmError(e: LlmError): string {
  switch (e.kind) {
    case 'auth':
      return 'clé API refusée — vérifie-la dans l’onglet Config'
    case 'rate-limit':
      return 'quota provider atteint — nouvelle tentative programmée'
    case 'server':
      return 'panne côté provider — repli ou nouvelle tentative'
    case 'network':
      return 'réseau indisponible'
    case 'timeout':
      return 'le provider n’a pas répondu à temps'
    case 'aborted':
      return 'appel annulé'
    case 'bad-request':
      return `requête invalide : ${e.message}`
    case 'context-length':
      return 'prompt trop long pour ce modèle'
    case 'truncated':
      // Le message porte le correctif, pas le symptôme : c'est le plafond de sortie qu'il
      // faut relever, ou le lot qu'il faut réduire.
      return `réponse coupée par le plafond de sortie — ${e.message}`
    case 'content-filter':
      return 'le modèle a refusé de répondre'
    case 'invalid-json':
      return 'réponse illisible malgré réparation'
    case 'budget-exhausted':
      return 'budget quotidien épuisé'
    case 'no-permission':
      return 'permission d’accès au provider non accordée'
    case 'unknown':
      return e.message
  }
}
