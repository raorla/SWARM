/**
 * GARDE STRUCTURELLE — aucun module du service worker ne fige l'horloge.
 *
 * ## Le bug que ce test rend impossible
 *
 * `voice-profile.handler.ts` déclarait `const clock = systemClock` au niveau du module, alors
 * que `qualify.handler.ts` et `queue.handler.ts` avaient déjà été corrigés : il était resté en
 * dehors du passage. Conséquence concrète — la péremption du profil se calculait avec l'heure
 * réelle contre un `builtAtMs` écrit avec l'horloge injectée. L'âge était donc faux dès que les
 * deux différaient.
 *
 * Et surtout : le test qui aurait dû le voir passait, parce que sa date simulée valait la date
 * du jour. Il a échoué le lendemain, en ayant l'air d'un test instable. C'est le pire des deux
 * mondes — un bug réel déguisé en bruit de suite.
 *
 * MH-17 dit « horloge injectable ». Une règle appliquée à trois fichiers sur cinq n'est pas une
 * règle, c'est une habitude. Ce test en fait une contrainte.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BACKGROUND = join(process.cwd(), 'src/background')

/**
 * `index.ts` est exempté : c'est le point d'entrée, il n'a pas de logique temporelle propre et
 * il n'est appelé par aucun test — c'est lui qui fournit les dépendances par défaut aux autres.
 */
const EXEMPT = new Set(['index.ts'])

const files = readdirSync(BACKGROUND)
  .filter((f) => f.endsWith('.ts') && !EXEMPT.has(f))
  .map((f) => ({ name: f, text: readFileSync(join(BACKGROUND, f), 'utf8') }))

describe('MH-17 dans le service worker', () => {
  it('les fichiers de background existent (le test ne passe pas par le vide)', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  for (const { name, text } of files) {
    it(`${name} ne fige pas d’horloge au niveau du module`, () => {
      // On cherche l'affectation de portée module, pas l'usage : `deps.clock` et un paramètre
      // nommé `clock` sont exactement ce qu'on veut voir à la place.
      const pinned = /^const clock\s*=\s*systemClock/m.test(text)
      expect(
        pinned,
        `${name} déclare \`const clock = systemClock\` : passe par un objet de dépendances ` +
          'avec `systemClock` en valeur par défaut, comme les autres handlers.',
      ).toBe(false)
    })
  }

  it('les modules qui comparent des dates exposent des dépendances injectables', () => {
    // Un module qui appelle `clock.now()` et n'offre aucun moyen d'injecter l'horloge est
    // intestable sur sa logique temporelle — c'est-à-dire sur la seule chose qui peut être
    // subtilement fausse.
    const offenders: string[] = []
    for (const { name, text } of files) {
      if (!text.includes('.now()')) continue
      const injectable =
        /deps\s*:\s*\w*Deps/.test(text) ||
        /clock\s*:\s*Clock/.test(text) ||
        /clock\s*=\s*systemClock/.test(text)
      if (!injectable) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })
})
