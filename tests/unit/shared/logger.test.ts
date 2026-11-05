import { describe, expect, it, vi } from 'vitest'
import { Logger, REDACTED, redact } from '@/shared/logger'

/** Secrets de forme réaliste, jamais de vraies clés. */
const FAKE_SECRETS = {
  anthropic: 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1111222233334444',
  openrouter: 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef',
  openai: 'sk-proj-ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS',
  google: 'AIzaSyA1234567890abcdefghijklmnopqrstuvw',
  xai: 'xai-abcdefghij0123456789abcdefghij',
}

type Sink = NonNullable<ConstructorParameters<typeof Logger>[0]['sink']>

function capture(): { sink: Sink; lines: string[] } {
  const lines: string[] = []
  const sink: Sink = (level, scope, message, fields) => {
    lines.push(JSON.stringify({ level, scope, message, fields }))
  }
  return { sink, lines }
}

describe('logger — redaction (MH-08)', () => {
  it('redacte les champs sensibles par leur nom', () => {
    const out = redact({
      apiKey: FAKE_SECRETS.anthropic,
      passphrase: 'correct horse battery staple',
      model: 'claude-haiku-4-5',
    }) as Record<string, unknown>
    expect(out['apiKey']).toBe(REDACTED)
    expect(out['passphrase']).toBe(REDACTED)
    expect(out['model']).toBe('claude-haiku-4-5')
  })

  it('redacte quelle que soit la casse ou le style du nom de champ', () => {
    for (const key of [
      'API_KEY',
      'apiKey',
      'ApiKey',
      'access_token',
      'refreshToken',
      'x-api-key',
    ]) {
      const out = redact({ [key]: 'valeur-secrète-quelconque' }) as Record<
        string,
        unknown
      >
      expect(out[key], `${key} doit être redacté`).toBe(REDACTED)
    }
  })

  it('redacte les secrets noyés dans du texte libre', () => {
    // Le cas dangereux : une clé concaténée dans un message d'erreur n'est pas protégée
    // par le filtre de noms de champs.
    for (const [provider, secret] of Object.entries(FAKE_SECRETS)) {
      const out = redact(
        `échec de l’appel avec la clé ${secret} sur ${provider}`,
      ) as string
      expect(out, `${provider} doit être masqué`).not.toContain(secret)
      expect(out).toContain(REDACTED)
    }
  })

  it('redacte un en-tête Authorization', () => {
    const out = redact(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    ) as string
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('aucun secret ne traverse un Logger, quel que soit le chemin', () => {
    const { sink, lines } = capture()
    const log = new Logger({ scope: 'test', level: 'debug', sink })

    log.info(`clé brute ${FAKE_SECRETS.openrouter}`)
    log.error('échec', { apiKey: FAKE_SECRETS.anthropic })
    log.warn('nesté', { creds: { openai: { apiKey: FAKE_SECRETS.openai } } })
    log.debug('erreur', new Error(`refusé pour ${FAKE_SECRETS.google}`))
    log.info('tableau', [{ token: FAKE_SECRETS.xai }])
    log.info('map', new Map([['secret', FAKE_SECRETS.anthropic]]))

    const all = lines.join('\n')
    for (const secret of Object.values(FAKE_SECRETS)) {
      expect(all, 'aucun secret ne doit apparaître dans les logs').not.toContain(secret)
    }
  })

  it('redacte la stack d’une Error, qui peut contenir des URL paramétrées', () => {
    const e = new Error('échec')
    e.stack = `Error: échec\n  at fetch (https://api.example.com/v1?key=${FAKE_SECRETS.google})`
    const out = redact(e) as { stack: string }
    expect(out.stack).not.toContain(FAKE_SECRETS.google)
  })

  it('remplace les données binaires par leur taille', () => {
    const out = redact({
      iv: new Uint8Array([1, 2, 3]),
      buf: new ArrayBuffer(32),
    }) as Record<string, unknown>
    // `iv` est un nom sensible, donc redacté ; `buf` devient une description de taille.
    expect(out['iv']).toBe(REDACTED)
    expect(String(out['buf'])).toContain('binaire')
  })

  it('gère les cycles sans boucler', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a['self'] = a
    expect(() => redact(a)).not.toThrow()
    expect(JSON.stringify(redact(a))).toContain('cycle')
  })

  it('respecte le niveau minimum', () => {
    const { sink, lines } = capture()
    const log = new Logger({ scope: 'test', level: 'warn', sink })
    log.debug('invisible')
    log.info('invisible')
    log.warn('visible')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('visible')
  })

  it('tronque les chaînes très longues', () => {
    const out = redact('x'.repeat(5_000)) as string
    expect(out.length).toBeLessThan(2_100)
    expect(out).toContain('tronqué')
  })

  it('ne mute pas la valeur passée', () => {
    // Les appelants passent souvent des objets encore utilisés ailleurs.
    const input = { apiKey: FAKE_SECRETS.anthropic, keep: 1 }
    redact(input)
    expect(input.apiKey).toBe(FAKE_SECRETS.anthropic)
    void vi
  })
})
