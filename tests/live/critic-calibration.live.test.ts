/**
 * CALIBRATION DU SEUIL DE VETO DU CRITIC — sur appels réels.
 *
 * ## Le problème
 *
 * Le seuil de veto vaut 0,6, et c'est un chiffre **deviné**. Trop haut, le CRITIC refuse tout
 * et le produit ne sert à rien ; trop bas, il ne protège de rien. Aucune relecture ne tranche :
 * il faut faire noter au modèle des réponses dont on connaît déjà la qualité, et regarder où
 * tombent ses notes.
 *
 * `swarm/calibration/` contient la mécanique — balayage de seuils, faux positifs pondérés trois
 * fois, refus des seuils absurdes, détection de notation dégénérée. Ce qui manquait était
 * l'entrée : les notes d'un vrai CRITIC sur les 19 réponses étiquetées à la main.
 *
 * ## Le mode de défaillance à surveiller en premier
 *
 * Ce n'est pas que le juge se trompe, c'est qu'il **note plat** — tout entre 0,7 et 0,8. Aucun
 * seuil ne sépare alors quoi que ce soit, et un seuil « optimal » calculé sur ces notes serait
 * un artefact du bruit. `detectFlatScoring` le détecte, et la mesure refuse de recommander.
 *
 * Chaque réponse est jugée **seule**, dans son propre appel : les faire juger ensemble
 * laisserait le modèle les comparer entre elles, alors qu'en production il ne voit que les
 * variantes d'une même opportunité.
 *
 * Coût : ~0,05 € (19 appels Sonnet courts). Lancer avec `npm run calibrate:critic`.
 * Écrit son rapport dans `docs/critic-calibration.md`, succès ou échec.
 */
import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { criticAgent } from '@/swarm/agents/critic'
import {
  MEMECOIN_LABELLED_SET,
  describeLabelledSet,
  type LabelledReply,
} from '@/swarm/calibration/labelled-set.memecoin'
import {
  calibrate,
  detectFlatScoring,
  formatReport,
  type LabelledSample,
} from '@/swarm/calibration/calibrate'
import { bundledPack } from '@/niches/loader'
import type { NichePack } from '@/niches/pack.schema'
import type { LlmClient } from '@/llm/client'
import { DEFAULT_VETO_THRESHOLD, type CriticScore } from '@/swarm/schemas/critic.io'
import { buildLiveClient, spentEur } from './lib/client.ts'
import { checkOpenRouterKey, loadEnv } from '../../scripts/lib/env.ts'

const env = loadEnv()
const keyCheck = checkOpenRouterKey(env.openRouterKey)
const OUT_PATH = 'docs/critic-calibration.md'
/** En dessous, on ne recommande rien : un seuil calé sur huit points est une opinion. */
const MIN_SCORED = 10

/**
 * Fait noter une réponse étiquetée par le CRITIC.
 *
 * On la présente comme une variante unique, avec son post d'origine — la forme exacte de ce que
 * le CRITIC voit en production, à ceci près qu'il n'a qu'un candidat. Conséquence assumée : il
 * note dans l'absolu au lieu de comparer, et c'est précisément ce qu'on calibre — le seuil, pas
 * le classement.
 */
async function scoreOne(
  reply: LabelledReply,
  client: LlmClient,
  pack: NichePack,
): Promise<CriticScore | null> {
  const result = await criticAgent.run(
    {
      postText: reply.context,
      variants: [{ text: reply.text, angle: 'counterpoint', intent: 'réponse à évaluer' }],
      pack,
      // Pas de Voice Profile : la distance de voix serait mesurée contre un profil absent, et
      // une valeur arbitraire biaiserait la note d'authenticité dans un sens ou dans l'autre.
      profile: null,
      // Seuil neutre : on veut les NOTES. Le verdict est recalculé par `calibrate()` à chaque
      // seuil du balayage.
      vetoThreshold: 0,
    },
    { client },
  )

  if (!result.ok) {
    const detail =
      result.error.kind === 'refused' ? result.error.reason : result.error.error.message
    console.warn(`  ⚠ ${reply.id} non noté (${result.error.kind}) : ${detail}`)
    return null
  }
  return result.value.output.scores[0] ?? null
}

describe.skipIf(!keyCheck.ok)('calibration du seuil de veto', () => {
  it('recommande un seuil mesuré, ou refuse de recommander', async () => {
    const { client, budget } = await buildLiveClient()
    const pack = bundledPack('memecoin')
    expect(pack, 'pack « memecoin » introuvable').toBeDefined()

    console.log(`\n${describeLabelledSet()}\n`)

    const samples: LabelledSample[] = []
    for (const [index, reply] of MEMECOIN_LABELLED_SET.entries()) {
      const score = await scoreOne(reply, client, pack!)
      if (score === null) continue
      console.log(
        `[${index + 1}/${MEMECOIN_LABELLED_SET.length}] ${reply.id} ` +
          `(${reply.shouldPass ? 'à publier' : 'à rejeter'}) → ${score.overall.toFixed(2)}`,
      )
      samples.push({
        id: reply.id,
        text: reply.text,
        shouldPass: reply.shouldPass,
        score,
        rationale: reply.rationale,
      })
    }

    const spent = await spentEur(budget)
    console.log(
      `\nNoté : ${samples.length} / ${MEMECOIN_LABELLED_SET.length} · coût ${spent.toFixed(5)} €`,
    )

    expect(
      samples.length,
      `moins de ${MIN_SCORED} échantillons notés : trop peu pour recommander un seuil`,
    ).toBeGreaterThanOrEqual(MIN_SCORED)

    const flat = detectFlatScoring(samples)
    const report = calibrate(samples)

    // Le rapport est écrit dans tous les cas : une calibration qui échoue est un résultat, et
    // c'est celui qu'on relira avant de retoucher le prompt.
    // Le défaut appliqué figure dans l'en-tête : sans lui, un rapport qui recommande 0,50 à
    // côté d'un code réglé sur 0,45 laisse un écart inexpliqué dans le dépôt.
    const header = [
      '<!-- Généré par `npm run calibrate:critic`. Ne pas éditer : relancer. -->',
      '',
      `Jeu : ${describeLabelledSet()}`,
      `Notés : ${samples.length} / ${MEMECOIN_LABELLED_SET.length} · coût ${spent.toFixed(5)} €`,
      `Défaut appliqué dans le code : **${DEFAULT_VETO_THRESHOLD}** ` +
        `(recommandation de ce run : ${report.recommended.threshold.toFixed(2)})`,
      '',
    ].join('\n')
    writeFileSync(OUT_PATH, `${header}${formatReport(report, flat)}\n`)

    console.log(`\n${formatReport(report, flat)}`)
    console.log(`\n→ Rapport écrit dans ${OUT_PATH}`)

    if (flat.isFlat) {
      console.log('\n✗ NOTATION DÉGÉNÉRÉE — aucun seuil ne sépare ce jeu.')
      console.log(`  étalement ${flat.spread.toFixed(3)} · séparation ${flat.separation.toFixed(3)}`)
      console.log(`  ${flat.detail}`)
      console.log('  Leviers : durcir les consignes de notation du prompt CRITIC, ou monter de')
      console.log('  modèle — puis recalibrer. Le seuil actuel reste en place en attendant.')
    } else {
      console.log(
        `\n✓ Seuil recommandé : ${report.recommended.threshold.toFixed(2)} — ${report.verdict}`,
      )
      console.log('  À reporter dans l’onglet Config → seuil de veto du CRITIC.')
    }

    // La notation plate fait échouer la mesure : sa valeur est de le dire, pas de produire un
    // chiffre malgré tout.
    expect(flat.isFlat, 'notation dégénérée : voir la sortie ci-dessus').toBe(false)
    expect(report.recommended.threshold).toBeGreaterThan(0)
  })
})

describe.skipIf(keyCheck.ok)('calibration — non exécutée', () => {
  it('explique ce qui manque', () => {
    console.log(`\n⏭  Calibration ignorée : ${keyCheck.reason}`)
    expect(keyCheck.ok).toBe(false)
  })
})
