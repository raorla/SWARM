/**
 * RNG seedable — FEEDBACK MH-17.
 *
 * Deux usages qui exigent tous deux la reproductibilité : la cadence log-normale du
 * governor (à tester), et le backtest de la Phase 7 (deux runs de la même config
 * doivent donner exactement le même résultat, sinon comparer deux configs n'a pas de
 * sens). Un lint interdit `Math.random()` ailleurs dans `src/`.
 */

export interface Rng {
  /** Uniforme dans [0, 1). */
  next(): number
}

/** RNG cryptographique — pour tout ce qui ne doit PAS être reproductible (sel, IV, id). */
export const cryptoRng: Rng = {
  next: () => {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    // 2^32 : garantit [0, 1) strict.
    return buf[0]! / 4_294_967_296
  },
}

/**
 * xoshiro128** — rapide, bonne qualité statistique, état de 128 bits.
 * Retenu plutôt qu'un LCG parce que les LCG ont des corrélations de bits bas visibles
 * quand on tire beaucoup de délais successifs.
 */
export class SeededRng implements Rng {
  private s: [number, number, number, number]

  constructor(seed = 0x9e3779b9) {
    // splitmix32 pour disperser une graine scalaire sur 128 bits d'état.
    let z = seed >>> 0
    const mix = (): number => {
      z = (z + 0x9e3779b9) >>> 0
      let t = z
      t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0
      t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0
      return (t ^ (t >>> 15)) >>> 0
    }
    this.s = [mix(), mix(), mix(), mix()]
    // Un état tout à zéro est un point fixe : xoshiro n'en sort jamais.
    if (this.s.every((x) => x === 0)) this.s[0] = 1
  }

  private static rotl(x: number, k: number): number {
    return ((x << k) | (x >>> (32 - k))) >>> 0
  }

  next(): number {
    const s = this.s
    const result = Math.imul(SeededRng.rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0

    const t = (s[1] << 9) >>> 0
    s[2] = (s[2] ^ s[0]) >>> 0
    s[3] = (s[3] ^ s[1]) >>> 0
    s[1] = (s[1] ^ s[2]) >>> 0
    s[0] = (s[0] ^ s[3]) >>> 0
    s[2] = (s[2] ^ t) >>> 0
    s[3] = SeededRng.rotl(s[3], 11)

    // 2^32 : garantit un résultat dans [0, 1).
    return result / 4_294_967_296
  }
}

/** Normale centrée réduite, par transformée de Box-Muller. */
export function gaussian(rng: Rng): number {
  // Exclut 0 pour éviter log(0) = -Infinity.
  let u = 0
  while (u === 0) u = rng.next()
  const v = rng.next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * Tirage log-normal borné, calibré depuis un intervalle observable.
 *
 * On veut une distribution de délais « humaine » : beaucoup de valeurs vers le bas de
 * l'intervalle, une queue longue vers le haut, jamais deux délais identiques. On
 * calibre mu/sigma pour que [minMs, maxMs] couvre environ ±2 écarts-types, puis on
 * borne dur — parce qu'un tirage log-normal non borné produit occasionnellement des
 * valeurs absurdes, et un délai de 4 heures entre deux brouillons n'est pas « humain »,
 * c'est un bug qui ressemble à une fonctionnalité.
 */
export function logNormalDelay(rng: Rng, minMs: number, maxMs: number): number {
  if (!(maxMs > minMs)) return Math.max(0, minMs)
  const lnMin = Math.log(minMs)
  const lnMax = Math.log(maxMs)
  const mu = (lnMin + lnMax) / 2
  const sigma = (lnMax - lnMin) / 4
  const draw = Math.exp(mu + sigma * gaussian(rng))
  // Arrondi à la milliseconde. Un délai de 1779,965 ms n'a aucun sens — `setTimeout` le
  // tronque de toute façon — et une durée fractionnaire propage des horodatages non entiers
  // dans tout le système. Les schémas Zod attendent des `int` (`observedAtMs`,
  // `postedAtMs`), et un vrai `Date.now()` est toujours entier : produire autre chose
  // ferait échouer la validation loin de la cause.
  return Math.round(Math.min(maxMs, Math.max(minMs, draw)))
}

/** Entier uniforme dans [min, max] inclus. */
export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng.next() * (max - min + 1))
}

/** `true` avec la probabilité `p`. */
export function chance(rng: Rng, p: number): boolean {
  return rng.next() < p
}
