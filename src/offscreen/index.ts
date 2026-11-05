/**
 * Offscreen document — squelette de la Phase 0.
 *
 * Raison d'être : le service worker MV3 est tué autour de 30 s, et le calcul
 * d'embeddings locaux (ADR 0002) dépasse largement cette fenêtre. Ce document a une durée
 * de vie longue et l'accès à WASM, sans toucher au DOM de X.
 *
 * Les embeddings arrivent en Phase 6. Ce fichier existe dès maintenant pour que le
 * manifest, la CSP `wasm-unsafe-eval` et le cycle de vie du document soient validés tôt —
 * découvrir en Phase 6 que la CSP bloque le runtime ONNX serait une mauvaise surprise.
 */
import { createLogger } from '@/shared/logger'

const log = createLogger('offscreen')
log.info('offscreen document prêt')

export {}
