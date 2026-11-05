/**
 * Choix du pack de niche.
 *
 * ## Pourquoi ce sélecteur existe alors que l'éditeur de pack n'existe pas
 *
 * Le pack actif par défaut est `generic`, volontairement restrictif. Trois packs sont livrés,
 * le QUALIFIER les applique, et **rien ne permettait d'en changer** : le compte pilote
 * @ACMECTO devait tourner sur un pack générique, ce qui aurait fait remonter un tri sans
 * rapport avec sa niche — et le diagnostic aurait été cherché du côté du scoring.
 *
 * Choisir parmi les packs livrés est trois lignes de code. Éditer les mots-clés, la watchlist et
 * les poids EV est un écran entier, et il n'est pas encore là. Livrer la première partie sans la
 * seconde n'est pas une demi-mesure : c'est la différence entre un produit utilisable sur sa
 * niche et un produit qui ne l'est pas.
 */
import { useCallback, useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'
import { bundledPacks } from '@/niches/loader'
import type { SettingsStatus } from '@/background/settings.handler'

export function NichePackPanel({
  status,
  onChanged,
}: {
  status: SettingsStatus | null
  onChanged: () => void
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Les packs livrés sont du JSON validé à l'import : aucun appel au service worker n'est
  // nécessaire pour les lister.
  const packs = bundledPacks()
  const activeId = status?.config.activeNichePackId ?? null
  const active = packs.find((p) => p.id === activeId) ?? null

  const choose = useCallback(
    async (id: string) => {
      setBusy(true)
      const result = await send(MSG.SETTINGS_UPDATE, { activeNichePackId: id })
      setBusy(false)
      if (!result.ok) {
        setError(describeSendError(result.error))
        return
      }
      setError(null)
      onChanged()
    },
    [onChanged],
  )

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <h2 className="text-sm font-medium">Pack de niche</h2>
      <p className="mt-1 text-xs text-x-muted">
        Le pack décide de ce qui est pertinent : mots-clés, sujets bloqués additionnels, angles
        autorisés, poids du score EV. Un score n’est comparable qu’à pack égal — changer de pack
        remet le classement à plat, il ne le corrige pas.
      </p>

      <label className="mt-3 block text-xs">
        Pack actif
        <select
          value={activeId ?? ''}
          disabled={busy || activeId === null}
          onChange={(e) => void choose(e.target.value)}
          className="mt-1 w-full rounded border border-x-border bg-x-bg px-2 py-1 text-sm"
        >
          {packs.map((pack) => (
            <option key={pack.id} value={pack.id}>
              {pack.label} — v{pack.version}
            </option>
          ))}
        </select>
      </label>

      {active !== null && (
        <div className="mt-2 space-y-1 text-[11px] text-x-muted">
          <p>{active.description || active.domainBrief.slice(0, 140)}</p>
          <p>
            {active.keywords.length} mots-clés · {active.watchlist.length} comptes suivis ·{' '}
            {active.additionalBlockedTopics.length} sujets bloqués en plus du noyau · seuil EV{' '}
            {(active.thresholds.minEvScore * 100).toFixed(0)} %
          </p>
        </div>
      )}

      {error !== null && (
        <p className="mt-2 text-xs text-x-danger" role="alert">
          {error}
        </p>
      )}

      <p className="mt-2 text-[10px] text-x-muted">
        L’édition d’un pack (mots-clés, watchlist, poids) et l’import de fichier arrivent plus
        tard. Les trois packs livrés sont modifiables dans <code>src/niches/packs/</code>.
      </p>
    </section>
  )
}
