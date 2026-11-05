/**
 * SATURATION d'une conversation.
 *
 * Le facteur renvoyé est **déjà inversé** : 1 = conversation vierge, 0 = saturée. La spec
 * écrit `1 / saturation`, ce qui diverge quand le nombre de réponses tend vers zéro — un post
 * sans réponse aurait un facteur infini. On calcule donc directement l'inverse borné.
 *
 * ## Ce que la saturation mesure réellement
 *
 * Pas le nombre de réponses, mais **la probabilité que la nôtre soit lue**. Deux corrections
 * par rapport à un simple comptage :
 *
 *  - **Échelle logarithmique.** Passer de 2 à 20 réponses change tout ; de 200 à 220, rien.
 *  - **Rapport au nombre de likes.** Un post à 50 réponses et 5 000 likes a une audience de
 *    lecteurs bien plus large qu'un post à 50 réponses et 60 likes : dans le premier cas,
 *    il reste du monde à atteindre.
 */

export interface SaturationInput {
  replyCount: number | null
  likeCount: number | null
}

export function computeSaturation(input: SaturationInput, maxReplyCount: number): number {
  const replies = input.replyCount

  // Nombre de réponses inconnu : on ne devine pas. Valeur neutre plutôt qu'optimiste — le
  // QUALIFIER pourra trancher, et supposer « peu de réponses » ferait remonter des posts
  // saturés dont on n'a simplement pas pu lire le compteur.
  if (replies === null) return 0.5

  const cap = Math.max(1, maxReplyCount)
  if (replies >= cap) return 0

  // Décroissance logarithmique : log(1+n)/log(1+cap) donne 0 à zéro réponse et 1 au seuil.
  const filled = Math.log1p(replies) / Math.log1p(cap)
  let inverse = 1 - filled

  // Bonus d'audience : beaucoup de likes pour peu de réponses signifie un lectorat large et
  // peu de concurrence. Plafonné à +0,2 pour rester un ajustement, pas un facteur.
  const likes = input.likeCount
  if (likes !== null && replies > 0) {
    const ratio = likes / replies
    // 100 likes par réponse est un post très lu et peu commenté : c'est là que la place
    // vaut le plus.
    const bonus = Math.min(0.2, Math.log10(1 + ratio) / 10)
    inverse += bonus
  }

  return Math.min(1, Math.max(0, inverse))
}

/** Vrai si la conversation dépasse le seuil du pack — l'opportunité est écartée. */
export function isSaturated(input: SaturationInput, maxReplyCount: number): boolean {
  return input.replyCount !== null && input.replyCount >= Math.max(1, maxReplyCount)
}
