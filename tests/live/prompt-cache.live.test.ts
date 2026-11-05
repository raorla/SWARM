/**
 * MESURE R-03 — le cache de prompt passe-t-il à travers OpenRouter ?
 *
 * ## Pourquoi cette mesure passe avant les autres
 *
 * Tout le chiffrage à 1 €/jour (SPEC §3.2) repose sur une hypothèse jamais vérifiée : que
 * `cache_control` envoyé à OpenRouter est propagé jusqu'à Anthropic, et que le préfixe stable
 * du WRITER et du CRITIC — Voice Profile, brief de niche, garde-fous — est donc facturé au
 * dixième du tarif d'entrée à partir du deuxième appel.
 *
 * Si l'hypothèse est fausse, le coût d'entrée de ces deux agents est multiplié par dix. La
 * bifurcation est déjà prévue dans l'architecture : WRITER et CRITIC tapent Anthropic en
 * direct, le triage reste sur OpenRouter. Ce qui manquait était la mesure.
 *
 * ## Comment
 *
 * Deux appels successifs, **même préfixe marqué cacheable**, suffixe différent. On lit
 * `cacheReadTokens` tel que le provider le rapporte — jamais estimé (SPEC §3.2 règle 2).
 *
 * Le piège principal : le préfixe doit dépasser le minimum de cache d'Anthropic (~1024 tokens).
 * En dessous, le marqueur est ignoré **en silence**, et on concluerait à tort que la
 * propagation ne marche pas. `buildPrefix()` s'en charge, et l'assertion le vérifie.
 *
 * Coût : ~0,004 €. Lancer avec `npm run measure:cache`, après avoir renseigné `.env`.
 */
import { describe, expect, it } from 'vitest'
import { openRouterProvider } from '@/llm/providers/openrouter'
import { FALLBACK_TABLE, computeCostEur } from '@/llm/pricing'
import { DEFAULT_ROUTING } from '@/llm/router'
import type { TokenUsage } from '@/llm/types'
import { checkOpenRouterKey, keyFingerprint, loadEnv } from '../../scripts/lib/env.ts'

const env = loadEnv()
const keyCheck = checkOpenRouterKey(env.openRouterKey)
const MODEL = DEFAULT_ROUTING.writer.model
/** Minimum de mise en cache d'Anthropic. En dessous, le marqueur est ignoré sans erreur. */
const MIN_CACHEABLE_TOKENS = 1_024

/**
 * Préfixe stable, assez long pour être cachable.
 *
 * Le contenu imite la forme réelle du préfixe du WRITER — garde-fous, profil de voix, brief de
 * niche — parce que mesurer le cache sur un lorem ipsum ne dirait rien de la structure qu'on
 * enverra vraiment. Le bloc est répété jusqu'à dépasser le minimum, avec de la marge.
 */
function buildPrefix(): string {
  const block = [
    'Tu es le rédacteur d’un compte X. Tu écris des réponses courtes, dans la voix de',
    'l’utilisateur, sans formule d’assistant, sans emoji, sans point d’exclamation.',
    'Tu ne parles jamais de santé, de deuil, de politique, de crise, ni de conseil financier.',
    'Tu ne donnes pas de prédiction de prix, tu ne promeus aucun ticker, tu n’utilises pas',
    'de superlatif publicitaire. Longueur cible : entre 90 et 180 caractères. Registre :',
    'sobre, spécifique, une seule idée par réponse. Interdits de vocabulaire : « moon »,',
    '« pump », « gem », « next 100x ». Angles autorisés : contrepoint, donnée, question.',
  ].join('\n')

  let prefix = ''
  const targetChars = MIN_CACHEABLE_TOKENS * 4 * 1.6
  while (prefix.length < targetChars) prefix += `${block}\n\n`
  return prefix
}

function describeUsage(usage: TokenUsage): string {
  return [
    `entrée ${usage.inputTokens}`,
    `sortie ${usage.outputTokens}`,
    `cache lu ${usage.cacheReadTokens}`,
    `cache écrit ${usage.cacheWriteTokens}`,
  ].join(' · ')
}

async function callOnce(
  apiKey: string,
  prefix: string,
  suffix: string,
): Promise<{ usage: TokenUsage; model: string; costEur: number }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const result = await openRouterProvider.complete(
      {
        role: 'writer',
        model: MODEL,
        maxOutputTokens: 64,
        // Le marqueur est ici, et seulement ici : c'est tout l'objet de la mesure.
        messages: [
          { role: 'system', content: prefix, cacheable: true },
          { role: 'user', content: suffix },
        ],
      },
      { providerId: 'openrouter', apiKey },
      controller.signal,
    )
    // Table de repli : ces mesures tournent hors extension, sans catalogue synchronisé. Le
    // coût affiché est un ordre de grandeur, pas une facture.
    const cost = computeCostEur(FALLBACK_TABLE, MODEL, result.usage)
    return { usage: result.usage, model: result.model, costEur: cost.eur }
  } finally {
    clearTimeout(timeout)
  }
}

describe.skipIf(!keyCheck.ok)('R-03 — propagation du cache de prompt', () => {
  it('un préfixe identique est lu depuis le cache au second appel', async () => {
    const apiKey = env.openRouterKey!
    const prefix = buildPrefix()

    console.log(`\nClé    : ${keyFingerprint(apiKey)}`)
    console.log(`Modèle : ${MODEL}`)
    console.log(
      `Préfixe: ${prefix.length} caractères (~${Math.round(prefix.length / 4)} tokens estimés)\n`,
    )

    // Note : si une mesure précédente a déjà chauffé ce préfixe, le premier appel lira le
    // cache lui aussi. Ce n'est pas un problème — le verdict porte sur le second.
    const first = await callOnce(apiKey, prefix, 'Réponds uniquement : ok.')
    console.log(`Appel 1 (écriture) : ${describeUsage(first.usage)}`)
    console.log(`  modèle servi ${first.model} · ${first.costEur.toFixed(6)} €`)

    // Le cache est disponible presque immédiatement, mais pas instantanément : deux secondes
    // évitent de conclure « pas de cache » sur une course.
    await new Promise((resolve) => setTimeout(resolve, 2_000))

    const second = await callOnce(apiKey, prefix, 'Réponds uniquement : deux.')
    console.log(`Appel 2 (lecture)  : ${describeUsage(second.usage)}`)
    console.log(`  modèle servi ${second.model} · ${second.costEur.toFixed(6)} €`)
    console.log(`\nCoût de la mesure : ${(first.costEur + second.costEur).toFixed(6)} €`)

    // Contrôle préalable : sans préfixe assez long, le résultat ne veut rien dire — que le
    // cache marche ou non, on ne l'aurait pas testé.
    // Le total du prompt, pas l'entrée nette : sur un appel déjà caché, l'entrée nette est
    // minuscule alors que le préfixe est bien assez long.
    expect(
      first.usage.inputTokens + first.usage.cacheReadTokens + first.usage.cacheWriteTokens,
      `préfixe trop court pour être cachable (< ${MIN_CACHEABLE_TOKENS} tokens) : la mesure ne conclut rien`,
    ).toBeGreaterThan(MIN_CACHEABLE_TOKENS)

    if (second.usage.cacheReadTokens === 0) {
      console.log('\n✗ R-03 INFIRMÉ — aucun token lu depuis le cache.')
      console.log(`  cache écrit au 1ᵉʳ appel : ${first.usage.cacheWriteTokens}`)
      console.log(
        "  À zéro, rien n'a été mis en cache : le problème est en amont de la lecture.",
      )
      console.log(`  Modèle demandé ${MODEL}, modèle servi ${second.model}.`)
      console.log('  → La bifurcation prévue s’applique : WRITER et CRITIC sur Anthropic direct,')
      console.log('    le triage reste sur OpenRouter. À consigner dans FEEDBACK (R-03).')
    } else {
      // `inputTokens` est déjà net de cache (voir `readUsage` dans le provider) : la part
      // cachée se rapporte donc au total du prompt, entrée nette **plus** cache lu.
      const promptTotal = second.usage.inputTokens + second.usage.cacheReadTokens
      const share = second.usage.cacheReadTokens / Math.max(1, promptTotal)
      console.log(
        `\n✓ R-03 CONFIRMÉ — ${second.usage.cacheReadTokens} tokens lus depuis le cache ` +
          `(${(share * 100).toFixed(0)} % de l'entrée du 2ᵉ appel).`,
      )
      console.log('  Le chiffrage de SPEC §3.2 tient. À consigner dans FEEDBACK (R-03).')
    }

    expect(
      second.usage.cacheReadTokens,
      'aucun token lu depuis le cache : voir la sortie ci-dessus pour la bifurcation à appliquer',
    ).toBeGreaterThan(0)
  })
})

describe.skipIf(keyCheck.ok)('R-03 — mesure non exécutée', () => {
  it('explique ce qui manque', () => {
    console.log(`\n⏭  Mesure ignorée : ${keyCheck.reason}`)
    expect(keyCheck.ok).toBe(false)
  })
})
