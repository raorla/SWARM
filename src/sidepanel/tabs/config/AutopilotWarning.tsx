/**
 * Écran d'avertissement de l'autopilote — SPEC §2.2 et Phase 8.
 *
 * ## Pourquoi cet écran existe, et pourquoi il est écrit ainsi
 *
 * Le produit tout entier est construit pour être excellent en Copilote. L'autopilote existe
 * parce que le cahier des charges le demande, et cet écran est l'endroit où le produit dit
 * honnêtement ce qu'il en pense — sans manipuler, mais sans édulcorer.
 *
 * Trois choix de conception délibérés :
 *
 *  1. **Aucun bouton « activer » avant lecture complète.** Une case pré-cochée ou un bouton
 *     immédiatement cliquable rendrait l'avertissement décoratif.
 *  2. **L'utilisateur retape une phrase**, il ne coche pas. Cocher est un réflexe ; recopier
 *     demande de lire.
 *  3. **Le refus est le chemin par défaut.** Le bouton « Rester en Copilote » est le bouton
 *     principal, et c'est délibéré : c'est la recommandation du produit.
 *
 * Et une contrainte technique qui n'est pas négociable : `AUTOPILOT_IMPLEMENTED` est `false`,
 * donc **même après acceptation, rien ne s'active**. Le code de soumission n'existe pas
 * (SPEC §4.6). L'écran le dit plutôt que de le cacher derrière un réglage qui ne fait rien.
 */
import { useState } from 'react'
import { AUTOPILOT_IMPLEMENTED } from '@/shared/env'

/** Phrase à recopier. Elle énonce le risque, pas une formule d'acceptation. */
export const CONFIRMATION_PHRASE =
  'je comprends que publier automatiquement peut faire suspendre mon compte'

export function AutopilotWarning(props: {
  onDecline: () => void
  onAccept: () => void
}): React.ReactElement {
  const [typed, setTyped] = useState('')
  const [scrolledToEnd, setScrolledToEnd] = useState(false)

  const phraseMatches =
    typed.trim().toLowerCase().replace(/\s+/g, ' ') === CONFIRMATION_PHRASE

  return (
    <section className="space-y-3 rounded-lg border border-x-danger/40 bg-x-danger/5 p-3">
      <h3 className="text-xs font-semibold text-x-danger">Autopilote — à lire entièrement</h3>

      <div
        className="max-h-64 space-y-3 overflow-y-auto pr-1 text-[11px] leading-relaxed"
        onScroll={(event) => {
          const el = event.currentTarget
          // Marge de 8 px : un défilement au pixel près ne se termine jamais tout à fait.
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) setScrolledToEnd(true)
        }}
      >
        <p>
          <strong>X interdit l’automatisation de l’engagement.</strong> Publier des réponses par
          automatisation du DOM, à quelque cadence que ce soit, contrevient à ses règles.
          Aucune quantité de délais aléatoires ne rend cela conforme : le hasard rend un
          pattern plus difficile à détecter, pas plus légitime.
        </p>

        <p>
          Le risque concret est la <strong>suspension du compte</strong>. Il n’est pas
          hypothétique et il ne se répartit pas : c’est ton compte, pas une moyenne
          statistique.
        </p>

        <p>
          Si ta niche touche aux cryptomonnaies ou aux marchés, le risque est plus élevé
          encore. Les règles de X sur le <strong>spam financier</strong> sont appliquées plus
          durement que ses règles d’automatisation.
        </p>

        <p className="border-l-2 border-x-border pl-2">
          <strong>Ce que tu perds en passant en autopilote.</strong> Le taux d’abandon —
          combien de brouillons tu ne publies pas — est l’un des signaux d’apprentissage les
          plus utiles du produit : c’est ton désaccord silencieux avec l’agent critique. En
          autopilote, ce signal disparaît. Le système apprend donc moins bien, exactement au
          moment où il agit plus.
        </p>

        <p>
          <strong>Notre recommandation est le Copilote</strong>, et ce n’est pas une formalité
          juridique. Le produit est conçu pour te faire gagner du temps sur la lecture et la
          rédaction, pas sur la décision. La décision est ce qui garde tes réponses
          publiables.
        </p>

        {!AUTOPILOT_IMPLEMENTED && (
          <p className="rounded border border-x-warning/30 bg-x-warning/10 p-2 text-x-warning">
            <strong>En l’état, accepter ne change rien.</strong> Le code qui soumet un post
            n’existe pas dans cette version : ce n’est pas un réglage désactivé, c’est du code
            absent. Ton acceptation est enregistrée, l’autopilote reste inopérant.
          </p>
        )}
      </div>

      {!scrolledToEnd && (
        <p className="text-[10px] text-x-muted">
          Fais défiler jusqu’au bout pour continuer.
        </p>
      )}

      {scrolledToEnd && (
        <div className="space-y-2">
          <label className="block text-[10px] text-x-muted">
            Recopie cette phrase pour continuer :
            <span className="mt-0.5 block font-mono text-x-text/80">
              {CONFIRMATION_PHRASE}
            </span>
          </label>
          <input
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="w-full rounded border border-x-border bg-x-bg px-2 py-1.5 text-[12px]"
            aria-label="Phrase de confirmation"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {/* Le refus est le bouton principal : c'est la recommandation du produit. */}
        <button
          onClick={props.onDecline}
          className="rounded-full bg-x-accent px-3 py-1.5 text-[11px] font-semibold text-white"
        >
          Rester en Copilote
        </button>
        <button
          onClick={props.onAccept}
          disabled={!phraseMatches}
          className="rounded-full border border-x-danger/40 px-3 py-1.5 text-[11px] text-x-danger disabled:opacity-40"
        >
          J’accepte le risque
        </button>
      </div>
    </section>
  )
}

/**
 * Un consentement d'autopilote est-il valide ?
 *
 * Exporté et testé séparément : la validité ne doit pas dépendre de l'état d'un composant. Un
 * consentement enregistré sans phrase recopiée est un consentement qu'on n'a pas obtenu.
 */
export function isValidAutopilotConsent(record: {
  acceptedAtMs: number | null
  phraseTyped: string | null
}): boolean {
  if (record.acceptedAtMs === null) return false
  if (record.phraseTyped === null) return false
  return record.phraseTyped.trim().toLowerCase().replace(/\s+/g, ' ') === CONFIRMATION_PHRASE
}
