/**
 * Étape 0 de l'onboarding — consentement (MH-12).
 *
 * ## Pourquoi cet écran bloque tout le reste
 *
 * `hasConsented()` garde les trois chemins qui dépensent ou agissent : le triage, la rédaction
 * depuis la file, la rédaction depuis l'overlay. Sans cet écran, l'extension se charge,
 * s'affiche, et refuse tout — c'était l'état avant ce fichier, et le symptôme était muet.
 *
 * ## Ce qu'il doit dire, et pourquoi c'est plus qu'une formalité
 *
 * L'utilisateur doit savoir **avant** de connecter son compte que l'automatisation
 * d'engagement sur X porte un risque, y compris en Copilote. Ce n'est pas une couverture
 * juridique : c'est la seule information qui puisse changer sa décision, et la lui donner après
 * la première réponse publiée serait la lui donner trop tard.
 *
 * Trois choix de conception :
 *
 *  1. **Le refus est possible et sans conséquence** — le bouton existe, il ferme l'écran et
 *     laisse l'extension inerte. Un consentement qu'on ne peut pas refuser n'en est pas un.
 *  2. **Une case à cocher, pas une phrase à recopier.** L'écran d'autopilote demande de
 *     recopier une phrase parce qu'il autorise une action à risque élevé ; ici on énonce le
 *     cadre d'un produit qui demande une validation humaine à chaque geste. Calibrer la
 *     friction sur le risque réel, sinon elle devient un réflexe partout.
 *  3. **Aucune promesse que le produit ne tient pas.** La liste des « ne fait pas » est
 *     vérifiable dans le code, et c'est elle qui porte la confiance.
 */
import { useCallback, useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'

export function Step0Consent({ onAccepted }: { onAccepted: () => void }): React.ReactElement {
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [declined, setDeclined] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const accept = useCallback(async () => {
    setBusy(true)
    const result = await send(MSG.CONSENT_ACCEPT, {})
    setBusy(false)
    if (!result.ok) {
      setError(describeSendError(result.error))
      return
    }
    onAccepted()
  }, [onAccepted])

  if (declined) {
    return (
      <div className="space-y-3 p-4">
        <h1 className="text-base font-medium">Rien n’a été activé.</h1>
        <p className="text-sm text-x-muted">
          SWARM reste inerte : il ne lit rien, ne rédige rien, ne dépense rien. Tu peux revenir
          sur cette décision en rouvrant ce panneau.
        </p>
        <button
          type="button"
          onClick={() => setDeclined(false)}
          className="text-xs text-x-muted underline hover:text-x-text"
        >
          revoir les conditions
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4 overflow-y-auto p-4">
      <header>
        <h1 className="text-base font-medium">Avant de commencer</h1>
        <p className="mt-1 text-xs text-x-muted">
          Trois choses à savoir. Elles changent peut-être ta décision, et c’est le moment.
        </p>
      </header>

      <section className="rounded-lg border border-x-warning/40 bg-x-warning/10 p-3">
        <h2 className="text-sm font-medium text-x-warning">
          1. Automatiser l’engagement sur X porte un risque
        </h2>
        <p className="mt-1 text-xs leading-relaxed">
          X encadre l’automatisation. Un compte qui répond de façon répétitive, trop vite ou en
          volume peut être limité ou suspendu — <strong>même avec validation humaine</strong>.
          SWARM applique des plafonds bas, une cadence humaine et des pauses, mais aucun réglage
          ne supprime ce risque. Tu en restes responsable.
        </p>
      </section>

      <section className="rounded-lg border border-x-border bg-x-surface p-3">
        <h2 className="text-sm font-medium">2. Ce que SWARM ne fait pas</h2>
        <ul className="mt-1 space-y-1 text-xs text-x-muted">
          <li>· Publier sans que tu cliques. Le code de publication automatique n’existe pas.</li>
          <li>· Envoyer un message privé. Les DM sont des brouillons, ouverts dans X.</li>
          <li>· Gérer plusieurs comptes, ou coordonner des comptes entre eux.</li>
          <li>· Répondre sur la santé, le deuil, la politique, une crise, un conseil financier.</li>
          <li>· Envoyer quoi que ce soit ailleurs que chez le fournisseur de modèle que tu choisis.</li>
          <li>· Collecter des statistiques d’usage. Il n’y a aucun serveur SWARM.</li>
        </ul>
      </section>

      <section className="rounded-lg border border-x-border bg-x-surface p-3">
        <h2 className="text-sm font-medium">3. Ce que ça coûte, et où</h2>
        <p className="mt-1 text-xs leading-relaxed text-x-muted">
          Tu fournis ta propre clé d’API. Compte environ <strong>1 €/jour</strong> en usage
          soutenu ; le plafond quotidien est dans l’extension et il coupe. Prends une clé
          dédiée avec une limite de dépense côté fournisseur — le chiffrement local protège du
          vol de ton profil Chrome, pas d’un attaquant qui contrôle déjà cette machine.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-x-muted">
          Tes données restent dans ce navigateur, et il n’y a{' '}
          <strong>aucune sauvegarde automatique</strong> : un profil Chrome perdu efface tout.
          L’onglet Config permet un export chiffré — utilise-le.
        </p>
      </section>

      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          J’ai lu ces trois points. Je comprends que mon compte X reste sous ma responsabilité,
          et que SWARM me demandera de valider chaque action.
        </span>
      </label>

      {error !== null && (
        <p className="text-xs text-x-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!checked || busy}
          onClick={() => void accept()}
          className="rounded-full bg-x-accent px-4 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          Activer SWARM
        </button>
        <button
          type="button"
          onClick={() => setDeclined(true)}
          className="rounded-full border border-x-border px-4 py-1.5 text-xs"
        >
          Pas maintenant
        </button>
      </div>

      <p className="text-[10px] text-x-muted">
        Détail des limites et des risques : <code>docs/risks-and-limits.md</code>. Ce que devient
        chaque donnée : <code>PRIVACY.md</code>.
      </p>
    </div>
  )
}
