/**
 * Lit l'état du swarm depuis le service worker.
 *
 * Le point délicat : le service worker peut être endormi quand le panel s'ouvre. Un
 * `no-receiver` n'est donc pas une erreur à afficher, c'est un état transitoire — le
 * premier message le réveille. Traiter les deux cas de la même façon afficherait une
 * erreur rouge à chaque ouverture du panel.
 */
import { useCallback, useEffect, useState } from 'react'
import { MSG, SwarmStateSchema, type SwarmState } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'

export interface SwarmStateHook {
  state: SwarmState | null
  error: string | null
  loading: boolean
  refresh: () => Promise<void>
}

const POLL_MS = 3_000

export function useSwarmState(): SwarmStateHook {
  const [state, setState] = useState<SwarmState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const result = await send(MSG.SWARM_STATE, {
      mode: 'copilot',
      pipelineState: 'idle',
      governanceState: 'nominal',
      activeAgent: null,
      spentTodayEur: 0,
      budgetEur: 0,
      queueLength: 0,
      caps: {},
    })
    setLoading(false)

    if (!result.ok) {
      // Un worker endormi se réveille au message suivant : le tour de scrutin suivant
      // aboutira. Ne pas alarmer l'utilisateur pour ça.
      if (result.error.kind === 'no-receiver') return
      setError(describeSendError(result.error))
      return
    }
    const parsed = SwarmStateSchema.safeParse(result.value)
    if (!parsed.success) {
      setError('état du swarm illisible')
      return
    }
    setError(null)
    setState(parsed.data)
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { state, error, loading, refresh }
}
