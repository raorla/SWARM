/**
 * Setup Vitest global.
 *
 * Deux responsabilités : donner un IndexedDB aux tests de persistance, et fournir un
 * double de l'API `chrome` — les modules sous test ne doivent jamais dépendre de la
 * présence réelle du runtime d'extension.
 */
import 'fake-indexeddb/auto'
import { vi, beforeEach } from 'vitest'

const storageArea = new Map<string, unknown>()
/**
 * `storage.session` est distinct de `storage.local` : en vrai il est en mémoire, jamais
 * écrit sur le disque, et effacé à la fermeture du navigateur. Le keystore s'en sert pour le
 * déverrouillage de session, et confondre les deux zones dans le double ferait passer des
 * tests qui ne devraient pas passer.
 */
const sessionArea = new Map<string, unknown>()

function areaDouble(area: Map<string, unknown>) {
  return {
    get: vi.fn(async (keys?: string | string[]) => {
      if (keys === undefined) return Object.fromEntries(area)
      const list = typeof keys === 'string' ? [keys] : keys
      return Object.fromEntries(
        list.filter((k) => area.has(k)).map((k) => [k, area.get(k)]),
      )
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) area.set(k, v)
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const list = typeof keys === 'string' ? [keys] : keys
      for (const k of list) area.delete(k)
    }),
    clear: vi.fn(async () => area.clear()),
  }
}

const chromeMock = {
  runtime: {
    id: 'test-extension-id',
    lastError: undefined as { message: string } | undefined,
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
  },
  storage: {
    local: areaDouble(storageArea),
    session: areaDouble(sessionArea),
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn(async () => true),
    onAlarm: { addListener: vi.fn() },
  },
  permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
}

// @ts-expect-error — double partiel volontaire : on n'implémente que ce qui est utilisé.
globalThis.chrome = chromeMock

beforeEach(() => {
  storageArea.clear()
  sessionArea.clear()
  vi.clearAllMocks()
})

export { chromeMock, storageArea, sessionArea }
