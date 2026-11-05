/**
 * Débit borné et contre-pression — SPEC §4.1.
 *
 * Deux contraintes distinctes, et il faut les deux :
 *
 *  1. **Ne pas dégrader le scroll de X** (SPEC §8). Le travail d'extraction est découpé et
 *     exécuté pendant les temps morts du navigateur, avec un budget par tranche. Un
 *     `MutationObserver` qui parse 40 articles synchrones fait sauter le scroll — et un
 *     produit qui rend X désagréable ne sera pas utilisé, quelles que soient ses réponses.
 *  2. **Rester une lecture passive.** Un plafond par minute empêche le scout de se
 *     transformer en collecteur de masse si l'utilisateur fait défiler longtemps.
 */

/** Budget de temps par tranche de travail, en millisecondes. */
const SLICE_BUDGET_MS = 8

/** Au-delà, la file d'attente est purgée de ses éléments les plus anciens. */
const MAX_QUEUE = 200

/** Tranches successives sans progrès avant de laisser la file en attente. */
const MAX_EMPTY_DRAINS = 3

export interface ThrottleConfig {
  /** Nombre maximum de posts extraits par minute. */
  maxPerMinute: number
  /** Taille maximale d'un lot envoyé au service worker. */
  batchSize: number
  /** Délai avant envoi d'un lot incomplet. */
  flushAfterMs: number
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  maxPerMinute: 120,
  batchSize: 25,
  flushAfterMs: 5_000,
}

/**
 * Seau à jetons.
 *
 * Retenu plutôt qu'un compteur par fenêtre glissante parce qu'il autorise une petite
 * rafale — ce qui correspond au comportement réel d'un utilisateur qui arrive sur sa
 * timeline — sans laisser le débit moyen dériver.
 */
export class TokenBucket {
  private tokens: number
  private lastRefillMs: number

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    nowMs: number,
  ) {
    this.tokens = capacity
    this.lastRefillMs = nowMs
  }

  static perMinute(maxPerMinute: number, nowMs: number): TokenBucket {
    // Capacité = un quart du débit horaire : assez pour une rafale d'arrivée, pas assez
    // pour accumuler un droit de collecte pendant une absence.
    const capacity = Math.max(1, Math.ceil(maxPerMinute / 4))
    return new TokenBucket(capacity, maxPerMinute / 60_000, nowMs)
  }

  private refill(nowMs: number): void {
    const elapsed = Math.max(0, nowMs - this.lastRefillMs)
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
    this.lastRefillMs = nowMs
  }

  tryConsume(nowMs: number, count = 1): boolean {
    this.refill(nowMs)
    if (this.tokens < count) return false
    this.tokens -= count
    return true
  }

  available(nowMs: number): number {
    this.refill(nowMs)
    return Math.floor(this.tokens)
  }
}

export interface Scheduler {
  /** Planifie `fn` pendant un temps mort du navigateur. */
  idle(fn: (deadlineMs: number) => void): void
  now(): number
}

/**
 * Ordonnanceur réel. `requestIdleCallback` est le bon outil : il rend la main dès que le
 * navigateur a du travail de rendu, ce qui est exactement l'inverse du comportement d'un
 * `setTimeout(0)` qui s'exécute au pire moment.
 */
export function browserScheduler(): Scheduler {
  return {
    idle: (fn) => {
      const ric = (globalThis as { requestIdleCallback?: typeof requestIdleCallback })
        .requestIdleCallback
      if (typeof ric === 'function') {
        ric((deadline) => fn(performance.now() + deadline.timeRemaining()), {
          timeout: 1_000,
        })
      } else {
        // Repli : on cède au moins une frame avant de travailler.
        setTimeout(() => fn(performance.now() + SLICE_BUDGET_MS), 16)
      }
    },
    now: () => performance.now(),
  }
}

/**
 * File de travail découpée en tranches.
 *
 * `process` est appelée élément par élément et le traitement s'arrête dès que le budget de
 * la tranche est épuisé — pas à la fin du lot. C'est ce qui garantit que l'extraction ne
 * bloque jamais une frame, même si un post est anormalement coûteux à parser.
 */
export class SlicedQueue<T> {
  private readonly queue: T[] = []
  private scheduled = false
  private dropped = 0
  /**
   * Tranches consécutives n'ayant traité aucun élément.
   *
   * Quand le navigateur est saturé, il accorde des tranches sans budget utilisable. Se
   * replanifier indéfiniment dans ce cas est du gaspillage pur — et avec un ordonnanceur
   * synchrone, c'est un débordement de pile. Au-delà de la borne, la file attend le
   * prochain `push` : laisser des posts en attente pendant que le navigateur travaille est
   * exactement le bon arbitrage, puisque la priorité est de ne pas dégrader le scroll.
   */
  private emptyDrains = 0

  constructor(
    private readonly scheduler: Scheduler,
    private readonly process: (item: T) => void,
  ) {}

  push(item: T): void {
    if (this.queue.length >= MAX_QUEUE) {
      // On jette les plus anciens : un post vu il y a trente secondes de scroll a perdu
      // sa fraîcheur, donc son intérêt. Garder les récents est le bon arbitrage.
      this.queue.shift()
      this.dropped += 1
    }
    this.queue.push(item)
    // Un nouvel élément relance la file même si elle s'était mise en attente.
    this.emptyDrains = 0
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled || this.queue.length === 0) return
    if (this.emptyDrains >= MAX_EMPTY_DRAINS) return
    this.scheduled = true
    this.scheduler.idle((deadlineMs) => {
      this.scheduled = false
      this.drain(deadlineMs)
    })
  }

  private drain(deadlineMs: number): void {
    let processed = 0
    while (this.queue.length > 0 && this.scheduler.now() < deadlineMs) {
      const item = this.queue.shift()
      if (item === undefined) break
      processed += 1
      try {
        this.process(item)
      } catch {
        // Un post qui fait échouer le parsing ne doit pas arrêter la file : le suivant
        // sera peut-être exploitable, et l'échec est déjà compté par la télémétrie.
      }
    }
    this.emptyDrains = processed === 0 ? this.emptyDrains + 1 : 0
    // Budget épuisé mais file non vide : on reprend à la prochaine tranche.
    this.schedule()
  }

  /** Vrai si la file s'est mise en attente faute de budget accordé. */
  get isStalled(): boolean {
    return this.emptyDrains >= MAX_EMPTY_DRAINS && this.queue.length > 0
  }

  get pending(): number {
    return this.queue.length
  }

  get droppedCount(): number {
    return this.dropped
  }

  clear(): void {
    this.queue.length = 0
    this.emptyDrains = 0
  }
}

/**
 * Accumulateur de lots.
 *
 * Envoyer chaque post individuellement au service worker le réveillerait en permanence —
 * coûteux en batterie, et contraire au fonctionnement de MV3. On regroupe, et on force
 * l'envoi après un délai pour qu'un lot incomplet ne reste jamais bloqué.
 */
export class Batcher<T> {
  private batch: T[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly config: ThrottleConfig,
    private readonly flush: (items: readonly T[]) => void,
  ) {}

  add(item: T): void {
    this.batch.push(item)
    if (this.batch.length >= this.config.batchSize) {
      this.flushNow()
      return
    }
    this.timer ??= setTimeout(() => this.flushNow(), this.config.flushAfterMs)
  }

  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.batch.length === 0) return
    const items = this.batch
    this.batch = []
    this.flush(items)
  }

  get size(): number {
    return this.batch.length
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.batch = []
  }
}
