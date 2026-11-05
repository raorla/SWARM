/**
 * Routage modèle par agent — SPEC §3.2, différenciateur n°5.
 *
 * L'architecture à deux vitesses est le seul moyen de tenir 1 €/jour : un modèle bon
 * marché traite 200 posts pour ~0,04 €, un modèle fort rédige les 12 réponses qui
 * comptent. Un modèle unique ferait échouer soit le budget, soit la qualité.
 *
 * Escalade : WRITER passe sur le modèle le plus fort uniquement pour les opportunités du
 * haut du classement EV. Le surcoût est marginal (~0,005 € par opportunité) et il se
 * concentre là où le gain est le plus probable.
 */
import type { AgentRole, Effort, ProviderId } from './types'

export interface RouteConfig {
  providerId: ProviderId
  model: string
  /**
   * Effort de raisonnement, **absent par défaut**.
   *
   * Le champ était obligatoire, ce qui forçait à choisir un niveau même là où le raisonnement
   * est du coût pur — et « low » a l'air du choix économe alors qu'il *active* la réflexion,
   * facturée en sortie au tarif le plus cher. Absent veut dire « pas de raisonnement », ce qui
   * est le bon défaut pour une classification.
   */
  effort?: Effort
  maxOutputTokens: number
}

export interface RoutingTable {
  qualifier: RouteConfig
  strategist: RouteConfig
  writer: RouteConfig
  /** Modèle fort, réservé au haut du classement EV. */
  writerEscalated: RouteConfig
  critic: RouteConfig
  analyst: RouteConfig
  selftest: RouteConfig
  /** Nombre d'opportunités quotidiennes éligibles à l'escalade. */
  escalationTopN: number
}

/**
 * Table par défaut, calibrée sur le chiffrage de SPEC §3.2.
 *
 * `effort` est bas presque partout parce que la sortie pèse plus que l'entrée dans le
 * coût, et que les tokens de réflexion sont facturés en sortie. Le CRITIC est la seule
 * exception : c'est lui qui doit détecter qu'un texte « sonne IA », ce qui demande un
 * jugement, pas une reformulation.
 */
export const DEFAULT_ROUTING: RoutingTable = {
  qualifier: {
    providerId: 'openrouter',
    model: 'anthropic/claude-haiku-4.5',
    /**
     * **Aucun effort de raisonnement, et c'est le point.**
     *
     * `effort: 'low'` semblait vouloir dire « réfléchis peu, donc dépense peu ». Sur les
     * modèles qui supportent le raisonnement étendu, ça veut dire l'inverse : ça l'**active**,
     * et les tokens de réflexion sont facturés en sortie — au tarif le plus cher.
     *
     * Mesuré le 2026-08-26 : avec `effort: 'low'`, les quatre lots de 50 posts étaient tronqués
     * par le plafond de sortie, la réflexion consommant le budget avant que le premier verdict
     * ne soit écrit. Sans effort, le même lot produit sa sortie complète en ~1 700 tokens.
     *
     * Trier un post n'est pas une tâche de raisonnement : c'est une classification, cinquante
     * fois d'affilée, sur un critère décrit dans le prompt. Le raisonnement y est du coût pur.
     */
    /**
     * Mesuré, pas estimé : un lot de 50 posts produit **1 711 tokens** de sortie (mesure du
     * 2026-08-26), soit ~34 par verdict et non 25 comme supposé. Le plafond de 2 000 ne
     * laissait donc que 17 % de marge, et il était dépassé dès que les notes s'allongeaient —
     * quatre lots sur quatre tronqués, rapportés comme « réponse illisible ».
     *
     * Relever le plafond ne coûte rien : on paie les tokens **émis**, pas le plafond. C'est
     * une borne de sécurité, pas un levier de budget — le levier, c'est la longueur de `note`,
     * bornée à 40 caractères par le schéma.
     */
    maxOutputTokens: 3_000,
  },
  strategist: {
    providerId: 'openrouter',
    model: 'anthropic/claude-haiku-4.5',
    effort: 'low',
    maxOutputTokens: 600,
  },
  writer: {
    providerId: 'openrouter',
    model: 'anthropic/claude-sonnet-5',
    effort: 'low',
    // 3 variantes de réponse X (~70 tokens chacune) + structure JSON.
    maxOutputTokens: 900,
  },
  writerEscalated: {
    providerId: 'openrouter',
    model: 'anthropic/claude-opus-5',
    effort: 'low',
    maxOutputTokens: 900,
  },
  critic: {
    providerId: 'openrouter',
    model: 'anthropic/claude-sonnet-5',
    effort: 'medium',
    maxOutputTokens: 800,
  },
  analyst: {
    providerId: 'openrouter',
    model: 'anthropic/claude-haiku-4.5',
    effort: 'low',
    maxOutputTokens: 1_200,
  },
  selftest: {
    providerId: 'openrouter',
    model: 'anthropic/claude-haiku-4.5',
    effort: 'low',
    maxOutputTokens: 200,
  },
  escalationTopN: 10,
}

export interface RouteContext {
  /** Rang de l'opportunité dans le classement EV du jour, à partir de 1. */
  evRank?: number
  /**
   * Vrai si le cache de prompt est confirmé fonctionnel pour ce provider.
   * Tant que FEEDBACK R-03 n'est pas tranché, un routage prudent peut envoyer WRITER et
   * CRITIC vers un provider où le cache est certain.
   */
  promptCacheConfirmed?: boolean
}

export function resolveRoute(
  table: RoutingTable,
  role: AgentRole,
  ctx: RouteContext = {},
): RouteConfig {
  if (role === 'writer') {
    const eligible = ctx.evRank !== undefined && ctx.evRank <= table.escalationTopN
    return eligible ? table.writerEscalated : table.writer
  }
  return table[role]
}

/**
 * Coût maximal théorique d'un appel, pour la vérification de budget *avant* l'appel.
 *
 * On majore volontairement : le budget doit refuser un appel qui pourrait dépasser, pas
 * un appel qui dépassera. Sous-estimer ici transformerait le plafond en suggestion.
 */
export function worstCaseCostEur(
  route: RouteConfig,
  estimatedInputTokens: number,
  pricePerMTok: { inputPerMTok: number; outputPerMTok: number },
  usdToEur: number,
): number {
  const usd =
    (estimatedInputTokens * pricePerMTok.inputPerMTok +
      route.maxOutputTokens * pricePerMTok.outputPerMTok) /
    1_000_000
  return usd * usdToEur
}
