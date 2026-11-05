/**
 * Classifieur de sujets à écarter — SPEC §2.2, FEEDBACK MH-02.
 *
 * Deux couches, et la distinction est structurelle :
 *
 *  - `UNIVERSAL_BLOCKED` : santé, deuil, politique, crise, contenu financier. Non
 *    désactivable, non adressable depuis un Niche Pack. C'est une constante du module,
 *    pas une entrée de configuration.
 *  - couche pack : `additionalBlockedTopics`, purement additive.
 *
 * Pourquoi le contenu financier est dans le noyau alors que la niche pilote est
 * memecoin : les règles de X sur le spam financier sont appliquées plus durement que
 * ses règles d'automatisation, et « reply guy crypto » est l'un des patterns les plus
 * signalés de la plateforme. Le pack `memecoin` parle culture, mèmes et mécanique
 * on-chain — il ne dit pas « ça va faire ×10 ». Voir FEEDBACK.md § MH-02.
 *
 * Ce classifieur est lexical et volontairement conservateur. Il n'appelle pas de LLM :
 * il tourne sur 200 posts par cycle, doit être gratuit, déterministe et testable. Un
 * classifieur LLM sur les cas limites viendra en Phase 3, *après* celui-ci, jamais à sa
 * place — un garde-fou qui dépend d'un appel réseau et d'un budget n'est pas un
 * garde-fou.
 */
import type { Denial } from './types'

export type SensitiveCategory =
  | 'health'
  | 'grief'
  | 'politics'
  | 'crisis'
  | 'financial-advice'
  | 'legal-accusation'
  | 'adult'

export interface CategoryRule {
  category: SensitiveCategory
  /** Motifs déclencheurs. En minuscules, comparés sur texte normalisé. */
  patterns: readonly RegExp[]
  /** Explication affichée dans le journal et l'onglet Flux. */
  why: string
}

/**
 * Le noyau. Multilingue FR/EN parce que ce sont les langues gérées par défaut ; ajouter
 * une langue à la config sans étendre ce tableau est un trou de sécurité, et c'est
 * vérifié en test.
 */
export const UNIVERSAL_BLOCKED: readonly CategoryRule[] = [
  {
    category: 'health',
    why: 'santé : un conseil mal calibré peut nuire, et nous ne sommes pas légitimes',
    patterns: [
      /\b(cancer|chimio(?:th[eé]rapie)?|tumeur|diagnostic|diagnos(?:ed|is)|chemo)\b/i,
      /\b(d[eé]pression|suicide|suicidaire|self[- ]harm|automutilation)\b/i,
      /\b(h[oô]pital|hospitalis[eé]|urgences|icu|hospice)\b/i,
      /\b(maladie chronique|handicap|invalidit[eé]|terminal illness)\b/i,
      /\b(traitement|posologie|m[eé]dicament|prescription|symptom(?:e|es|s)?)\b/i,
      /\b(mental health|troubles? anxieux|burn[- ]?out)\b/i,
    ],
  },
  {
    category: 'grief',
    why: 'deuil : aucune réponse automatisée n’est appropriée',
    patterns: [
      /\b(d[eé]c[eè]s|d[eé]c[eé]d[eé]|est mort|est d[eé]c[eé]d[eé]e?|enterrement|fun[eé]railles)\b/i,
      /\b(passed away|rest in peace|\brip\b|condol[eé]ances|condolences|obituary|memorial)\b/i,
      /\b(perd(?:u|re|s) (?:mon|ma|notre) (?:p[eè]re|m[eè]re|fr[eè]re|s[oœ]ur|fils|fille|ami|femme|mari|chien|chat))\b/i,
      /\b(lost (?:my|our) (?:father|mother|dad|mom|brother|sister|son|daughter|wife|husband|friend|dog|cat))\b/i,
    ],
  },
  {
    category: 'politics',
    why: 'politique : polarisant, sans rapport avec la niche, risque réputationnel élevé',
    patterns: [
      /\b([eé]lection|[eé]lectoral|scrutin|pr[eé]sidentielle|l[eé]gislatives|referendum)\b/i,
      /\b(election|ballot|voter|primaries|impeach(?:ment)?|senate|congress|parliament)\b/i,
      /\b(immigration|migrants?|avortement|abortion|gun control|second amendment)\b/i,
      /\b(gauche|droite|extr[eê]me[- ]droite|extr[eê]me[- ]gauche|far[- ]right|far[- ]left)\b/i,
      /\b(sionis(?:te|me)|antis[eé]mit|islamophob|g[eé]nocide|genocide|apartheid)\b/i,
    ],
  },
  {
    category: 'crisis',
    why: 'crise en cours : le contexte évolue plus vite que notre information',
    patterns: [
      /\b(attentat|fusillade|shooting|attack|explosion|bombing|terroris)\b/i,
      /\b(s[eé]isme|tremblement de terre|earthquake|tsunami|ouragan|hurricane|inondations?|floods?|wildfire|incendie)\b/i,
      /\b(guerre|war|invasion|frappes?|airstrike|ceasefire|cessez[- ]le[- ]feu)\b/i,
      /\b(crash a[eé]rien|plane crash|derailment|d[eé]raillement|hostages?|otages?)\b/i,
      /\b(breaking|urgent|alerte)\b.{0,40}\b(morts?|dead|killed|victimes?|casualt)/i,
    ],
  },
  {
    category: 'financial-advice',
    why: 'conseil financier ou signal de prix : interdit par conception (MH-02)',
    patterns: [
      /\b(\d{2,4}\s?x|100x|1000x)\b/i,
      // « moon » n'est bloqué qu'en contexte de signal de prix : bloquer le mot seul
      // écarterait des conversations légitimes dans d'autres niches.
      /\b(?:to the moon|moonshot|(?:gonna|going to|will|about to)\s+moon|moon\s+(?:soon|incoming|when|any\s?day)|lfg\s+\d)\b/i,
      /\b(price target|pt\s?\$?\d|price prediction|pr[eé]diction de prix|objectif de (?:cours|prix))\b/i,
      /\b(financial advice|conseil (?:financier|en investissement)|investment advice)\b/i,
      /\b(guaranteed (?:returns?|profits?|gains?)|rendement garanti|profit garanti)\b/i,
      /\b(buy now|achetez maintenant|last chance to buy|derni[eè]re chance)\b/i,
      /\b(ape in|full port|all[- ]in on|yolo(?:ing)? into)\b/i,
      /\b(presale|pr[eé]vente|whitelist spot|referral (?:code|link))\b/i,
    ],
  },
  {
    category: 'legal-accusation',
    why: 'accusation non établie : risque juridique et réputationnel',
    patterns: [
      /\b(escroc|arnaqueur|fraudeur|scammer|fraudster|criminal|p[eé]dophile|predator)\b/i,
      /\b(is a scam|est une arnaque|proven scam|rug(?:ged|ging|pull(?:ed)?)\s+(?:by|par)\s+@?\w+)\b/i,
      /\b(sued?|lawsuit|poursuite judiciaire|indicted|mis en examen|arrested|arr[eê]t[eé])\b/i,
    ],
  },
  {
    category: 'adult',
    why: 'contenu adulte : hors périmètre',
    patterns: [/\b(onlyfans|nsfw|porn|escort|nudes?)\b/i],
  },
]

export interface TopicVerdict {
  blocked: boolean
  categories: readonly SensitiveCategory[]
  reasons: readonly string[]
  /** Motifs de pack déclenchés, distingués du noyau pour le diagnostic. */
  packTopics: readonly string[]
}

/**
 * Normalise pour la comparaison : retire les diacritiques et l'emphase unicode.
 * Sans ça, « décès » écrit « dècès » ou « 𝗱écès » passerait — et le contournement par
 * caractères décoratifs est courant sur X.
 */
export function normalizeForMatching(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Décide si un sujet de pack est déclenché.
 *
 * Un sujet de pack est une expression descriptive, pas un mot-clé : « doxxing ou
 * identification d'un développeur anonyme ». Deux heuristiques naïves échouent ici :
 * chercher la chaîne exacte ne matche jamais, et exiger *tous* les mots significatifs
 * rate le cas où l'auteur formule autrement (« doxxer le dev »).
 *
 * On exige donc au moins la moitié des mots significatifs. C'est le compromis qui a
 * survécu au test : assez souple pour reconnaître une reformulation, assez strict pour
 * ne pas déclencher sur un seul mot fréquent.
 */
function packTopicHits(normalized: string, topics: readonly string[]): string[] {
  const lower = normalized.toLowerCase()
  return topics.filter((topic) => {
    const t = normalizeForMatching(topic).toLowerCase()
    if (t.length < 3) return false
    // Découpage sur les non-lettres, pas sur les espaces : sinon « d'un » compte comme
    // un mot significatif, gonfle le denominateur et fait rater le seuil de moitié.
    const words = t.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3)
    if (words.length === 0) return lower.includes(t)
    const matched = words.filter((w) =>
      new RegExp(`\\b${escapeRe(w)}`, 'i').test(lower),
    ).length
    return matched >= Math.max(1, Math.ceil(words.length / 2))
  })
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function classifyTopic(
  text: string,
  packBlockedTopics: readonly string[] = [],
): TopicVerdict {
  const normalized = normalizeForMatching(text)
  const categories: SensitiveCategory[] = []
  const reasons: string[] = []

  for (const rule of UNIVERSAL_BLOCKED) {
    if (rule.patterns.some((p) => p.test(normalized))) {
      categories.push(rule.category)
      reasons.push(rule.why)
    }
  }

  const packTopics = packTopicHits(normalized, packBlockedTopics)
  if (packTopics.length > 0) {
    reasons.push(`sujet écarté par le pack : ${packTopics.join(', ')}`)
  }

  return {
    blocked: categories.length > 0 || packTopics.length > 0,
    categories,
    reasons,
    packTopics,
  }
}

/** Forme `Denial`, pour brancher directement dans `requestPermit()`. */
export function topicDenial(
  text: string,
  packBlockedTopics: readonly string[] = [],
): Denial | null {
  const verdict = classifyTopic(text, packBlockedTopics)
  if (!verdict.blocked) return null
  return { reason: 'blocked-topic', detail: verdict.reasons.join(' · ') }
}
