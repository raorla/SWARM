/**
 * Migrations Dexie versionnées — SPEC §3.
 *
 * Règle : une migration livrée ne se modifie **jamais**. Un utilisateur dont la base est
 * en v1 doit pouvoir atteindre la vN par le même chemin que tout le monde. Modifier une
 * migration passée produit des bases divergentes selon le moment de l'installation — le
 * genre de bug qu'on ne reproduit pas.
 *
 * Ajouter une version = ajouter une entrée ici, sans toucher aux précédentes.
 */
import type Dexie from 'dexie'

export interface Migration {
  version: number
  /** Description des index, au format Dexie. */
  stores: Record<string, string | null>
  /** Transformation des données existantes, si nécessaire. */
  upgrade?: (
    tx: Parameters<Parameters<Dexie['version']>[0] extends never ? never : never>[0],
  ) => Promise<void> | void
}

/**
 * v1 — schéma initial.
 *
 * Choix d'indexation notables :
 *  - `&idempotencyKey` sur `actions` : l'unicité est contrainte par la base, pas par une
 *    vérification applicative qui pourrait courir avec elle-même après un réveil de
 *    service worker (MH-07).
 *  - `[refType+refId]` composite sur `embeddings` : on cherche toujours par paire.
 *  - `[dimension+value]` sur `patterns` : idem, c'est la clé naturelle.
 *  - `auditLog.seq` unique : une lacune ou un doublon de séquence est en soi un signe de
 *    falsification, et l'index le rend impossible à créer par erreur.
 */
const MIGRATIONS_MUTABLE: Migration[] = [
  {
    version: 1,
    stores: {
      opportunities:
        '++id, &postId, authorHandle, status, evScore, createdAtMs, [status+evScore], nichePackId',
      drafts: '++id, opportunityId, criticPassed, createdAtMs',
      actions:
        '++id, &idempotencyKey, type, opportunityId, outcome, stagedAtMs, publishedAtMs, promptVersionHash',
      outcomes: '++id, actionId, dayOffset, checkedAtMs, [actionId+dayOffset]',
      relationships: '&handle, lastInteractionMs, warmth, interactionCount',
      voiceProfile: '&id, builtAtMs',
      patterns: '++id, dimension, [dimension+value], updatedAtMs, confidence',
      embeddings: '++id, refType, refId, [refType+refId], createdAtMs',
      config: '&id',
      promptVersions: '&hash, role, createdAtMs',
      nichePacks: '&id, installedAtMs',
      auditLog: '++id, &seq, atMs, type, actor',
    },
  },
]

export const MIGRATIONS: readonly Migration[] = MIGRATIONS_MUTABLE

/**
 * v2 — corpus des posts de l'utilisateur (Phase 2).
 *
 * `ownPosts` est une table à part et non un drapeau sur `opportunities` : ces posts ne sont
 * pas des opportunités, on ne leur répond pas. Les mélanger obligerait chaque requête de
 * triage à filtrer, et un seul oubli ferait proposer à l'utilisateur de se répondre.
 *
 * `passesGuard` est indexé parce que c'est le filtre le plus fréquent de la Phase 2 : les
 * exemples canoniques ne se tirent que des posts qui passent (MH-18).
 */
MIGRATIONS_MUTABLE.push({
  version: 2,
  stores: {
    ownPosts: '++id, &postId, postedAtMs, passesGuard, collectedAtMs',
  },
})

export const CURRENT_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version
