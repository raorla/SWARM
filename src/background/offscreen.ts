/**
 * Cycle de vie de l'Offscreen Document.
 *
 * Un seul offscreen document peut exister par extension, et `createDocument` échoue s'il
 * en existe déjà un. Comme le service worker meurt et redémarre en permanence, il ne peut
 * pas savoir s'il a déjà créé le sien : il faut interroger l'état à chaque fois.
 */
import { createLogger } from '@/shared/logger'

const log = createLogger('background:offscreen')
const PATH = 'src/offscreen/index.html'

async function exists(): Promise<boolean> {
  // `getContexts` est la seule façon fiable de savoir. Un booléen de portée module serait
  // faux dès le premier réveil du service worker.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(PATH)],
  })
  return contexts.length > 0
}

/** Idempotent : sûr à appeler à chaque réveil du service worker. */
export async function ensureOffscreen(): Promise<void> {
  if (await exists()) return
  try {
    await chrome.offscreen.createDocument({
      url: PATH,
      // WORKERS : le calcul d'embeddings tourne dans un Web Worker à l'intérieur du
      // document (ADR 0002). C'est la raison d'être de ce contexte.
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification:
        'Calcul local des embeddings et agrégations longues, hors de la fenêtre de vie du service worker.',
    })
    log.info('offscreen document créé')
  } catch (e) {
    // Course possible : deux réveils quasi simultanés. Si le document existe désormais,
    // l'échec est bénin.
    if (await exists()) return
    log.error('création de l’offscreen document en échec', { error: e })
  }
}

export async function closeOffscreen(): Promise<void> {
  if (!(await exists())) return
  await chrome.offscreen.closeDocument()
}
