/**
 * Onglet Config.
 *
 * Ordre des sections choisi sur le parcours réel d'un nouvel utilisateur : sans clé, rien ne
 * fonctionne ; sans voix, le WRITER écrit comme un assistant ; les plafonds ont des défauts
 * corrects et peuvent attendre ; la sauvegarde n'a de sens qu'une fois qu'il y a quelque chose
 * à perdre.
 *
 * Le pack de niche est **choisissable** mais pas éditable : le sélecteur est trois lignes, un
 * éditeur de mots-clés et de poids est un écran entier. Sans le sélecteur, le compte pilote
 * tournait sur le pack `generic` sans moyen d'en changer, ce qui rendait tout le tri hors sujet
 * — et aurait fait chercher le problème dans le scoring.
 */
import { useCallback, useEffect, useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'
import type { SettingsStatus } from '@/background/settings.handler'
import { VoiceProfilePanel } from './VoiceProfilePanel'
import { ProviderPanel } from './ProviderPanel'
import { GuardrailsPanel } from './GuardrailsPanel'
import { BackupPanel } from './BackupPanel'
import { NichePackPanel } from './NichePackPanel'

export function ConfigTab(): React.ReactElement {
  const [status, setStatus] = useState<SettingsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await send(MSG.SETTINGS_STATUS, {})
    if (!result.ok) {
      if (result.error.kind !== 'no-receiver') setError(describeSendError(result.error))
      return
    }
    setError(null)
    setStatus(result.value as SettingsStatus)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="space-y-3 p-3">
      {error !== null && (
        <p className="rounded border border-x-danger p-2 text-xs text-x-danger" role="alert">
          {error}
        </p>
      )}

      <ProviderPanel status={status} onChanged={() => void refresh()} />
      <NichePackPanel status={status} onChanged={() => void refresh()} />
      <VoiceProfilePanel />
      <GuardrailsPanel status={status} onChanged={() => void refresh()} />
      <BackupPanel />
    </div>
  )
}
