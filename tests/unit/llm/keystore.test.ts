import { describe, expect, it } from 'vitest'
import {
  Keystore,
  SESSION_TTL_MS,
  decryptVault,
  encryptVault,
  memoryBackend,
  memorySessionCache,
} from '@/llm/keystore'
import { FakeClock } from '@/shared/time'

const FAKE_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef'
const PASSPHRASE = 'une passphrase raisonnablement longue'

describe('keystore — chiffrement', () => {
  it('fait un aller-retour correct', async () => {
    const vault = { openrouter: { providerId: 'openrouter' as const, apiKey: FAKE_KEY } }
    const blob = await encryptVault(vault, PASSPHRASE)
    const r = await decryptVault(blob, PASSPHRASE)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.openrouter?.apiKey).toBe(FAKE_KEY)
  })

  it('ne laisse jamais la cle en clair dans le blob', async () => {
    const blob = await encryptVault(
      { openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY } },
      PASSPHRASE,
    )
    const serialized = JSON.stringify(blob)
    expect(serialized).not.toContain(FAKE_KEY)
    expect(serialized).not.toContain('sk-or-v1')
  })

  it('refuse une mauvaise passphrase', async () => {
    const blob = await encryptVault(
      { openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY } },
      PASSPHRASE,
    )
    const r = await decryptVault(blob, 'mauvaise passphrase')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('wrong-passphrase')
  })

  it('produit un sel et un IV differents a chaque ecriture', async () => {
    // Reutiliser un IV avec AES-GCM est une faute cryptographique classique.
    const vault = { openrouter: { providerId: 'openrouter' as const, apiKey: FAKE_KEY } }
    const a = await encryptVault(vault, PASSPHRASE)
    const b = await encryptVault(vault, PASSPHRASE)
    expect(a.iv).not.toBe(b.iv)
    expect(a.salt).not.toBe(b.salt)
    expect(a.ct).not.toBe(b.ct)
  })

  it('detecte une alteration du texte chiffre', async () => {
    const blob = await encryptVault(
      { openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY } },
      PASSPHRASE,
    )
    // AES-GCM est authentifie : toute modification fait echouer le dechiffrement.
    const tampered = { ...blob, ct: blob.ct.slice(0, -4) + 'AAAA' }
    expect((await decryptVault(tampered, PASSPHRASE)).ok).toBe(false)
  })

  it('relit le nombre d iterations depuis le blob', async () => {
    // Sinon, relever le cout de derivation dans une version future rendrait illisibles
    // tous les coffres existants.
    const blob = await encryptVault({}, PASSPHRASE)
    expect(blob.iterations).toBeGreaterThan(100_000)
    const r = await decryptVault({ ...blob }, PASSPHRASE)
    expect(r.ok).toBe(true)
  })
})

describe('Keystore — cycle de vie', () => {
  it('demarre non initialise et verrouille', async () => {
    const ks = new Keystore(memoryBackend())
    expect(await ks.isInitialized()).toBe(false)
    expect(ks.isUnlocked).toBe(false)
    expect(ks.credentials('openrouter')).toBeUndefined()
  })

  it('s initialise, se verrouille, se deverrouille', async () => {
    const backend = memoryBackend()
    const ks = new Keystore(backend)
    await ks.initialize(PASSPHRASE, {
      openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY },
    })
    expect(ks.isUnlocked).toBe(true)

    await ks.lock()
    expect(ks.isUnlocked).toBe(false)
    expect(ks.credentials('openrouter')).toBeUndefined()

    const r = await ks.unlock(PASSPHRASE)
    expect(r.ok).toBe(true)
    expect(ks.credentials('openrouter')?.apiKey).toBe(FAKE_KEY)
  })

  it('ne persiste pas l etat deverrouille : un nouveau worker redemarre verrouille', async () => {
    // Consequence assumee du fait que la passphrase n'est stockee nulle part.
    const backend = memoryBackend()
    const first = new Keystore(backend)
    await first.initialize(PASSPHRASE, {
      openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY },
    })

    const afterRestart = new Keystore(backend)
    expect(afterRestart.isUnlocked).toBe(false)
    expect(await afterRestart.isInitialized()).toBe(true)
  })

  it('ajoute un provider sans perdre les autres', async () => {
    const ks = new Keystore(memoryBackend())
    await ks.initialize(PASSPHRASE, {
      openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY },
    })
    await ks.setCredentials(
      {
        providerId: 'openai-compatible',
        apiKey: '',
        baseUrl: 'http://localhost:11434/v1',
      },
      PASSPHRASE,
    )
    expect(ks.configuredProviders()).toHaveLength(2)
    expect(ks.credentials('openrouter')?.apiKey).toBe(FAKE_KEY)
  })

  it('signale un coffre non initialise plutot qu une mauvaise passphrase', async () => {
    const ks = new Keystore(memoryBackend())
    const r = await ks.unlock(PASSPHRASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('not-initialized')
  })

  it('detruit tout', async () => {
    const backend = memoryBackend()
    const ks = new Keystore(backend)
    await ks.initialize(PASSPHRASE, {
      openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY },
    })
    await ks.destroy()
    expect(await ks.isInitialized()).toBe(false)
    expect(ks.isUnlocked).toBe(false)
  })
})

describe('keystore — deverrouillage de session', () => {
  /**
   * Le defaut que ce cache corrige : en MV3 le service worker meurt entre deux messages, donc
   * un deverrouillage fait dans le side panel n'existait plus a l'appel suivant. Le chemin LLM
   * etait inatteignable en pratique — pas fragile, inatteignable.
   */
  it('un nouveau worker retrouve le coffre deverrouille', async () => {
    const backend = memoryBackend()
    const session = memorySessionCache()
    const clock = new FakeClock('2026-08-25T10:00:00.000Z')

    const first = new Keystore(backend, session, clock)
    await first.initialize(PASSPHRASE, {
      openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY },
    })

    const afterRestart = new Keystore(backend, session, clock)
    expect(afterRestart.isUnlocked).toBe(false)
    expect(await afterRestart.restore()).toBe(true)
    expect(afterRestart.credentials('openrouter')?.apiKey).toBe(FAKE_KEY)
  })

  it('le deverrouillage expire apres le TTL', async () => {
    const session = memorySessionCache()
    const clock = new FakeClock('2026-08-25T10:00:00.000Z')
    const ks = new Keystore(memoryBackend(), session, clock)
    await ks.initialize(PASSPHRASE, {
      openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY },
    })

    clock.advance(SESSION_TTL_MS + 1)
    const afterRestart = new Keystore(memoryBackend(), session, clock)
    expect(await afterRestart.restore()).toBe(false)
    // Le cache est vide, pas seulement ignore : un clair expire ne doit pas rester en session.
    expect(await session.read()).toBeNull()
  })

  it('reste deverrouille juste avant le TTL', async () => {
    // La borne compte : un TTL applique une heure trop tot redemanderait la passphrase au
    // milieu d'une session de travail.
    const backend = memoryBackend()
    const session = memorySessionCache()
    const clock = new FakeClock('2026-08-25T10:00:00.000Z')
    const ks = new Keystore(backend, session, clock)
    await ks.initialize(PASSPHRASE, {
      openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY },
    })

    clock.advance(SESSION_TTL_MS - 1)
    expect(await new Keystore(backend, session, clock).restore()).toBe(true)
  })

  it('verrouiller efface AUSSI la session', async () => {
    // Un verrouillage partiel ne verrouille rien : le worker suivant restaurerait le coffre.
    const backend = memoryBackend()
    const session = memorySessionCache()
    const ks = new Keystore(backend, session)
    await ks.initialize(PASSPHRASE, {
      openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY },
    })

    await ks.lock()
    expect(await session.read()).toBeNull()
    expect(await new Keystore(backend, session).restore()).toBe(false)
  })

  it('detruire efface la session', async () => {
    const backend = memoryBackend()
    const session = memorySessionCache()
    const ks = new Keystore(backend, session)
    await ks.initialize(PASSPHRASE, { openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY } })
    await ks.destroy()
    expect(await session.read()).toBeNull()
    expect(await backend.read()).toBeNull()
  })

  it('sans cache de session, le comportement d avant est conserve', async () => {
    // Les tests et l'offscreen n'ont aucune raison de mettre un clair en session.
    const backend = memoryBackend()
    const ks = new Keystore(backend)
    await ks.initialize(PASSPHRASE, { openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY } })
    expect(await new Keystore(backend).restore()).toBe(false)
  })

  it('la session ne contient JAMAIS la passphrase', async () => {
    // C'est la ligne rouge : le coffre dechiffre est mis en cache, la passphrase jamais.
    const session = memorySessionCache()
    const ks = new Keystore(memoryBackend(), session)
    await ks.initialize(PASSPHRASE, { openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY } })
    expect(JSON.stringify(await session.read())).not.toContain(PASSPHRASE)
  })

  it('retire un provider sans toucher aux autres', async () => {
    const ks = new Keystore(memoryBackend())
    await ks.initialize(PASSPHRASE, {
      openrouter: { providerId: 'openrouter', apiKey: FAKE_KEY },
      anthropic: { providerId: 'anthropic', apiKey: 'sk-ant-fake' },
    })
    const r = await ks.removeCredentials('anthropic', PASSPHRASE)
    expect(r.ok).toBe(true)
    expect(ks.credentials('anthropic')).toBeUndefined()
    expect(ks.credentials('openrouter')?.apiKey).toBe(FAKE_KEY)
  })
})
