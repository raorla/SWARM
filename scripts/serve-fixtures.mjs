/**
 * Serveur de fixtures pour l'E2E.
 *
 * Sert une page qui reproduit la structure DOM de X à partir de `tests/fixtures/x-dom/`.
 * L'intérêt : l'E2E devient déterministe et exécutable en CI, sans compte X et sans
 * réseau. Ce qu'il ne teste pas — que X ressemble à ça — est couvert autrement (voir
 * `tests/fixtures/x-dom/README.md`).
 */
import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 4319
const FIXTURES = join(process.cwd(), 'tests/fixtures/x-dom')

const POSTS = ['timeline-post.html', 'post-with-media.html', 'reply-in-thread.html', 'high-metrics-post.html']

/**
 * Répétitions du jeu de fixtures. La page doit être réellement défilable pour que la mesure
 * de fluidité ait un sens : sur une page qui tient dans le viewport, `scrollBy` ne fait rien
 * et le test mesurerait le vide.
 */
const REPEAT = 12

function page() {
  const one = POSTS.map((f) => readFileSync(join(FIXTURES, f), 'utf8')).join('\n')
  const articles = one.repeat(REPEAT)
  const composer = readFileSync(join(FIXTURES, 'composer-open.html'), 'utf8')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Home / X</title>
<style>body{background:#000;color:#e7e9ea;font-family:system-ui;margin:0}
main{max-width:600px;margin:0 auto}article{border-bottom:1px solid #2f3336;padding:12px}
#composer{display:none;position:fixed;inset:10% 20%;background:#16181c;border:1px solid #2f3336;border-radius:16px;padding:16px}
#composer.open{display:block}
[data-testid="tweetTextarea_0"]{min-height:80px;border:1px solid #2f3336;border-radius:8px;padding:8px}</style>
</head><body>
<div data-testid="primaryColumn"><main role="main">${articles}</main></div>
<div id="composer">${composer}</div>
<script>
  // Reproduit le comportement de X : cliquer Répondre ouvre une fenêtre de rédaction.
  document.addEventListener('click', (e) => {
    const reply = e.target.closest('[data-testid="reply"]')
    if (reply) { document.getElementById('composer').classList.add('open') }
  })
</script>
</body></html>`
}

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page())
}).listen(PORT, () => {
  console.log(`fixtures servies sur http://localhost:${PORT} (${readdirSync(FIXTURES).length} fichiers)`)
})
