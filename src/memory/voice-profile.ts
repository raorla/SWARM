/**
 * VOICE PROFILE — extraction du style d'écriture de l'utilisateur.
 *
 * **Aucun appel LLM pour les statistiques.** Elles sont déterministes, gratuites, et
 * doivent rester calculables quand le budget quotidien est épuisé — même raisonnement que
 * pour les embeddings (ADR 0002). Un profil qui dépend d'un appel réseau serait
 * indisponible précisément en fin de journée, au moment où le WRITER en a le plus besoin.
 *
 * ## La séparation forme / registre — FEEDBACK MH-18
 *
 * Le compte pilote est un compte de projet dont la voix native est largement
 * promotionnelle, donc largement interdite par le noyau du topic-guard (D-11). Extraire
 * naïvement « la voix de l'utilisateur » y encoderait le registre promotionnel, le WRITER
 * apprendrait à shiller, et le CRITIC rejetterait 100 % de ses variantes.
 *
 * D'où deux corpus distincts :
 *
 *  - **Forme** (longueur, rythme, ponctuation, retours à la ligne, emojis) : calculée sur le
 *    corpus **entier**. La forme d'un post promotionnel reste la forme de l'utilisateur.
 *  - **Registre** (exemples canoniques, règles `do`) : tiré **uniquement** du corpus qui
 *    passe le garde-fou. C'est ce qui va dans le prompt du WRITER.
 *
 * Sans cette séparation, le Voice Profile serait le canal par lequel le contenu interdit
 * rentre dans le produit — non pas malgré les garde-fous, mais *à travers* eux, sous
 * l'étiquette « c'est le style de l'utilisateur ».
 */
import type { OwnPost, VoiceFormStats, VoiceProfileRecord } from '@/db/schema'
import { classifyTopic, normalizeForMatching } from '@/governor/topic-guard'
import type { NichePack } from '@/niches/pack.schema'
import type { Clock } from '@/shared/time'

/* ────────────────────────────── Segmentation ─────────────────────────────── */

/** Emojis et pictogrammes, y compris les séquences composées. */
const EMOJI_RE = /\p{Extended_Pictographic}(‍\p{Extended_Pictographic})*/gu
const URL_RE = /https?:\/\/\S+|\bt\.co\/\w+/gi
const HASHTAG_RE = /(?:^|\s)#[\p{L}\p{N}_]{2,}/gu
const MENTION_RE = /(?:^|\s)@[A-Za-z0-9_]{1,15}/g
/** Adresse de contrat Solana ou EVM — dans ce corpus, un marqueur de post promotionnel. */
const CONTRACT_RE = /\b(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/g

/**
 * Découpe en phrases sans dépendance externe.
 *
 * Le point n'est pas un séparateur fiable sur X : les URL, les abréviations et les décimales
 * en contiennent. On retire les URL d'abord, puis on coupe sur une ponctuation forte suivie
 * d'un espace ou d'une fin de texte.
 */
export function splitSentences(text: string): string[] {
  return text
    .replace(URL_RE, ' ')
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function splitWords(text: string): string[] {
  return text
    .replace(URL_RE, ' ')
    .replace(CONTRACT_RE, ' ')
    .split(/[^\p{L}\p{N}''-]+/u)
    .filter((w) => w.length > 0)
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length
}

function ratioOf(
  posts: readonly OwnPost[],
  predicate: (text: string) => boolean,
): number {
  if (posts.length === 0) return 0
  return posts.filter((p) => predicate(p.text)).length / posts.length
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p)),
  )
  return sorted[index]!
}

/* ─────────────────────────── Statistiques de forme ───────────────────────── */

/**
 * Détection de langue rudimentaire.
 *
 * Volontairement grossière : on veut savoir si le compte écrit en français, en anglais ou
 * mélange, pas classer 40 langues. Une bibliothèque de détection pèserait plus que le gain,
 * et le champ `lang` du DOM de X est souvent absent ou faux.
 */
export function guessLanguage(text: string): string {
  const normalized = normalizeForMatching(text).toLowerCase()
  const words = splitWords(normalized)
  if (words.length < 3) return 'und'

  const FR = new Set([
    'le',
    'la',
    'les',
    'des',
    'une',
    'est',
    'pas',
    'que',
    'qui',
    'pour',
    'dans',
    'avec',
    'sur',
    'plus',
    'mais',
    'tout',
    'sont',
    'cette',
    'comme',
    'faire',
  ])
  const EN = new Set([
    'the',
    'and',
    'is',
    'to',
    'of',
    'that',
    'it',
    'you',
    'for',
    'with',
    'this',
    'are',
    'not',
    'but',
    'they',
    'have',
    'from',
    'just',
    'like',
    'what',
  ])

  let fr = 0
  let en = 0
  for (const w of words) {
    if (FR.has(w)) fr += 1
    if (EN.has(w)) en += 1
  }
  if (fr === 0 && en === 0) return 'und'
  return fr > en ? 'fr' : 'en'
}

export function computeFormStats(posts: readonly OwnPost[]): VoiceFormStats {
  const empty: VoiceFormStats = {
    sampleSize: 0,
    avgLength: 0,
    medianLength: 0,
    p10Length: 0,
    p90Length: 0,
    avgSentencesPerPost: 0,
    avgWordLength: 0,
    lexicalDiversity: 0,
    emojiRate: 0,
    emojiInventory: [],
    questionRate: 0,
    exclamationRate: 0,
    ellipsisRate: 0,
    emDashRate: 0,
    semicolonRate: 0,
    capitalizedStartRate: 0,
    lowercaseStartRate: 0,
    allCapsWordRate: 0,
    linkRate: 0,
    hashtagRate: 0,
    mentionRate: 0,
    lineBreakRate: 0,
    avgLinesPerPost: 0,
    replyRatio: 0,
    languageMix: {},
  }
  if (posts.length === 0) return empty

  const lengths = posts.map((p) => p.text.length).sort((a, b) => a - b)
  const allWords: string[] = []
  const emojiCounts = new Map<string, number>()
  const langCounts = new Map<string, number>()

  let sentenceTotal = 0
  let lineTotal = 0
  let allCapsWords = 0

  for (const post of posts) {
    const words = splitWords(post.text)
    allWords.push(...words.map((w) => w.toLowerCase()))
    sentenceTotal += splitSentences(post.text).length
    lineTotal += post.text.split('\n').length

    for (const emoji of post.text.match(EMOJI_RE) ?? []) {
      emojiCounts.set(emoji, (emojiCounts.get(emoji) ?? 0) + 1)
    }
    // Un mot en capitales n'est significatif qu'au-delà de deux lettres : « OK », « CA » et
    // les tickers passeraient sinon pour du style emphatique.
    allCapsWords += words.filter(
      (w) => w.length > 2 && w === w.toUpperCase() && /\p{L}/u.test(w),
    ).length

    const lang = guessLanguage(post.text)
    if (lang !== 'und') langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1)
  }

  const langTotal = [...langCounts.values()].reduce((a, b) => a + b, 0)
  const languageMix: Record<string, number> = {}
  for (const [lang, count] of langCounts) languageMix[lang] = count / (langTotal || 1)

  const uniqueWords = new Set(allWords)

  return {
    sampleSize: posts.length,
    avgLength: lengths.reduce((a, b) => a + b, 0) / posts.length,
    medianLength: percentile(lengths, 0.5),
    p10Length: percentile(lengths, 0.1),
    p90Length: percentile(lengths, 0.9),
    avgSentencesPerPost: sentenceTotal / posts.length,
    avgWordLength:
      allWords.length === 0
        ? 0
        : allWords.reduce((a, w) => a + w.length, 0) / allWords.length,
    lexicalDiversity: allWords.length === 0 ? 0 : uniqueWords.size / allWords.length,
    emojiRate: ratioOf(posts, (t) => EMOJI_RE.test(t)),
    emojiInventory: [...emojiCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([e]) => e),
    questionRate: ratioOf(posts, (t) => t.includes('?')),
    exclamationRate: ratioOf(posts, (t) => t.includes('!')),
    ellipsisRate: ratioOf(posts, (t) => t.includes('…') || t.includes('...')),
    emDashRate: ratioOf(posts, (t) => t.includes('—') || t.includes(' - ')),
    semicolonRate: ratioOf(posts, (t) => t.includes(';')),
    capitalizedStartRate: ratioOf(posts, (t) => /^\s*\p{Lu}/u.test(t)),
    lowercaseStartRate: ratioOf(posts, (t) => /^\s*\p{Ll}/u.test(t)),
    allCapsWordRate: allWords.length === 0 ? 0 : allCapsWords / allWords.length,
    linkRate: ratioOf(posts, (t) => URL_RE.test(t)),
    hashtagRate: ratioOf(posts, (t) => countMatches(t, HASHTAG_RE) > 0),
    mentionRate: ratioOf(posts, (t) => countMatches(t, MENTION_RE) > 0),
    lineBreakRate: ratioOf(posts, (t) => t.includes('\n')),
    avgLinesPerPost: lineTotal / posts.length,
    replyRatio: posts.filter((p) => p.isReply).length / posts.length,
    languageMix,
  }
}

/* ──────────────────────── Tics de langage et sujets ──────────────────────── */

/** Mots trop fréquents pour être discriminants. */
const STOPWORDS = new Set([
  'the',
  'and',
  'is',
  'to',
  'of',
  'that',
  'it',
  'you',
  'for',
  'with',
  'this',
  'are',
  'not',
  'but',
  'they',
  'have',
  'from',
  'just',
  'like',
  'what',
  'was',
  'all',
  'can',
  'will',
  'one',
  'le',
  'la',
  'les',
  'des',
  'une',
  'est',
  'pas',
  'que',
  'qui',
  'pour',
  'dans',
  'avec',
  'sur',
  'plus',
  'mais',
  'tout',
  'sont',
  'cette',
  'comme',
  'faire',
  'son',
  'ses',
  'nous',
  'vous',
])

/**
 * Ouvertures de phrase récurrentes.
 *
 * C'est le signal le plus discriminant d'un style et le plus facile à rater : deux personnes
 * peuvent avoir les mêmes statistiques de longueur et de ponctuation, elles n'ouvrent pas
 * leurs phrases pareil.
 *
 * **Plusieurs largeurs de fenêtre, pas une seule.** Un tic d'ouverture fait souvent un seul
 * mot — « honestly », « bref », « hot take » — et une fenêtre fixe de trois mots les rate
 * tous : « honestly the float » et « honestly nobody reads » ne se ressemblent qu'au premier
 * mot. On compte donc les ouvertures de un à trois mots, et on garde la forme la plus longue
 * qui se répète, parce que c'est la plus informative.
 *
 * Les ouvertures d'un seul mot vide sont écartées : « the » ou « le » domineraient sans rien
 * dire du style.
 */
export function extractSignatureOpeners(posts: readonly OwnPost[], limit = 8): string[] {
  const counts = new Map<string, number>()

  for (const post of posts) {
    for (const sentence of splitSentences(post.text)) {
      const words = splitWords(sentence).map((w) => w.toLowerCase())
      if (words.length === 0) continue
      for (const width of [1, 2, 3]) {
        if (words.length < width) break
        const opener = words.slice(0, width).join(' ')
        if (width === 1 && STOPWORDS.has(opener)) continue
        counts.set(opener, (counts.get(opener) ?? 0) + 1)
      }
    }
  }

  // Seuil à 2 : une ouverture vue une seule fois n'est pas un tic, c'est une phrase.
  const recurring = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)

  // Déduplication par préfixe : garder « honestly » ET « honestly the float » serait
  // redondant dans le prompt. On conserve la forme la plus longue de chaque famille.
  const kept: string[] = []
  for (const [opener] of recurring) {
    if (kept.some((k) => k.startsWith(`${opener} `))) continue
    kept.push(opener)
    if (kept.length >= limit) break
  }
  return kept
}

/** N-grammes récurrents — les tics de langage proprement dits. */
export function extractSignaturePhrases(posts: readonly OwnPost[], limit = 10): string[] {
  const counts = new Map<string, number>()
  for (const post of posts) {
    const words = splitWords(post.text).map((w) => w.toLowerCase())
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n)
        // Un n-gramme entièrement composé de mots vides ne dit rien du style.
        if (gram.every((w) => STOPWORDS.has(w))) continue
        counts.set(gram.join(' '), (counts.get(gram.join(' ')) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([gram]) => gram)
}

export function extractRecurringTopics(posts: readonly OwnPost[], limit = 12): string[] {
  const counts = new Map<string, number>()
  for (const post of posts) {
    for (const word of new Set(splitWords(post.text).map((w) => w.toLowerCase()))) {
      if (word.length < 4 || STOPWORDS.has(word)) continue
      counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word)
}

/* ──────────────────────────── Exemples canoniques ────────────────────────── */

/**
 * Sélectionne les exemples canoniques injectés dans le prompt du WRITER.
 *
 * **Pas les plus likés.** Trier par engagement biaiserait le profil vers un seul registre —
 * celui qui a marché une fois — et le WRITER produirait des variantes de ce coup de chance.
 *
 * On prend les posts les plus proches du centre statistique de la forme, **et** on force la
 * diversité de longueur : un profil composé de dix posts de longueur identique
 * n'apprendrait au modèle qu'une seule cadence.
 *
 * Uniquement parmi les posts qui passent le garde-fou (MH-18).
 */
export function selectCanonicalExamples(
  posts: readonly OwnPost[],
  stats: VoiceFormStats,
  limit = 10,
): string[] {
  const eligible = posts.filter((p) => p.passesGuard && p.text.trim().length >= 20)
  if (eligible.length === 0) return []

  const distance = (post: OwnPost): number => {
    const lengthGap =
      Math.abs(post.text.length - stats.medianLength) / Math.max(1, stats.medianLength)
    const sentences = splitSentences(post.text).length
    const sentenceGap =
      Math.abs(sentences - stats.avgSentencesPerPost) /
      Math.max(1, stats.avgSentencesPerPost)
    return lengthGap + sentenceGap
  }

  const ranked = [...eligible].sort((a, b) => distance(a) - distance(b))

  // Diversité de longueur : on répartit les retenus sur trois tranches, court / médian /
  // long, plutôt que de prendre les dix plus centraux.
  const short = ranked.filter(
    (p) => p.text.length < stats.p10Length + (stats.medianLength - stats.p10Length) / 2,
  )
  const long = ranked.filter(
    (p) =>
      p.text.length > stats.medianLength + (stats.p90Length - stats.medianLength) / 2,
  )
  const mid = ranked.filter((p) => !short.includes(p) && !long.includes(p))

  const picked: OwnPost[] = []
  const quotas = [
    [mid, Math.ceil(limit * 0.5)],
    [short, Math.ceil(limit * 0.25)],
    [long, Math.ceil(limit * 0.25)],
  ] as const
  for (const [pool, quota] of quotas) {
    for (const post of pool) {
      if (picked.length >= limit) break
      if (picked.filter((p) => pool.includes(p)).length >= quota) break
      if (!picked.includes(post)) picked.push(post)
    }
  }
  // Compléter avec les plus centraux si les quotas n'ont pas rempli.
  for (const post of ranked) {
    if (picked.length >= limit) break
    if (!picked.includes(post)) picked.push(post)
  }

  return picked.slice(0, limit).map((p) => p.text.trim())
}

/* ──────────────────────────────── Règles ─────────────────────────────────── */

/**
 * Dérive les règles `do` / `don't` des statistiques.
 *
 * Déterministe et non par LLM : ces règles doivent être stables entre deux constructions du
 * profil, sinon le WRITER reçoit des consignes qui bougent sans que rien n'ait changé — et
 * la boucle d'apprentissage attribuerait la variation au prompt.
 *
 * Les seuils sont volontairement francs (20 % / 60 %) : une règle « tu utilises parfois des
 * emojis » n'oriente rien.
 */
export function deriveRules(
  stats: VoiceFormStats,
  pack: NichePack | null,
): { doRules: string[]; dontRules: string[] } {
  const doRules: string[] = []
  const dontRules: string[] = []

  doRules.push(
    `Longueur cible : ${Math.round(stats.p10Length)}–${Math.round(stats.p90Length)} caractères, médiane ${Math.round(stats.medianLength)}.`,
  )
  doRules.push(
    stats.avgSentencesPerPost < 1.6
      ? 'Une seule phrase la plupart du temps. Ne développe pas.'
      : `Environ ${stats.avgSentencesPerPost.toFixed(1)} phrases, courtes.`,
  )

  if (stats.lineBreakRate > 0.5) {
    doRules.push(
      `Utilise des retours à la ligne : ${stats.avgLinesPerPost.toFixed(1)} lignes en moyenne.`,
    )
  } else if (stats.lineBreakRate < 0.15) {
    dontRules.push('Pas de retour à la ligne : un seul bloc.')
  }

  if (stats.emojiRate > 0.5 && stats.emojiInventory.length > 0) {
    doRules.push(
      `Emojis employés, sobrement : ${stats.emojiInventory.slice(0, 5).join(' ')}`,
    )
  } else if (stats.emojiRate < 0.2) {
    dontRules.push('Aucun emoji.')
  }

  if (stats.lowercaseStartRate > 0.6) doRules.push('Commence en minuscule.')
  if (stats.capitalizedStartRate > 0.9)
    doRules.push('Commence toujours par une majuscule.')

  if (stats.questionRate > 0.4) doRules.push('Les questions font partie du registre.')
  if (stats.exclamationRate < 0.15) dontRules.push("Pas de point d'exclamation.")
  if (stats.ellipsisRate > 0.4)
    doRules.push('Les points de suspension font partie du registre.')
  if (stats.emDashRate < 0.15) dontRules.push('Pas de tiret cadratin en incise.')
  if (stats.semicolonRate < 0.05) dontRules.push('Pas de point-virgule.')
  if (stats.hashtagRate < 0.2) dontRules.push('Pas de hashtag.')
  if (stats.allCapsWordRate > 0.04)
    doRules.push('Les capitales servent parfois à appuyer un mot.')

  const dominant = Object.entries(stats.languageMix).sort((a, b) => b[1] - a[1])[0]
  if (dominant && dominant[1] > 0.7) {
    doRules.push(`Écris en ${dominant[0] === 'fr' ? 'français' : 'anglais'}.`)
  } else if (Object.keys(stats.languageMix).length > 1) {
    doRules.push('Réponds dans la langue du post auquel tu réponds.')
  }

  // Le lexique banni du pack devient une règle `don't` explicite : le modèle doit le voir
  // ici aussi, pas seulement dans les garde-fous partagés.
  if (pack && pack.lexicon.banned.length > 0) {
    dontRules.push(`Jamais ces termes : ${pack.lexicon.banned.join(', ')}.`)
  }

  return { doRules, dontRules }
}

/* ──────────────────────────── Assemblage du profil ───────────────────────── */

/** Taille de corpus assaini au-delà de laquelle on considère le profil fiable. */
export const CONFIDENCE_FULL_SAMPLE = 50

/**
 * Confiance dans [0, 1].
 *
 * Calculée sur le corpus **assaini**, pas sur le corpus total : cent posts promotionnels ne
 * donnent aucune matière exploitable sous les garde-fous, et prétendre le contraire ferait
 * croire au produit qu'il sait écrire comme l'utilisateur.
 *
 * Racine carrée plutôt que linéaire : le gain marginal du dixième post est bien supérieur à
 * celui du cinquantième.
 */
export function computeConfidence(passingCount: number): number {
  if (passingCount <= 0) return 0
  return Math.min(1, Math.sqrt(passingCount / CONFIDENCE_FULL_SAMPLE))
}

export interface BuildProfileInput {
  handle: string
  posts: readonly OwnPost[]
  pack: NichePack | null
  clock: Clock
}

export function buildVoiceProfile(input: BuildProfileInput): VoiceProfileRecord {
  const all = input.posts
  const passing = all.filter((p) => p.passesGuard)

  // Forme : corpus entier. La forme d'un post promotionnel reste la forme de l'utilisateur.
  const stats = computeFormStats(all)
  // Registre : corpus assaini uniquement (MH-18).
  const { doRules, dontRules } = deriveRules(stats, input.pack)

  const profile: VoiceProfileRecord = {
    id: 'current',
    builtAtMs: input.clock.now(),
    handle: input.handle.replace(/^@/, ''),
    sampleSize: all.length,
    guardExcludedCount: all.length - passing.length,
    guardExcludedRatio: all.length === 0 ? 0 : (all.length - passing.length) / all.length,
    stats,
    signatureOpeners: extractSignatureOpeners(passing),
    signaturePhrases: extractSignaturePhrases(passing),
    recurringTopics: extractRecurringTopics(passing),
    canonicalExamples: selectCanonicalExamples(passing, stats),
    doRules,
    dontRules,
    confidence: computeConfidence(passing.length),
  }

  return sanitizeProfile(profile, input.pack)
}

/**
 * Dernier filet — FEEDBACK MH-18.
 *
 * Retire des sorties destinées au prompt tout ce que le garde-fou refuserait. `passesGuard`
 * est calculé à l'écriture du corpus ; si les règles ont changé depuis, ou si un n-gramme
 * extrait recompose une formulation interdite, ce filtre le rattrape.
 *
 * C'est une redondance délibérée : le Voice Profile est le chemin le plus naturel pour que
 * du contenu interdit rentre dans le produit sous l'étiquette « c'est le style de
 * l'utilisateur ». Un seul filtre ne suffit pas pour ce chemin-là.
 */
export function sanitizeProfile(
  profile: VoiceProfileRecord,
  pack: NichePack | null,
): VoiceProfileRecord {
  const blockedTopics = pack?.additionalBlockedTopics ?? []
  const bannedLexicon = (pack?.lexicon.banned ?? []).map((t) => t.toLowerCase())

  const isClean = (text: string): boolean => {
    if (classifyTopic(text, blockedTopics).blocked) return false
    const lower = normalizeForMatching(text).toLowerCase()
    return !bannedLexicon.some((banned) => lower.includes(banned))
  }

  return {
    ...profile,
    canonicalExamples: profile.canonicalExamples.filter(isClean),
    signatureOpeners: profile.signatureOpeners.filter(isClean),
    signaturePhrases: profile.signaturePhrases.filter(isClean),
    recurringTopics: profile.recurringTopics.filter(isClean),
    // Les règles `don't` ne sont pas filtrées : elles *citent* les interdits, ce qui est
    // leur fonction. Filtrer « jamais 100x » retirerait la règle qui interdit « 100x ».
    doRules: profile.doRules.filter(isClean),
    dontRules: profile.dontRules,
  }
}

/**
 * Le profil est-il exploitable pour rédiger ?
 *
 * Séparé de `confidence` parce que la réponse est binaire et engage le produit : sous ce
 * seuil, le WRITER ne doit pas prétendre imiter un style, et l'UI doit le dire.
 */
export function isProfileUsable(profile: VoiceProfileRecord): boolean {
  return profile.canonicalExamples.length >= 3 && profile.confidence >= 0.25
}

/** Diagnostic affichable dans l'onglet Config, en langue naturelle. */
export function describeProfile(profile: VoiceProfileRecord): string {
  if (profile.sampleSize === 0) return 'Aucun post collecté.'

  const parts = [
    `${profile.sampleSize} posts collectés`,
    `${profile.canonicalExamples.length} exemples exploitables`,
    `confiance ${(profile.confidence * 100).toFixed(0)} %`,
  ]

  if (profile.guardExcludedRatio > 0.5) {
    parts.push(
      `⚠ ${(profile.guardExcludedRatio * 100).toFixed(0)} % du corpus est écarté par les garde-fous : ` +
        'la voix native de ce compte est largement non reproductible sous les règles du produit',
    )
  }
  if (!isProfileUsable(profile)) {
    parts.push('profil insuffisant pour imiter un style — le CRITIC sera plus sévère')
  }
  return parts.join(' · ')
}
