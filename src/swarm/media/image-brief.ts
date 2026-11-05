/**
 * MÉDIAS — Phase 8.
 *
 * ## Ce que ce module fait, et surtout ce qu'il ne fait pas
 *
 * Il produit un **brief d'image** : une consigne prête à coller dans l'outil de génération
 * que l'utilisateur possède déjà, plus le texte alternatif qui devra accompagner l'image.
 * Il ne génère aucune image, et il n'attache rien au composeur de X.
 *
 * Trois raisons, dans l'ordre de leur poids réel :
 *
 *  1. **Le budget.** Une image coûte, chez tous les fournisseurs, entre trois et quarante
 *     fois une réponse texte complète. À 1 €/jour (SPEC §2), deux images par jour mangent le
 *     budget du swarm entier — dont la qualification, qui est ce qui produit la valeur. Faire
 *     dépendre les images du même plafond signifierait qu'une journée illustrée est une
 *     journée sans opportunités.
 *  2. **L'attachement au composeur est une automatisation d'un autre ordre.** Publier du
 *     texte se fait en tapant dans un champ, ce que l'utilisateur valide clic par clic
 *     (SPEC §4.6). Injecter un fichier demande de fabriquer un `DataTransfer` et de
 *     déclencher un `drop` sur l'`input[type=file]` de X : c'est un signal d'automatisation
 *     nettement plus net, pour un gain esthétique.
 *  3. **Une image générée engage plus que du texte.** Un graphique inventé, un logo
 *     ressemblant, un visage plausible : les dégâts réputationnels ne se rattrapent pas par
 *     une réponse de suivi. L'humain doit voir l'image avant qu'elle existe publiquement.
 *
 * `ImageProvider` existe donc comme **point d'extension**, sans aucune implémentation
 * embarquée. Si un utilisateur branche son propre fournisseur, il le fait en sachant ce
 * qu'il fait ; le produit livré, lui, ne dépense rien en images.
 */
import type { NichePack } from '@/niches/pack.schema'

/** Limite de X sur le texte alternatif. Au-delà, l'attribut est tronqué côté serveur. */
export const ALT_TEXT_LIMIT = 1_000

/** Ce qu'on demande à l'outil de l'utilisateur. */
export interface ImageBrief {
  /** Consigne à coller telle quelle. */
  prompt: string
  /** Texte alternatif proposé, à relire — il décrit l'image *voulue*, pas l'image obtenue. */
  altText: string
  /** Format conseillé, dicté par le rendu de X et non par l'esthétique. */
  aspectRatio: '16:9' | '1:1'
  /** Avertissements à afficher **à côté** du brief, pas dans le prompt. */
  cautions: string[]
}

export interface ImageBriefInput {
  /** Le brouillon que l'image doit accompagner. */
  draftText: string
  pack: NichePack
  /** Intention de l'utilisateur, si elle est exprimée. */
  userHint?: string
}

/**
 * Registres visuels. Volontairement peu nombreux : trois choix se relisent, douze se
 * subissent, et le pack donne déjà le vocabulaire de la niche.
 */
export type VisualRegister = 'diagram' | 'data' | 'scene'

const REGISTER_RULES: Record<VisualRegister, { style: string; ratio: ImageBrief['aspectRatio'] }> = {
  diagram: {
    style:
      'schéma sobre, deux ou trois éléments au maximum, fond uni, aucun texte décoratif, ' +
      'lisible à la taille d’une vignette de timeline',
    ratio: '16:9',
  },
  data: {
    style:
      'graphique épuré, un seul message, axes nommés, aucune grille superflue, ' +
      'aucun chiffre qui ne soit pas fourni ci-dessous',
    ratio: '16:9',
  },
  scene: {
    style: 'illustration sobre, sans visage identifiable, sans logo, sans marque',
    ratio: '1:1',
  },
}

/**
 * Choisit le registre depuis le brouillon.
 *
 * Heuristique assumée : la présence de chiffres décide. Un brouillon qui avance un chiffre est
 * mieux servi par un graphique, un brouillon qui avance une idée par un schéma. On préfère se
 * tromper vers `diagram`, qui n'invente rien.
 */
export function pickRegister(draftText: string, hint?: string): VisualRegister {
  const hinted = (hint ?? '').toLowerCase()
  if (/graph|courbe|chart|données|data/.test(hinted)) return 'data'
  if (/schéma|schema|diagram/.test(hinted)) return 'diagram'
  if (/photo|illustration|scène|scene/.test(hinted)) return 'scene'

  // Deux chiffres ou plus : il y a une comparaison à montrer.
  const numbers = draftText.match(/\d[\d.,\s]*\s*(?:%|k|m|x|€|\$)?/gi) ?? []
  return numbers.length >= 2 ? 'data' : 'diagram'
}

/**
 * Extrait les chiffres du brouillon pour les **imposer** au générateur.
 *
 * C'est le garde-fou central de ce module : sans cette liste, un modèle d'image produit des
 * axes vraisemblables et faux, et un graphique faux publié depuis un compte de projet est un
 * mensonge, pas une maladresse.
 */
export function extractFactualNumbers(draftText: string): string[] {
  const matches = draftText.match(/\d[\d.,]*\s*(?:%|k\b|m\b|x\b|€|\$|heures?|jours?|mois)?/gi) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of matches) {
    const value = raw.trim()
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Construit le brief.
 *
 * Déterministe et sans appel réseau : mêmes entrées, même sortie. Le brief est de la mise en
 * forme, pas une décision — rien ici ne justifie de dépenser un appel de modèle.
 */
export function buildImageBrief(input: ImageBriefInput): ImageBrief {
  const register = pickRegister(input.draftText, input.userHint)
  const rules = REGISTER_RULES[register]
  const numbers = extractFactualNumbers(input.draftText)

  const lines: string[] = [
    `Image d'accompagnement pour un post X. Registre : ${rules.style}.`,
    '',
    'Message à porter :',
    input.draftText.trim(),
  ]

  if (input.userHint !== undefined && input.userHint.trim().length > 0) {
    lines.push('', `Consigne de l'auteur : ${input.userHint.trim()}`)
  }

  if (numbers.length > 0) {
    lines.push(
      '',
      `Chiffres autorisés, aucun autre : ${numbers.join(', ')}.`,
      "N'ajoute aucune valeur, aucune date, aucun axe chiffré qui ne figure pas dans cette liste.",
    )
  } else if (register === 'data') {
    // Cas contradictoire : registre « données » sans donnée. On le dit plutôt que de laisser
    // le générateur combler le vide.
    lines.push('', 'Aucun chiffre disponible : ne produis aucun graphique chiffré.')
  }

  const banned = input.pack.lexicon.banned
  if (banned.length > 0) {
    lines.push('', `Termes à ne pas écrire dans l'image : ${banned.slice(0, 20).join(', ')}.`)
  }

  lines.push(
    '',
    'Contraintes fermes : aucun visage réel ou reconnaissable, aucun logo, aucune marque, ' +
      'aucune capture d’écran imitée, aucun texte long.',
  )

  return {
    prompt: lines.join('\n'),
    altText: buildAltText(input.draftText, register),
    aspectRatio: rules.ratio,
    cautions: buildCautions(register, numbers.length),
  }
}

/**
 * Texte alternatif.
 *
 * Il est **proposé**, jamais définitif : il décrit l'image demandée, or l'outil rendra autre
 * chose. Le dire dans l'UI évite qu'un alt inexact soit publié par confiance.
 */
export function buildAltText(draftText: string, register: VisualRegister): string {
  const subject = firstSentence(draftText)
  const lead =
    register === 'data'
      ? 'Graphique illustrant'
      : register === 'diagram'
        ? 'Schéma illustrant'
        : 'Illustration accompagnant'
  const alt = `${lead} : ${subject}`
  return alt.length > ALT_TEXT_LIMIT ? `${alt.slice(0, ALT_TEXT_LIMIT - 1)}…` : alt
}

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  const cut = trimmed.search(/[.!?](?:\s|$)/)
  const sentence = cut === -1 ? trimmed : trimmed.slice(0, cut)
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence
}

function buildCautions(register: VisualRegister, numberCount: number): string[] {
  const cautions = [
    'Relis le texte alternatif : il décrit l’image demandée, pas l’image obtenue.',
    'SWARM ne joint aucune image au composeur. L’ajout au post reste manuel.',
  ]
  if (register === 'data' && numberCount > 0) {
    cautions.unshift(
      'Vérifie chaque valeur du graphique contre ta source. Un chiffre inventé publié depuis ' +
        'ton compte est un chiffre que tu as publié.',
    )
  }
  if (register === 'scene') {
    cautions.push('Vérifie l’absence de visage reconnaissable et de logo avant publication.')
  }
  return cautions
}

/* ─────────────────────── Point d'extension, sans implémentation ───────────── */

/**
 * Interface d'un générateur d'images.
 *
 * **Aucune implémentation n'est livrée**, et ce n'est pas un manque : voir l'en-tête de ce
 * fichier. Le type existe pour que brancher un fournisseur soit un ajout local et non une
 * réécriture, et pour que le coût soit déclaré au même endroit que la capacité.
 */
export interface ImageProvider {
  readonly id: string
  readonly label: string
  /** Coût annoncé par image, en euros. Sert au plafond, comme pour le texte. */
  readonly eurPerImage: number
  generate(brief: ImageBrief): Promise<{ blob: Blob; mimeType: string }>
}

/**
 * Registre des fournisseurs d'images : vide, et lu par l'UI.
 *
 * L'onglet Config affiche « aucun fournisseur d'images » depuis cette valeur plutôt que
 * depuis une chaîne codée en dur, pour qu'ajouter un fournisseur suffise à changer l'écran.
 */
export const IMAGE_PROVIDERS: readonly ImageProvider[] = []

/** Vrai garde-fou de la phase : le produit livré ne dépense rien en images. */
export const IMAGE_GENERATION_IMPLEMENTED = IMAGE_PROVIDERS.length > 0
