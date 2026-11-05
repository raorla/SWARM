/**
 * MESURE DU DoD DE LA PHASE 3 — « 200 posts triés pour moins de 0,05 € ».
 *
 * ## Ce que cette mesure ajoute au test unitaire
 *
 * `tests/unit/swarm/qualifier.test.ts` asserte déjà le DoD **sur les tarifs de référence** : il
 * échoue si le prompt s'allonge, si la sortie grossit ou si la taille des lots baisse. Ce qu'il
 * ne peut pas faire, c'est vérifier le comptage réel de tokens : il dépend du tokenizer du
 * modèle, et une estimation à quatre caractères par token se trompe de 20 à 30 % sur du texte
 * mêlant anglais, français, tickers et emojis — c'est-à-dire sur le corpus de la niche.
 *
 * ## Limite à énoncer avant de lire le chiffre
 *
 * Les 200 posts sont **synthétiques** : ils reproduisent la longueur, la langue et la forme de
 * posts réels, pas leur contenu. Le coût mesuré est donc représentatif de la *structure* du
 * lot, pas d'un échantillon de timeline. Pour un chiffre définitif, il faut une archive réelle
 * (`simulation/recorder.ts`) — c'est suivi dans TODO.
 *
 * Coût : ~0,02 €. Lancer avec `npm run measure:qualifier`.
 */
import { describe, expect, it } from 'vitest'
import { qualifyAll } from '@/swarm/agents/qualifier'
import { QUALIFIER_BATCH_SIZE } from '@/swarm/schemas/qualifier.io'
import { bundledPack } from '@/niches/loader'
import type { ExtractedPost } from '@/content/dom/dom-schemas'
import { SeededRng } from '@/shared/rng'
import { buildLiveClient, spentEur } from './lib/client.ts'
import { checkOpenRouterKey, loadEnv } from '../../scripts/lib/env.ts'

const env = loadEnv()
const keyCheck = checkOpenRouterKey(env.openRouterKey)

const POST_COUNT = 200
/** Graine fixe : deux exécutions doivent porter sur le même lot, sinon on compare du bruit. */
const SEED = 20260826
/** Le DoD, en euros. */
const DOD_LIMIT_EUR = 0.05

/**
 * Fragments calibrés en longueur sur ce qu'on voit réellement dans la niche.
 *
 * Mélange volontaire d'anglais et de français, avec tickers, chiffres et abréviations : c'est
 * précisément ce qui fait dériver une estimation de tokens, donc ce qu'il faut mesurer.
 */
const FRAGMENTS: readonly string[] = [
  'the bonding curve mechanics on this launch are genuinely different from the last three',
  'gm. la liquidité est verrouillée 6 mois, contrat renoncé, 0 % de taxe',
  'anyone else notice the top 10 holders cleared 40% in the first two blocks',
  'je regarde ce chart depuis 3h et je ne comprends toujours pas le volume',
  'dev doxxed, LP locked, CA in bio — but the chart says otherwise',
  'pourquoi personne ne parle de la distribution initiale sur ce genre de lancement ?',
  'this is the fourth launch this week using the same contract template',
  'holders +2400 en 48h, volume 1.2M, mcap encore sous 300k — quelqu’un a une explication ?',
  'the community is real but the tokenomics make no sense at all here honestly',
  'ça sent le rug mais je peux me tromper, quelqu’un a vérifié le contrat ?',
  'watching the same 6 wallets rotate between every new launch on this chain',
  'les frais de transaction ont doublé cette semaine, quelqu’un d’autre remarque ça ?',
]

/**
 * Construit un lot déterministe et varié.
 *
 * La variété compte pour le coût : 200 posts identiques seraient entièrement mis en cache par
 * le modèle amont et donneraient un chiffre flatteur et faux.
 */
function buildPosts(count: number): ExtractedPost[] {
  const rng = new SeededRng(SEED)
  const now = 1_787_000_000_000
  const posts: ExtractedPost[] = []

  for (let i = 0; i < count; i++) {
    const a = FRAGMENTS[Math.floor(rng.next() * FRAGMENTS.length)]!
    const b = FRAGMENTS[Math.floor(rng.next() * FRAGMENTS.length)]!
    // Un post sur trois est court, comme sur X.
    const text = rng.next() < 0.33 ? a : `${a}. ${b}`

    posts.push({
      postId: `1787${String(100_000_000_000 + i)}`,
      authorHandle: `author${i}`,
      authorDisplayName: null,
      text,
      lang: text.includes('é') || text.includes('ça') ? 'fr' : 'en',
      postedAtMs: now - Math.floor(rng.next() * 60) * 60_000,
      replyCount: Math.floor(rng.next() * 40),
      likeCount: Math.floor(rng.next() * 300),
      repostCount: Math.floor(rng.next() * 30),
      hasMedia: rng.next() < 0.2,
      hasQuote: false,
      isReply: false,
      isOwnPost: false,
      surface: 'timeline',
      observedAtMs: now,
      permalink: `https://x.com/author${i}/status/1787${String(100_000_000_000 + i)}`,
    })
  }
  return posts
}

describe.skipIf(!keyCheck.ok)('DoD Phase 3 — coût réel du triage', () => {
  it(`trie ${POST_COUNT} posts pour moins de ${DOD_LIMIT_EUR.toFixed(2)} €`, async () => {
    const { client, budget } = await buildLiveClient()
    const pack = bundledPack('memecoin')
    expect(pack, 'pack « memecoin » introuvable').toBeDefined()

    const posts = buildPosts(POST_COUNT)
    const chars = posts.reduce((sum, p) => sum + p.text.length, 0)
    console.log(
      `\n${POST_COUNT} posts synthétiques · ${chars} caractères · ` +
        `${Math.ceil(POST_COUNT / QUALIFIER_BATCH_SIZE)} appels attendus (lots de ${QUALIFIER_BATCH_SIZE})`,
    )

    const result = await qualifyAll(posts, pack!, { client })
    const spent = await spentEur(budget)
    const inputTokens = result.trail.reduce((sum, step) => sum + step.tokens.input, 0)
    const outputTokens = result.trail.reduce((sum, step) => sum + step.tokens.output, 0)

    console.log(`Appels           : ${result.batches} (${result.failedBatches} en échec)`)
    console.log(`Verdicts         : ${result.qualified.length} / ${POST_COUNT} · manquants ${result.missingVerdicts}`)
    console.log(`Tokens           : entrée ${inputTokens} · sortie ${outputTokens}`)
    console.log(
      `Par verdict      : ${(outputTokens / Math.max(1, result.qualified.length)).toFixed(1)} tokens de sortie`,
    )
    console.log(
      `Ratio sortie/entrée : ${(outputTokens / Math.max(1, inputTokens)).toFixed(2)} — ` +
        "la sortie est facturée 5× l'entrée sur Haiku, donc c'est elle qu'on surveille",
    )
    console.log(`Coût (trail)     : ${result.totalCostEur.toFixed(5)} €`)
    console.log(`Coût (budget)    : ${spent.toFixed(5)} €`)
    console.log(`Extrapolation    : ${(spent * 5).toFixed(4)} € pour 1 000 posts/jour\n`)

    // Un lot en échec rend le coût incomplet : conclure serait pire que ne pas conclure.
    expect(result.failedBatches, 'des lots ont échoué : coût incomplet, aucun verdict sur le DoD').toBe(0)

    // Le trail ne contient que les étapes **réussies** ; le budget compte tout ce qui a été
    // dépensé, lots en échec inclus. Les deux ne coïncident donc que si rien n'a échoué — et
    // c'est le budget qui dit la vérité sur l'argent sorti.
    if (result.failedBatches === 0) {
      expect(Math.abs(result.totalCostEur - spent)).toBeLessThan(0.000_01)
    } else {
      console.log(
        `⚠ ${result.failedBatches} lot(s) en échec : ${(spent - result.totalCostEur).toFixed(5)} € ` +
          'dépensés sans verdict, comptés par le budget mais absents du trail.',
      )
    }

    if (spent > DOD_LIMIT_EUR) {
      console.log(`✗ DoD MANQUÉ — dépassement ×${(spent / DOD_LIMIT_EUR).toFixed(2)}.`)
      console.log('  Leviers par effet décroissant : réduire la sortie, agrandir les lots,')
      console.log('  raccourcir le prompt.')
    } else {
      console.log(
        `✓ DoD ATTEINT — marge ×${(DOD_LIMIT_EUR / Math.max(spent, 1e-9)).toFixed(1)} avant dépassement.`,
      )
    }
    expect(spent).toBeLessThanOrEqual(DOD_LIMIT_EUR)
  })
})

describe.skipIf(keyCheck.ok)('DoD Phase 3 — mesure non exécutée', () => {
  it('explique ce qui manque', () => {
    console.log(`\n⏭  Mesure ignorée : ${keyCheck.reason}`)
    expect(keyCheck.ok).toBe(false)
  })
})
