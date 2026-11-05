/**
 * Réception de messages typés.
 *
 * Le point délicat de MV3 : `chrome.runtime.onMessage` doit renvoyer `true` de façon
 * *synchrone* pour garder le canal ouvert sur un handler asynchrone. Renvoyer une
 * promesse ne marche pas et échoue en silence. On l'encapsule une fois ici.
 */
import { MessageSchema, type Message, type MsgType, type PayloadOf } from './contract'
import { createLogger } from '@/shared/logger'

const log = createLogger('messaging')

export type Handler<T extends MsgType> = (
  payload: PayloadOf<T>,
  sender: chrome.runtime.MessageSender,
) => Promise<unknown> | unknown

type HandlerMap = { [K in MsgType]?: Handler<K> }

export interface Router {
  on<T extends MsgType>(type: T, handler: Handler<T>): Router
  start(): () => void
}

export function createRouter(scope: string): Router {
  const handlers: HandlerMap = {}
  const rlog = log.child(scope)

  const listener = (
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): boolean => {
    const parsed = MessageSchema.safeParse(raw)
    if (!parsed.success) {
      // Ne pas répondre du tout laisserait l'émetteur en timeout : on répond une erreur
      // explicite. Autres extensions et scripts de page émettent sur le même canal, donc
      // ce chemin est normal et ne mérite pas un log d'erreur.
      rlog.debug('message ignoré (hors contrat)', {
        issues: parsed.error.issues.map((i) => i.message),
      })
      sendResponse({ ok: false, error: 'message hors contrat', code: 'CONTRACT' })
      return false
    }

    const msg: Message = parsed.data
    const handler = handlers[msg.type] as Handler<MsgType> | undefined
    if (!handler) {
      sendResponse({
        ok: false,
        error: `aucun handler pour ${msg.type}`,
        code: 'NO_HANDLER',
      })
      return false
    }

    // Résolution asynchrone : `return true` doit être synchrone, d'où ce découplage.
    void (async () => {
      try {
        const data = await handler(msg.payload as never, sender)
        sendResponse({ ok: true, data: data ?? null })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        rlog.error('handler en échec', { type: msg.type, error: e })
        sendResponse({ ok: false, error: message, code: 'HANDLER' })
      }
    })()
    return true
  }

  return {
    on<T extends MsgType>(type: T, handler: Handler<T>): Router {
      if (handlers[type]) rlog.warn('handler remplacé', { type })
      handlers[type] = handler as HandlerMap[T]
      return this
    },
    start(): () => void {
      chrome.runtime.onMessage.addListener(listener)
      return () => chrome.runtime.onMessage.removeListener(listener)
    },
  }
}
