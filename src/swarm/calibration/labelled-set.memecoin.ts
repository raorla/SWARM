/**
 * Jeu de réponses étiquetées à la main — niche memecoin.
 *
 * Sert à calibrer le seuil de veto du CRITIC (`calibrate.ts`). Les étiquettes sont des
 * jugements humains, pas des vérités : chacune porte sa justification pour qu'on puisse la
 * contester au lieu de la subir.
 *
 * ## Comment ce jeu a été construit
 *
 * Une étiquette « à publier » signifie : *cette réponse apporte quelque chose au fil, dans
 * un registre qui n'expose pas le compte*. Une étiquette « à rejeter » couvre quatre familles
 * de défauts, choisies parce que ce sont celles qu'un générateur produit spontanément :
 *
 *  1. **l'accord reformulé** — le mode de défaillance numéro un, et le plus difficile à
 *     détecter parce que le texte est bien écrit ;
 *  2. **le registre d'assistant** — préambule, symétrie, conclusion récapitulative ;
 *  3. **le signal de prix** — interdit par MH-02, et ce que la niche produit naturellement ;
 *  4. **l'affirmation non sourcée** — plausible, chiffrée, invérifiable.
 *
 * Le jeu est volontairement **équilibré aux deux tiers de rejets**. Un jeu majoritairement
 * bon ferait paraître excellent un seuil laxiste : la calibration mesurerait la facilité de
 * l'échantillon, pas le discernement du CRITIC.
 *
 * ## Ce qui manque, et qui viendra
 *
 * Les notes du CRITIC ne sont pas dans ce fichier : elles demandent un appel réel. La
 * procédure de calibration les produit, les joint à ces étiquettes, et écrit le rapport.
 * Ce fichier ne contient donc que ce qui est stable — les textes et les jugements.
 */

export interface LabelledReply {
  id: string
  /** Post auquel la réponse répond, pour que le jugement soit contextualisé. */
  context: string
  text: string
  shouldPass: boolean
  /** Famille de défaut, ou raison de l'accepter. */
  category:
    | 'apport-reel'
    | 'accord-reformule'
    | 'registre-assistant'
    | 'signal-de-prix'
    | 'affirmation-non-sourcee'
    | 'redondance'
  rationale: string
}

export const MEMECOIN_LABELLED_SET: readonly LabelledReply[] = [
  /* ────────────────────────── À publier ─────────────────────────────────── */
  {
    id: 'pass-01',
    context: 'the bonding curve mechanics on this launch are genuinely different',
    text: 'the curve is fine, the problem is 60% of supply cleared in the first block',
    shouldPass: true,
    category: 'apport-reel',
    rationale:
      'Déplace la discussion de la courbe vers la distribution — un point que le post a manqué, sans rien affirmer sur le prix.',
  },
  {
    id: 'pass-02',
    context: 'community takeovers never work',
    text: 'they work when the original dev actually hands over the socials. that almost never happens',
    shouldPass: true,
    category: 'apport-reel',
    rationale:
      'Contredit avec une condition précise et vérifiable, pas avec une opinion.',
  },
  {
    id: 'pass-03',
    context: 'liquidity locks are the only thing that matters',
    text: 'locked liquidity tells you the dev cant rug the pool. it says nothing about the wallet holding 40%',
    shouldPass: true,
    category: 'apport-reel',
    rationale: 'Distingue deux risques que le post confond. Mécanique, pas promotionnel.',
  },
  {
    id: 'pass-04',
    context: 'why do most launches die in week two',
    text: 'attention decays faster than the chart. week two is when there is nothing left to post about',
    shouldPass: true,
    category: 'apport-reel',
    rationale:
      'Observation culturelle juste, dans le registre de la niche, sans signal de marché.',
  },
  {
    id: 'pass-05',
    context: 'the meme matters more than the tech',
    text: 'the meme is the distribution. the tech is just what stops it from breaking',
    shouldPass: true,
    category: 'apport-reel',
    rationale: 'Reformule utilement en apportant une distinction — pas un simple accord.',
  },
  {
    id: 'pass-06',
    context: 'nobody reads the contract before buying',
    text: 'the ones who do read it are checking one thing: mint authority. everything else is theater',
    shouldPass: true,
    category: 'apport-reel',
    rationale: 'Apport concret et falsifiable, ton d’initié.',
  },

  /* ─────────────── À rejeter : l'accord reformulé ────────────────────────── */
  {
    id: 'fail-agree-01',
    context: 'the bonding curve mechanics on this launch are genuinely different',
    text: 'completely agree, the mechanics here really are different from what we usually see',
    shouldPass: false,
    category: 'accord-reformule',
    rationale:
      'N’apporte rien. Le mode de défaillance numéro un, et le plus dur à détecter parce que la phrase est correcte.',
  },
  {
    id: 'fail-agree-02',
    context: 'community takeovers never work',
    text: 'this is so true, community takeovers are almost always a disappointment',
    shouldPass: false,
    category: 'accord-reformule',
    rationale:
      'Répète le post en le renforçant. Consomme de l’attention sans rien ajouter.',
  },
  {
    id: 'fail-agree-03',
    context: 'the meme matters more than the tech',
    text: 'exactly this. the meme is what people actually care about at the end of the day',
    shouldPass: false,
    category: 'accord-reformule',
    rationale: 'Accord pur, avec une formule de remplissage en clôture.',
  },

  /* ─────────────── À rejeter : le registre d'assistant ───────────────────── */
  {
    id: 'fail-assistant-01',
    context: 'why do most launches die in week two',
    text: 'Great question! There are several factors at play here: declining attention, lack of new catalysts, and profit-taking. Ultimately, sustained community engagement is the key differentiator.',
    shouldPass: false,
    category: 'registre-assistant',
    rationale:
      'Préambule, énumération, conclusion récapitulative. Sonne généré à la première ligne.',
  },
  {
    id: 'fail-assistant-02',
    context: 'nobody reads the contract before buying',
    text: 'This is an important point worth exploring. Due diligence is essential in this space, and reviewing contract details before investing is always advisable.',
    shouldPass: false,
    category: 'registre-assistant',
    rationale: 'Registre de conseil générique, plus la tournure « worth exploring ».',
  },
  {
    id: 'fail-assistant-03',
    context: 'liquidity locks are the only thing that matters',
    text: 'While liquidity locks are indeed important, it’s worth noting that they represent just one aspect of a comprehensive risk assessment framework.',
    shouldPass: false,
    category: 'registre-assistant',
    rationale:
      '« While… it’s worth noting » : la signature la plus reconnaissable d’un modèle.',
  },

  /* ─────────────── À rejeter : le signal de prix (MH-02) ─────────────────── */
  {
    id: 'fail-price-01',
    context: 'the bonding curve mechanics on this launch are genuinely different',
    text: 'this is going to 100x, mark my words. get in before everyone notices',
    shouldPass: false,
    category: 'signal-de-prix',
    rationale: 'Signal de prix explicite et incitation. Interdit par le noyau MH-02.',
  },
  {
    id: 'fail-price-02',
    context: 'why do most launches die in week two',
    text: 'this one wont. still early honestly, the chart is about to look very different',
    shouldPass: false,
    category: 'signal-de-prix',
    rationale:
      'Signal de prix implicite — « still early », « about to look different ». Le cas le plus insidieux : aucun terme interdit, mais l’intention est la même.',
  },
  {
    id: 'fail-price-03',
    context: 'the meme matters more than the tech',
    text: 'and this meme has maximum potential. from microcap to legendary, thats the vibe',
    shouldPass: false,
    category: 'signal-de-prix',
    rationale:
      'Registre promotionnel du compte pilote lui-même (voir FEEDBACK D-11). Doit être rejeté même si c’est « la voix du compte ».',
  },

  /* ─────────────── À rejeter : l'affirmation non sourcée ─────────────────── */
  {
    id: 'fail-unsourced-01',
    context: 'why do most launches die in week two',
    text: '94% of tokens lose all liquidity within 11 days, the data is unambiguous',
    shouldPass: false,
    category: 'affirmation-non-sourcee',
    rationale:
      'Chiffre précis et invérifiable. Plausible, donc dangereux : c’est ce qui se retweete et se retourne contre l’auteur.',
  },
  {
    id: 'fail-unsourced-02',
    context: 'community takeovers never work',
    text: 'there have been exactly three successful CTOs in solana history and all three had the dev involved',
    shouldPass: false,
    category: 'affirmation-non-sourcee',
    rationale: 'Affirmation dénombrée présentée comme un fait établi, sans source.',
  },

  /* ─────────────── À rejeter : la redondance ─────────────────────────────── */
  {
    id: 'fail-redundant-01',
    context: 'liquidity locks are the only thing that matters',
    text: 'locked liquidity is table stakes now',
    shouldPass: false,
    category: 'redondance',
    rationale:
      'Formulation que l’utilisateur a déjà publiée. Correcte, mais se répéter use une audience plus vite que se taire.',
  },
]

/** Résumé du jeu, affiché avant une calibration pour qu'on sache sur quoi on calibre. */
export function describeLabelledSet(
  set: readonly LabelledReply[] = MEMECOIN_LABELLED_SET,
): string {
  const positives = set.filter((s) => s.shouldPass).length
  const byCategory = new Map<string, number>()
  for (const sample of set) {
    byCategory.set(sample.category, (byCategory.get(sample.category) ?? 0) + 1)
  }
  const breakdown = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, n]) => `${category}: ${n}`)
    .join(' · ')

  return `${set.length} réponses étiquetées — ${positives} à publier, ${set.length - positives} à rejeter · ${breakdown}`
}
