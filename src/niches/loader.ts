/**
 * Chargement, validation et import/export des Niche Packs — FEEDBACK MH-10.
 *
 * Les packs livrés sont importés comme JSON (donc validés au démarrage, pas au build) :
 * un pack livré cassé doit échouer de façon lisible, pas produire un comportement
 * bizarre en aval.
 */
import { NichePackFileSchema, NichePackSchema, type NichePack } from './pack.schema'
import { parseAt, parseJsonAt, type ParseFailure } from '@/shared/zod-helpers'
import { err, ok, type Result } from '@/shared/result'

import memecoinRaw from './packs/memecoin.pack.json' with { type: 'json' }
import saasRaw from './packs/saas-b2b.pack.json' with { type: 'json' }
import genericRaw from './packs/generic.pack.json' with { type: 'json' }

const BUNDLED_RAW: readonly unknown[] = [genericRaw, memecoinRaw, saasRaw]

/** Pack actif par défaut avant l'onboarding : inerte plutôt que bavard. */
export const FALLBACK_PACK_ID = 'generic'

/**
 * Packs livrés avec l'extension, validés.
 * Lance si un pack livré est invalide — c'est une erreur de build, pas une erreur
 * d'exécution, et elle doit se voir en test avant d'atteindre un utilisateur.
 */
export function bundledPacks(): readonly NichePack[] {
  return BUNDLED_RAW.map((raw) => {
    const r = parseAt('nichepack:bundled', NichePackFileSchema, raw)
    if (!r.ok) {
      throw new Error(
        `Pack livré invalide — ${r.error.issues.join(' · ')}. ` +
          'Corrige le JSON : un pack cassé rendrait le QUALIFIER silencieusement faux.',
      )
    }
    return r.value.pack
  })
}

export function bundledPack(id: string): NichePack | undefined {
  return bundledPacks().find((p) => p.id === id)
}

/** Import d'un pack fourni par l'utilisateur (fichier ou coller). */
export function importPack(rawJson: string): Result<NichePack, ParseFailure> {
  const file = parseJsonAt('nichepack:import', NichePackFileSchema, rawJson)
  if (file.ok) return ok(file.value.pack)

  // Tolérance délibérée : accepter aussi un pack nu, sans enveloppe. Un utilisateur qui
  // copie l'objet `pack` depuis un exemple ne doit pas se heurter à un mur de schéma.
  const bare = parseJsonAt('nichepack:import-bare', NichePackSchema, rawJson)
  if (bare.ok) return ok(bare.value)

  return err(file.error)
}

export function exportPack(pack: NichePack): string {
  return JSON.stringify({ formatVersion: 1, pack }, null, 2)
}

/**
 * Fusionne un pack avec des surcharges utilisateur (onglet Config).
 * Les listes additives sont concaténées et dédupliquées ; `additionalBlockedTopics` ne
 * peut que croître, jamais rétrécir — c'est l'invariant de sûreté du format.
 */
export function withUserOverrides(
  pack: NichePack,
  overrides: Partial<
    Pick<
      NichePack,
      | 'keywords'
      | 'negativeKeywords'
      | 'watchlist'
      | 'blocklist'
      | 'additionalBlockedTopics'
      | 'evWeights'
      | 'thresholds'
    >
  >,
): NichePack {
  const uniq = (a: readonly string[], b: readonly string[] = []): string[] => [
    ...new Set([...a, ...b]),
  ]
  return {
    ...pack,
    keywords: uniq(pack.keywords, overrides.keywords),
    negativeKeywords: uniq(pack.negativeKeywords, overrides.negativeKeywords),
    watchlist: uniq(pack.watchlist, overrides.watchlist),
    blocklist: uniq(pack.blocklist, overrides.blocklist),
    additionalBlockedTopics: uniq(
      pack.additionalBlockedTopics,
      overrides.additionalBlockedTopics,
    ),
    evWeights: { ...pack.evWeights, ...overrides.evWeights },
    thresholds: { ...pack.thresholds, ...overrides.thresholds },
  }
}
