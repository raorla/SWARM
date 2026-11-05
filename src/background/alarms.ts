/**
 * Alarmes — le seul mécanisme de réveil fiable en MV3.
 *
 * `setTimeout` meurt avec le service worker, donc tout ce qui doit se produire « plus
 * tard » passe par ici : cadence, mesure à J+1 et J+7, remise à zéro du budget, purge de
 * rétention.
 *
 * Chrome impose un minimum d'une minute par période. Les périodes ci-dessous sont plus
 * larges que nécessaire — un réveil qui ne sert à rien coûte de la batterie, et une
 * mesure faite dix minutes plus tard n'a aucune conséquence.
 */
import { createLogger } from '@/shared/logger'
import { purgeExpired } from '@/db/retention'
import { db } from '@/db'
import { ConfigRepo } from '@/db/repositories/config.repo'
import { runAnalystCycle } from './analyst.handler'
import { systemClock } from '@/shared/time'

const log = createLogger('background:alarms')

export const ALARM = {
  /** Fait avancer l'orchestrateur : scouting, qualification, mise en file. */
  TICK: 'swarm:tick',
  /** Mesure des actions publiées dont J+1 ou J+7 est échu. */
  MEASURE: 'swarm:measure',
  /** Purge de rétention (MH-13). */
  PURGE: 'swarm:purge',
  /** Resynchronisation du catalogue de prix (SPEC §3.2 règle 4). */
  PRICES: 'swarm:prices',
} as const

export function registerAlarms(): void {
  chrome.alarms.create(ALARM.TICK, { periodInMinutes: 5 })
  // Deux fois par jour suffit : la mesure est à J+1 et J+7, pas à la minute.
  chrome.alarms.create(ALARM.MEASURE, { periodInMinutes: 12 * 60 })
  chrome.alarms.create(ALARM.PURGE, { periodInMinutes: 24 * 60 })
  chrome.alarms.create(ALARM.PRICES, { periodInMinutes: 24 * 60 })
  log.info('alarmes enregistrées')
}

export async function handleAlarm(name: string): Promise<void> {
  switch (name) {
    case ALARM.TICK:
      // Phase 4 : envoi de l'événement TICK à l'orchestrateur XState.
      log.debug('tick')
      return
    case ALARM.MEASURE: {
      // Phase 5 : ANALYST. La mesure est passive (voir `analyst.handler.ts`) : ce réveil ne
      // navigue nulle part, il rapproche les relevés déjà collectés des mesures dues.
      const { measurement, patterns } = await runAnalystCycle()
      log.info('cycle ANALYST', {
        mesures: measurement.recorded,
        enAttenteDeReleve: measurement.awaitingSighting,
        digestModifie: patterns.changed,
      })
      return
    }
    case ALARM.PURGE: {
      const config = await new ConfigRepo(db(), systemClock).get()
      await purgeExpired(db(), systemClock, config.retentionDays)
      return
    }
    case ALARM.PRICES:
      // NON IMPLÉMENTÉ, et la conséquence est réelle : le catalogue de prix embarqué
      // vieillit en silence. Un tarif qui a changé fausse le compteur de budget dans le
      // sens qu'on ne contrôle pas — le plafond quotidien coupe trop tard. Le coût *réel*
      // de chaque appel, lui, reste lu dans la réponse du provider (SPEC §3.2 règle 4),
      // donc le total dépensé est juste ; c'est l'estimation a priori qui dérive.
      // À brancher sur https://openrouter.ai/api/v1/models — suivi dans TODO.
      log.debug('resynchronisation des prix due (handler absent)')
      return
    default:
      log.warn('alarme inconnue', { name })
  }
}
