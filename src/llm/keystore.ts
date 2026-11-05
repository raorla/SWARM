/**
 * Stockage chiffré des clés API — SPEC §3.1.
 *
 * AES-GCM 256, clé dérivée par PBKDF2-SHA256 d'une passphrase utilisateur. Sel et IV
 * aléatoires par écriture.
 *
 * Limite à énoncer sans détour, et répétée dans l'onboarding : ceci protège du vol du
 * fichier de profil. Ça ne protège **pas** d'un attaquant qui contrôle déjà la session
 * navigateur — une clé utilisable par une extension est récupérable par qui a la main sur
 * la machine. La bonne pratique complémentaire est une clé dédiée avec un plafond de
 * dépense côté fournisseur, et c'est ce que l'onboarding recommande.
 */
import type { ProviderCredentials, ProviderId } from './types'
import { err, ok, type Result } from '@/shared/result'
import { systemClock, type Clock } from '@/shared/time'

const STORAGE_KEY = 'swarm:keystore:v1'
const SESSION_KEY = 'swarm:keystore:session:v1'
const PBKDF2_ITERATIONS = 600_000 // coût volontairement élevé : déverrouillage rare.
const SALT_BYTES = 16
const IV_BYTES = 12

export interface EncryptedBlob {
  v: 1
  salt: string // base64
  iv: string // base64
  ct: string // base64
  iterations: number
}

export type KeystoreError =
  | { kind: 'not-initialized' }
  | { kind: 'wrong-passphrase' }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'storage'; detail: string }

const b64 = {
  encode: (buf: ArrayBuffer | Uint8Array): string => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  },
  decode: (s: string): Uint8Array => {
    const raw = atob(s)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out
  },
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Contenu déchiffré : les identifiants de chaque provider configuré. */
export type Vault = Partial<Record<ProviderId, ProviderCredentials>>

export interface KeystoreBackend {
  read(): Promise<EncryptedBlob | null>
  write(blob: EncryptedBlob): Promise<void>
  clear(): Promise<void>
}

export function memoryBackend(): KeystoreBackend {
  let blob: EncryptedBlob | null = null
  return {
    read: async () => blob,
    write: async (b) => {
      blob = b
    },
    clear: async () => {
      blob = null
    },
  }
}

export function chromeBackend(key = STORAGE_KEY): KeystoreBackend {
  return {
    read: async () => {
      const got = await chrome.storage.local.get(key)
      return (got[key] as EncryptedBlob | undefined) ?? null
    },
    write: async (blob) => {
      await chrome.storage.local.set({ [key]: blob })
    },
    clear: async () => {
      await chrome.storage.local.remove(key)
    },
  }
}

export async function encryptVault(
  vault: Vault,
  passphrase: string,
): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS)
  const plaintext = new TextEncoder().encode(JSON.stringify(vault))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    plaintext,
  )
  return {
    v: 1,
    salt: b64.encode(salt),
    iv: b64.encode(iv),
    ct: b64.encode(ct),
    iterations: PBKDF2_ITERATIONS,
  }
}

export async function decryptVault(
  blob: EncryptedBlob,
  passphrase: string,
): Promise<Result<Vault, KeystoreError>> {
  try {
    const salt = b64.decode(blob.salt)
    const iv = b64.decode(blob.iv)
    // On relit `iterations` du blob au lieu d'imposer la constante : sinon relever le
    // coût de dérivation dans une version future rendrait illisibles tous les coffres
    // existants.
    const key = await deriveKey(passphrase, salt, blob.iterations)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      b64.decode(blob.ct) as unknown as BufferSource,
    )
    return ok(JSON.parse(new TextDecoder().decode(plaintext)) as Vault)
  } catch (e) {
    // AES-GCM échoue à l'authentification aussi bien sur mauvaise passphrase que sur
    // données altérées : on ne peut pas les distinguer, et prétendre le contraire
    // enverrait l'utilisateur chercher le mauvais problème.
    const msg = e instanceof Error ? e.message : String(e)
    return err(
      /operation|decrypt/i.test(msg)
        ? { kind: 'wrong-passphrase' }
        : { kind: 'corrupt', detail: msg },
    )
  }
}

/* ──────────────────────── Déverrouillage de session ───────────────────────── */

/**
 * Cache de session du coffre déchiffré.
 *
 * ## Pourquoi il a fallu l'ajouter
 *
 * La version précédente gardait le coffre dans la mémoire de l'objet `Keystore`, et rien
 * d'autre. C'est plus sûr sur le papier, et **inutilisable en MV3** : le service worker meurt
 * après ~30 s d'inactivité, chaque handler reconstruit son keystore, donc un déverrouillage
 * fait dans le side panel n'existait plus au message suivant. Le produit demandait la
 * passphrase indéfiniment sans jamais pouvoir appeler le modèle. Le défaut n'était pas
 * théorique : il rendait le chemin LLM entièrement inatteignable.
 *
 * ## Ce que ça coûte, dit franchement
 *
 * Le coffre déchiffré vit dans `chrome.storage.session`, qui est **en mémoire, jamais écrit
 * sur le disque, et effacé à la fermeture du navigateur**. Ce n'est donc pas une persistance
 * de la passphrase — elle, n'est jamais stockée, nulle part. Mais c'est bien un
 * affaiblissement par rapport à « le clair ne quitte pas une invocation » : un attaquant qui
 * exécute du code dans le contexte de l'extension pendant la session lit le coffre.
 *
 * Cet attaquant lirait de toute façon la clé au premier appel sortant. La limite est déjà
 * énoncée dans `PRIVACY.md`, et la contrepartie — une extension qui fonctionne — est réelle.
 * Deux atténuations concrètes : un TTL, et un bouton de verrouillage immédiat.
 */
export interface SessionVaultCache {
  read(): Promise<{ vault: Vault; unlockedAtMs: number } | null>
  write(entry: { vault: Vault; unlockedAtMs: number }): Promise<void>
  clear(): Promise<void>
}

/**
 * Durée de vie d'un déverrouillage.
 *
 * Huit heures : une session de travail. Plus court ferait redemander la passphrase au milieu
 * d'une session, plus long reviendrait à ne pas expirer du tout. Aucun appel automatique n'en
 * dépend — l'Autopilote n'existe pas et la mesure ne consulte aucun modèle — donc une
 * expiration ne casse rien en arrière-plan, elle demande juste un redéverrouillage.
 */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1_000

export function chromeSessionCache(key = SESSION_KEY): SessionVaultCache {
  return {
    read: async () => {
      // `storage.session` n'existe pas sur les Chrome antérieurs à 102. Sans lui, le produit
      // reste correct : il redemande simplement la passphrase à chaque réveil du worker.
      if (chrome.storage.session === undefined) return null
      const got = await chrome.storage.session.get(key)
      return (got[key] as { vault: Vault; unlockedAtMs: number } | undefined) ?? null
    },
    write: async (entry) => {
      if (chrome.storage.session === undefined) return
      await chrome.storage.session.set({ [key]: entry })
    },
    clear: async () => {
      if (chrome.storage.session === undefined) return
      await chrome.storage.session.remove(key)
    },
  }
}

export function memorySessionCache(): SessionVaultCache {
  let entry: { vault: Vault; unlockedAtMs: number } | null = null
  return {
    read: async () => entry,
    write: async (e) => {
      entry = e
    },
    clear: async () => {
      entry = null
    },
  }
}

/**
 * Coffre déverrouillé.
 *
 * La passphrase n'est **jamais** stockée : seul le coffre déchiffré est mis en cache de
 * session, et seulement si un cache est fourni. Sans cache, le comportement est celui d'avant
 * — clair en mémoire de l'instance uniquement — ce qui reste le bon choix pour les tests.
 */
export class Keystore {
  private vault: Vault | null = null

  constructor(
    private readonly backend: KeystoreBackend,
    private readonly session: SessionVaultCache | null = null,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Restaure un déverrouillage de session, s'il en existe un et s'il n'a pas expiré.
   *
   * Renvoie `true` si le coffre est utilisable après l'appel. C'est le premier geste de tout
   * handler du service worker : sans lui, un worker fraîchement réveillé se croirait
   * verrouillé alors que l'utilisateur a déverrouillé il y a deux minutes.
   */
  async restore(): Promise<boolean> {
    if (this.vault !== null) return true
    if (this.session === null) return false
    const entry = await this.session.read()
    if (entry === null) return false
    if (this.clock.now() - entry.unlockedAtMs > SESSION_TTL_MS) {
      await this.session.clear()
      return false
    }
    this.vault = entry.vault
    return true
  }

  get isUnlocked(): boolean {
    return this.vault !== null
  }

  async isInitialized(): Promise<boolean> {
    return (await this.backend.read()) !== null
  }

  async initialize(passphrase: string, vault: Vault = {}): Promise<void> {
    await this.backend.write(await encryptVault(vault, passphrase))
    await this.adopt(vault)
  }

  async unlock(passphrase: string): Promise<Result<void, KeystoreError>> {
    const blob = await this.backend.read()
    if (!blob) return err({ kind: 'not-initialized' })
    const r = await decryptVault(blob, passphrase)
    if (!r.ok) return err(r.error)
    await this.adopt(r.value)
    return ok(undefined)
  }

  /** Verrouille ici **et** dans la session : un verrouillage partiel ne verrouille rien. */
  async lock(): Promise<void> {
    this.vault = null
    await this.session?.clear()
  }

  private async adopt(vault: Vault): Promise<void> {
    this.vault = vault
    await this.session?.write({ vault, unlockedAtMs: this.clock.now() })
  }

  /** `undefined` si le coffre est verrouillé ou le provider non configuré. */
  credentials(provider: ProviderId): ProviderCredentials | undefined {
    return this.vault?.[provider]
  }

  configuredProviders(): readonly ProviderId[] {
    return this.vault ? (Object.keys(this.vault) as ProviderId[]) : []
  }

  async setCredentials(
    creds: ProviderCredentials,
    passphrase: string,
  ): Promise<Result<void, KeystoreError>> {
    if (!this.vault) {
      const unlocked = await this.unlock(passphrase)
      if (!unlocked.ok) return unlocked
    }
    const next: Vault = { ...this.vault, [creds.providerId]: creds }
    await this.backend.write(await encryptVault(next, passphrase))
    await this.adopt(next)
    return ok(undefined)
  }

  /** Retire un provider du coffre. Demande la passphrase : on réécrit le blob chiffré. */
  async removeCredentials(
    provider: ProviderId,
    passphrase: string,
  ): Promise<Result<void, KeystoreError>> {
    if (!this.vault) {
      const unlocked = await this.unlock(passphrase)
      if (!unlocked.ok) return unlocked
    }
    const next: Vault = { ...this.vault }
    delete next[provider]
    await this.backend.write(await encryptVault(next, passphrase))
    await this.adopt(next)
    return ok(undefined)
  }

  async destroy(): Promise<void> {
    this.vault = null
    await this.session?.clear()
    await this.backend.clear()
  }
}
