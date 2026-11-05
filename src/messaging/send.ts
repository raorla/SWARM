/**
 * Émission de messages typés.
 *
 * Trois problèmes réels de MV3 traités ici :
 *  1. `sendMessage` peut résoudre `undefined` si aucun listener n'a répondu — un
 *     service worker endormi le fait couramment. On distingue ce cas d'une vraie erreur.
 *  2. Un content script survit au rechargement de son extension mais son contexte est
 *     invalidé ; l'appel lance alors « Extension context invalidated ».
 *  3. Sans timeout, un handler qui oublie `sendResponse` bloque l'appelant pour toujours.
 */
import {
  MessageSchema,
  ResponseSchema,
  type Message,
  type MsgType,
  type PayloadOf,
} from './contract'
import { err, ok, type Result } from '@/shared/result'
import { createLogger } from '@/shared/logger'

const log = createLogger('messaging')

export type SendError =
  | { kind: 'no-receiver' }
  | { kind: 'context-invalidated' }
  | { kind: 'timeout'; ms: number }
  | { kind: 'handler-error'; message: string; code?: string }
  | { kind: 'invalid-outgoing'; issues: readonly string[] }
  | { kind: 'invalid-response'; issues: readonly string[] }

const DEFAULT_TIMEOUT_MS = 15_000

function classify(message: string): SendError {
  if (/Extension context invalidated/i.test(message))
    return { kind: 'context-invalidated' }
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return { kind: 'no-receiver' }
  }
  return { kind: 'handler-error', message }
}

/** Envoie un message validé et attend une réponse validée. */
export async function send<T extends MsgType>(
  type: T,
  payload: PayloadOf<T>,
  opts: { timeoutMs?: number; tabId?: number } = {},
): Promise<Result<unknown, SendError>> {
  const candidate = { type, payload } as Message
  const parsed = MessageSchema.safeParse(candidate)
  if (!parsed.success) {
    // On échoue à l'émission : un message hors contrat ne doit jamais partir, sinon on
    // débogue à l'autre bout un problème né ici.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    log.error('message sortant hors contrat', { type, issues })
    return err({ kind: 'invalid-outgoing', issues })
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const raw = await new Promise<Result<unknown, SendError>>((resolve) => {
    const timer = setTimeout(
      () => resolve(err({ kind: 'timeout', ms: timeoutMs })),
      timeoutMs,
    )
    const settle = (r: Result<unknown, SendError>): void => {
      clearTimeout(timer)
      resolve(r)
    }

    const cb = (response: unknown): void => {
      const lastError = chrome.runtime.lastError
      if (lastError) return settle(err(classify(lastError.message ?? 'erreur inconnue')))
      if (response === undefined) return settle(err({ kind: 'no-receiver' }))
      settle(ok(response))
    }

    try {
      if (opts.tabId !== undefined) {
        chrome.tabs.sendMessage(opts.tabId, parsed.data, cb)
      } else {
        chrome.runtime.sendMessage(parsed.data, cb)
      }
    } catch (e) {
      settle(err(classify(e instanceof Error ? e.message : String(e))))
    }
  })

  if (!raw.ok) return raw

  const envelope = ResponseSchema.safeParse(raw.value)
  if (!envelope.success) {
    return err({
      kind: 'invalid-response',
      issues: envelope.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    })
  }
  if (!envelope.data.ok) {
    return err(
      envelope.data.code === undefined
        ? { kind: 'handler-error', message: envelope.data.error }
        : {
            kind: 'handler-error',
            message: envelope.data.error,
            code: envelope.data.code,
          },
    )
  }
  return ok(envelope.data.data)
}

/** Émet sans attendre de réponse (diffusion d'état vers le side panel). */
export function emit<T extends MsgType>(type: T, payload: PayloadOf<T>): void {
  const parsed = MessageSchema.safeParse({ type, payload } as Message)
  if (!parsed.success) {
    log.error('diffusion hors contrat, abandonnée', { type })
    return
  }
  try {
    // Le side panel peut être fermé : l'absence de destinataire est normale ici.
    chrome.runtime.sendMessage(parsed.data, () => void chrome.runtime.lastError)
  } catch {
    /* contexte invalidé — rien à faire d'utile */
  }
}

export function describeSendError(e: SendError): string {
  switch (e.kind) {
    case 'no-receiver':
      return 'aucun destinataire (contexte endormi ou fermé)'
    case 'context-invalidated':
      return 'contexte d’extension invalidé (recharge la page X)'
    case 'timeout':
      return `pas de réponse en ${e.ms} ms`
    case 'handler-error':
      return e.code ? `${e.code}: ${e.message}` : e.message
    case 'invalid-outgoing':
      return `message sortant hors contrat — ${e.issues.join(' · ')}`
    case 'invalid-response':
      return `réponse hors contrat — ${e.issues.join(' · ')}`
  }
}
