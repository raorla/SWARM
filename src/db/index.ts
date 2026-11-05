/**
 * Base Dexie de SWARM.
 *
 * Aucun code hors de `src/db/` ne doit toucher à `db.<table>` directement : tout passe
 * par les repositories. Ce n'est pas du purisme — c'est ce qui permet d'ajouter la purge
 * de rétention (MH-13) et l'export chiffré (MH-06) sans auditer tout le code appelant.
 */
import Dexie, { type EntityTable } from 'dexie'
import { MIGRATIONS } from './migrations'
import type {
  Action,
  AuditRecord,
  ConfigRecord,
  Draft,
  Embedding,
  NichePackRecord,
  Opportunity,
  Outcome,
  OwnPost,
  Pattern,
  PromptVersion,
  Relationship,
  VoiceProfileRecord,
} from './schema'

export class SwarmDb extends Dexie {
  opportunities!: EntityTable<Opportunity, 'id'>
  drafts!: EntityTable<Draft, 'id'>
  actions!: EntityTable<Action, 'id'>
  outcomes!: EntityTable<Outcome, 'id'>
  relationships!: EntityTable<Relationship, 'handle'>
  voiceProfile!: EntityTable<VoiceProfileRecord, 'id'>
  ownPosts!: EntityTable<OwnPost, 'id'>
  patterns!: EntityTable<Pattern, 'id'>
  embeddings!: EntityTable<Embedding, 'id'>
  config!: EntityTable<ConfigRecord, 'id'>
  promptVersions!: EntityTable<PromptVersion, 'hash'>
  nichePacks!: EntityTable<NichePackRecord, 'id'>
  auditLog!: EntityTable<AuditRecord, 'id'>

  constructor(name = 'swarm') {
    super(name)
    for (const migration of MIGRATIONS) {
      const v = this.version(migration.version).stores(migration.stores)
      if (migration.upgrade) {
        // Le typage Dexie de `upgrade` est plus étroit que notre signature générique ;
        // le cast est confiné ici plutôt que dans chaque migration.
        v.upgrade(migration.upgrade as Parameters<typeof v.upgrade>[0])
      }
    }
  }
}

let instance: SwarmDb | null = null

/** Singleton. Le service worker peut mourir : `open()` est idempotent. */
export function db(): SwarmDb {
  instance ??= new SwarmDb()
  return instance
}

/** Instance nommée, pour les tests — chaque test peut avoir sa base isolée. */
export function createDb(name: string): SwarmDb {
  return new SwarmDb(name)
}

/** Réinitialise le singleton. Tests uniquement. */
export function resetDbInstance(): void {
  instance = null
}

export * from './schema'
export { MIGRATIONS, CURRENT_VERSION } from './migrations'
