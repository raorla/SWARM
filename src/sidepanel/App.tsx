/**
 * Coquille du side panel — quatre onglets (SPEC §6), derrière la porte de consentement.
 *
 * ## L'ordre compte, et il vient d'un défaut réel
 *
 * `hasConsented()` garde les trois chemins qui dépensent ou agissent. Tant que le
 * consentement n'est pas donné, les onglets s'affichent et **tout refuse** — c'était l'état
 * avant que cet écran existe, et le symptôme était muet : l'extension se chargeait
 * correctement et ne faisait rien, sans message.
 *
 * La porte passe donc avant les onglets, et l'état de chargement est distingué de l'état
 * « pas encore consenti » : afficher l'écran de consentement pendant qu'on lit la réponse du
 * service worker le ferait clignoter à chaque ouverture du panneau.
 */
import { useCallback, useEffect, useState } from 'react'
import { t } from '@/shared/i18n'
import { MSG } from '@/messaging/contract'
import { send } from '@/messaging/send'
import type { SettingsStatus } from '@/background/settings.handler'
import { SwarmTab } from './tabs/SwarmTab'
import { ConfigTab } from './tabs/config/ConfigTab'
import { FluxTab } from './tabs/flux/FluxTab'
import { AnalyticsTab } from './tabs/analytics/AnalyticsTab'
import { Step0Consent } from './onboarding/Step0Consent'

type TabId = 'flux' | 'swarm' | 'analytics' | 'config'

const TABS: readonly { id: TabId; labelKey: string }[] = [
  { id: 'flux', labelKey: 'tab.flux' },
  { id: 'swarm', labelKey: 'tab.swarm' },
  { id: 'analytics', labelKey: 'tab.analytics' },
  { id: 'config', labelKey: 'tab.config' },
]

type ConsentState = 'loading' | 'needed' | 'granted'

export default function App(): React.ReactElement {
  const [active, setActive] = useState<TabId>('swarm')
  const [consent, setConsent] = useState<ConsentState>('loading')

  const readConsent = useCallback(async () => {
    const result = await send(MSG.SETTINGS_STATUS, {})
    if (!result.ok) {
      // Le service worker peut dormir à l'ouverture du panneau : le message le réveille, et
      // le tour suivant aboutira. Montrer la porte ici la ferait clignoter.
      if (result.error.kind === 'no-receiver') {
        setTimeout(() => void readConsent(), 400)
      }
      return
    }
    const status = result.value as SettingsStatus
    setConsent(status.config.consentAcceptedAtMs === null ? 'needed' : 'granted')
  }, [])

  useEffect(() => {
    void readConsent()
  }, [readConsent])

  if (consent === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-x-bg text-x-text">
        <p className="text-xs text-x-muted">Lecture de la configuration…</p>
      </div>
    )
  }

  if (consent === 'needed') {
    return (
      <div className="flex h-full flex-col bg-x-bg text-x-text">
        <header className="flex items-center justify-between border-b border-x-border px-3 py-2">
          <span className="text-sm font-semibold tracking-wide">{t('app.name')}</span>
          <span className="text-[11px] text-x-muted">configuration initiale</span>
        </header>
        <Step0Consent onAccepted={() => setConsent('granted')} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-x-bg text-x-text">
      <header className="flex items-center justify-between border-b border-x-border px-3 py-2">
        <span className="text-sm font-semibold tracking-wide">{t('app.name')}</span>
        <span className="text-[11px] text-x-muted">Copilote</span>
      </header>

      <nav
        className="flex border-b border-x-border"
        role="tablist"
        aria-label={t('app.name')}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active === tab.id}
            aria-controls={`panel-${tab.id}`}
            id={`tab-${tab.id}`}
            onClick={() => setActive(tab.id)}
            className={`flex-1 px-2 py-2 text-xs transition-colors ${
              active === tab.id
                ? 'border-b-2 border-x-accent font-medium text-x-text'
                : 'text-x-muted hover:text-x-text'
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </nav>

      <main
        className="flex-1 overflow-y-auto"
        role="tabpanel"
        id={`panel-${active}`}
        aria-labelledby={`tab-${active}`}
      >
        {active === 'swarm' && <SwarmTab />}
        {active === 'flux' && <FluxTab />}
        {active === 'analytics' && <AnalyticsTab />}
        {active === 'config' && <ConfigTab />}
      </main>
    </div>
  )
}
