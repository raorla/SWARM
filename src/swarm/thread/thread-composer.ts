/**
 * COMPOSEUR DE THREADS — Phase 8.
 *
 * Un thread n'est pas une réponse longue découpée. C'est une forme avec ses propres règles, et
 * la principale est que **le premier post décide de tout** : s'il ne retient pas, les suivants
 * ne sont jamais lus. D'où l'A/B de hooks demandé par la spec.
 *
 * ## Ce que ce module fait, et ce qu'il ne fait pas
 *
 * Il **structure** et **valide** : découpage aux frontières de sens, numérotation, limite de
 * caractères par post, cohérence du fil. Il ne rédige pas — c'est le WRITER — et il ne publie
 * pas : comme tout le reste du produit, il met en scène et s'arrête (SPEC §4.6).
 */

/** Limite d'un post X. */
export const POST_CHAR_LIMIT = 280

/** Réserve pour la numérotation « 3/7 » ajoutée en fin de post. */
const NUMBERING_RESERVE = 6

/** Au-delà, un thread se lit comme un article mal placé. */
export const MAX_THREAD_POSTS = 12

export interface ThreadPost {
  index: number
  text: string
  charCount: number
  /** Vrai si le post dépasse la limite — signalé, jamais tronqué en silence. */
  overLimit: boolean
}

export interface Thread {
  posts: ThreadPost[]
  /** Numérotation ajoutée, ou `null` si le thread tient en un post. */
  numbering: 'suffix' | null
  totalChars: number
}

export type SplitFailure =
  | { kind: 'empty'; detail: string }
  | { kind: 'too-long'; detail: string; wouldNeed: number }
  | { kind: 'unsplittable'; detail: string; offendingLength: number }

/**
 * Découpe un texte en thread.
 *
 * **Aux frontières de sens, jamais au caractère.** Couper au milieu d'une phrase produit un
 * thread qu'on ne peut pas lire post par post, ce qui annule l'intérêt du format. On coupe donc
 * aux paragraphes, puis aux phrases, et on refuse plutôt que de couper un mot.
 */
export function splitIntoThread(
  text: string,
  options: { numbered?: boolean; maxPosts?: number } = {},
): { ok: true; thread: Thread } | { ok: false; error: SplitFailure } {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: { kind: 'empty', detail: 'texte vide' } }
  }

  const maxPosts = options.maxPosts ?? MAX_THREAD_POSTS
  const numbered = options.numbered ?? true

  // Un texte qui tient en un post n'est pas un thread : le numéroter serait absurde.
  if (trimmed.length <= POST_CHAR_LIMIT) {
    return {
      ok: true,
      thread: {
        posts: [{ index: 0, text: trimmed, charCount: trimmed.length, overLimit: false }],
        numbering: null,
        totalChars: trimmed.length,
      },
    }
  }

  const budget = numbered ? POST_CHAR_LIMIT - NUMBERING_RESERVE : POST_CHAR_LIMIT
  const units = splitIntoUnits(trimmed)

  // Une unité indivisible plus longue que le budget ne peut pas être placée. On le dit plutôt
  // que de couper un mot en deux.
  const oversized = units.find((unit) => unit.length > budget)
  if (oversized) {
    return {
      ok: false,
      error: {
        kind: 'unsplittable',
        detail: `une phrase de ${oversized.length} caractères ne tient pas dans un post — reformule-la`,
        offendingLength: oversized.length,
      },
    }
  }

  // Remplissage glouton : on accumule tant que ça tient.
  const chunks: string[] = []
  let current = ''
  for (const unit of units) {
    const candidate = current === '' ? unit : `${current}\n\n${unit}`
    if (candidate.length <= budget) {
      current = candidate
    } else {
      if (current !== '') chunks.push(current)
      current = unit
    }
  }
  if (current !== '') chunks.push(current)

  if (chunks.length > maxPosts) {
    return {
      ok: false,
      error: {
        kind: 'too-long',
        detail: `${chunks.length} posts nécessaires, maximum ${maxPosts} — un thread plus long se lit comme un article mal placé`,
        wouldNeed: chunks.length,
      },
    }
  }

  const posts: ThreadPost[] = chunks.map((chunk, index) => {
    const withNumber = numbered ? `${chunk}\n\n${index + 1}/${chunks.length}` : chunk
    return {
      index,
      text: withNumber,
      charCount: withNumber.length,
      overLimit: withNumber.length > POST_CHAR_LIMIT,
    }
  })

  return {
    ok: true,
    thread: {
      posts,
      numbering: numbered ? 'suffix' : null,
      totalChars: posts.reduce((sum, p) => sum + p.charCount, 0),
    },
  }
}

/**
 * Découpe en unités indivisibles : paragraphes d'abord, phrases ensuite.
 *
 * L'ordre compte : un paragraphe est une unité de sens plus forte qu'une phrase, et le casser
 * quand on n'y est pas obligé dégrade la lecture.
 */
function splitIntoUnits(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const units: string[] = []
  for (const paragraph of paragraphs) {
    if (paragraph.length <= POST_CHAR_LIMIT - NUMBERING_RESERVE) {
      units.push(paragraph)
      continue
    }
    // Trop long : on descend au niveau de la phrase.
    const sentences = paragraph
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    units.push(...sentences)
  }
  return units
}

/* ─────────────────────────────── A/B de hooks ────────────────────────────── */

export interface HookVariant {
  text: string
  /** Type de hook, pour que la Phase 5 puisse en mesurer la performance. */
  style: 'question' | 'claim' | 'number' | 'story' | 'contrarian'
}

export interface HookComparison {
  variants: HookVariant[]
  /** Diagnostic par variante — ce qui la rend forte ou faible. */
  notes: { index: number; issues: string[]; strengths: string[] }[]
  /** Variante recommandée, ou `null` si aucune ne se distingue. */
  recommended: number | null
}

/**
 * Évalue des hooks candidats.
 *
 * Analyse **structurelle**, pas sémantique : un modèle jugerait mieux le fond, mais ces
 * critères de forme sont mesurables, déterministes et gratuits — et ils attrapent les défauts
 * les plus fréquents d'un premier post de thread.
 *
 * Ce qui est vérifié : la longueur (un hook long n'accroche pas), l'ouverture (un préambule
 * tue), la présence d'un signal concret (chiffre, affirmation), et l'absence des tics qui
 * signalent un thread générique.
 */
export function compareHooks(variants: readonly HookVariant[]): HookComparison {
  const notes = variants.map((variant, index) => {
    const issues: string[] = []
    const strengths: string[] = []
    const text = variant.text.trim()

    if (text.length > 200) {
      issues.push('trop long pour un hook — on décroche avant la fin')
    } else if (text.length < 40) {
      issues.push('trop court pour donner envie de lire la suite')
    } else {
      strengths.push('longueur adaptée')
    }

    // Les tics qui signalent un thread générique. Un lecteur de X les reconnaît en un coup
    // d'œil et passe.
    if (/^\s*(voici|here('s| is)|let me|dans ce thread|in this thread)/i.test(text)) {
      issues.push('ouverture annonçante — dit qu’il va parler au lieu de parler')
    }
    if (/\u{1F9F5}|thread\s*(?::|\u{1F447})|\bà lire\b/iu.test(text)) {
      issues.push('marqueur de thread explicite — signale du contenu formaté')
    }
    if (/\b\d+\s+(leçons|lessons|choses|things|raisons|reasons)\b/i.test(text)) {
      issues.push('format « N leçons » — épuisé, lu comme du remplissage')
    }

    if (/\d/.test(text)) strengths.push('contient un chiffre concret')
    if (text.includes('?') && variant.style === 'question') {
      strengths.push('question franche')
    }
    if (/^(la plupart|most|tout le monde|everyone|contrairement)/i.test(text)) {
      strengths.push('prend position d’emblée')
    }

    return { index, issues, strengths }
  })

  // Le meilleur est celui qui a le moins de défauts ; à égalité, le plus de forces. Aucune
  // recommandation si tous ont autant de défauts que de forces : fabriquer un gagnant sur un
  // écart nul ferait décider sur du bruit.
  const scored = notes.map((note) => ({
    index: note.index,
    score: note.strengths.length - note.issues.length * 2,
  }))
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a))
  const tied = scored.filter((s) => s.score === best.score).length > 1

  return {
    variants: [...variants],
    notes,
    recommended: tied || best.score <= 0 ? null : best.index,
  }
}

/** Vérifie la cohérence d'un thread avant mise en scène. */
export function validateThread(thread: Thread): { valid: boolean; issues: string[] } {
  const issues: string[] = []

  if (thread.posts.length === 0) issues.push('thread vide')
  if (thread.posts.length > MAX_THREAD_POSTS) {
    issues.push(`${thread.posts.length} posts, maximum ${MAX_THREAD_POSTS}`)
  }

  const over = thread.posts.filter((p) => p.overLimit)
  if (over.length > 0) {
    issues.push(
      `${over.length} post(s) dépassent ${POST_CHAR_LIMIT} caractères : ${over.map((p) => `#${p.index + 1}`).join(', ')}`,
    )
  }

  // Un post vide au milieu casse la lecture et fait échouer la publication.
  const empty = thread.posts.filter((p) => p.text.trim().length === 0)
  if (empty.length > 0) issues.push(`${empty.length} post(s) vide(s)`)

  return { valid: issues.length === 0, issues }
}
