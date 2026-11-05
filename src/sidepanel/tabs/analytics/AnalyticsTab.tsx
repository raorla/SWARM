/**
 * Onglet Analytics — la boucle d'apprentissage, rendue lisible (Phase 5, SPEC §6).
 *
 * ## Le piège de cet écran
 *
 * Un tableau de bord d'analytics est l'endroit du produit où il est le plus facile d'afficher
 * des chiffres qui ne veulent rien dire. Trois règles, tenues par le code plutôt que par la
 * bonne volonté :
 *
 *  1. **Un chiffre non mesurable s'affiche « — », jamais zéro.** « 0 abonné attribué » et
 *     « aucun relevé d'abonnés » ne disent pas la même chose, et confondre les deux fait
 *     conclure à un échec là où il n'y a pas de mesure.
 *  2. **La couverture de mesure est affichée avant les patterns.** Un pattern calculé sur
 *     30 % des réponses n'est pas un pattern, c'est un échantillon de commodité. L'utilisateur
 *     doit voir la couverture avant de croire au classement.
 *  3. **Sous le seuil d'échantillon, l'écran dit qu'il ne sait pas.** C'est le comportement
 *     de `digestPatterns`, et l'UI ne le contourne pas.
 */
import { useCallback, useEffect, useState } from 'react'
import { MSG } from '@/messaging/contract'
import { describeSendError, send } from '@/messaging/send'
import type { AnalyticsSnapshot } from '@/background/analyst.handler'
import { MIN_SAMPLE_SIZE, type RankedPattern } from '@/analytics/aggregate'

const DIMENSION_LABEL: Record<string, string> = {
  angle: 'Angle',
  length: 'Longueur',
  hour: 'Heure',
  weekday: 'Jour',
  authorTier: 'Taille du compte',
}

export function AnalyticsTab(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const result = await send(MSG.ANALYTICS_STATE, {})
    setLoading(false)
    if (!result.ok) {
      if (result.error.kind !== 'no-receiver') setError(describeSendError(result.error))
      return
    }
    setError(null)
    setSnapshot(result.value as AnalyticsSnapshot)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (loading) {
    return <p className="p-3 text-sm text-x-muted">Lecture des mesures…</p>
  }

  if (error !== null) {
    return (
      <div className="p-3">
        <p className="text-sm text-x-danger">{error}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-2 rounded-full border border-x-border px-3 py-1 text-xs"
        >
          Réessayer
        </button>
      </div>
    )
  }

  if (!snapshot) return <p className="p-3 text-sm text-x-muted">Aucune donnée.</p>

  return (
    <div className="space-y-4 p-3">
      <Coverage snapshot={snapshot} />
      <Patterns snapshot={snapshot} />
      <Economics snapshot={snapshot} />
      <Governance snapshot={snapshot} />
    </div>
  )
}

/* ─────────────────────────── Couverture de mesure ─────────────────────────── */

function Coverage({ snapshot }: { snapshot: AnalyticsSnapshot }): React.ReactElement {
  const pct = Math.round(snapshot.measurementCoverage * 100)
  // Sous 60 %, le classement en dessous ne vaut pas la lecture. On le dit ici plutôt que de
  // laisser l'utilisateur tirer des conclusions d'un échantillon de commodité.
  const weak = snapshot.published > 0 && snapshot.measurementCoverage < 0.6

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <h2 className="text-[10px] uppercase tracking-wider text-x-muted">Couverture de mesure</h2>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {snapshot.published === 0 ? '—' : `${pct} %`}
      </p>
      <p className="mt-1 text-xs text-x-muted">
        {snapshot.measured} réponse{snapshot.measured > 1 ? 's' : ''} mesurée
        {snapshot.measured > 1 ? 's' : ''} sur {snapshot.published} publiée
        {snapshot.published > 1 ? 's' : ''}.
      </p>

      {snapshot.awaitingSighting > 0 && (
        <p className="mt-2 rounded border border-x-border bg-x-bg p-2 text-xs text-x-muted">
          {snapshot.awaitingSighting} mesure{snapshot.awaitingSighting > 1 ? 's' : ''} en
          attente d’un relevé. SWARM ne navigue pas seul : les métriques sont lues quand vous
          passez sur votre profil ou votre fil. Ouvrez votre profil pour les compléter.
        </p>
      )}

      {weak && (
        <p className="mt-2 text-xs text-x-warning">
          Couverture faible : le classement ci-dessous porte sur les réponses que vous avez
          revues, pas sur toutes. À lire comme une indication.
        </p>
      )}
    </section>
  )
}

/* ────────────────────────────────── Patterns ─────────────────────────────── */

function Patterns({ snapshot }: { snapshot: AnalyticsSnapshot }): React.ReactElement {
  const { digest } = snapshot

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <h2 className="text-[10px] uppercase tracking-wider text-x-muted">
        Ce que les mesures disent
      </h2>
      <p className="mt-1 text-sm">{snapshot.summary}</p>

      {digest.insufficient ? (
        <p className="mt-2 text-xs text-x-muted">
          Aucun pattern n’atteint {MIN_SAMPLE_SIZE} mesures. Les prompts n’affirment donc rien :
          rien n’est réinjecté tant que le signal n’est pas là. C’est voulu — apprendre de
          trois réponses ferait converger la rédaction sur du bruit.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <PatternList label="Ce qui marche" tone="success" items={digest.top} />
          <PatternList label="Ce qui ne marche pas" tone="danger" items={digest.flop} />
        </div>
      )}
    </section>
  )
}

function PatternList({
  label,
  tone,
  items,
}: {
  label: string
  tone: 'success' | 'danger'
  items: readonly RankedPattern[]
}): React.ReactElement | null {
  if (items.length === 0) return null
  const color = tone === 'success' ? 'text-x-success' : 'text-x-danger'

  return (
    <div>
      <h3 className="text-xs font-medium">{label}</h3>
      <ul className="mt-1 space-y-1">
        {items.map((item) => (
          <li
            key={`${item.dimension}:${item.value}`}
            className="flex items-baseline justify-between gap-2 text-xs"
          >
            <span className="truncate">
              <span className="text-x-muted">
                {DIMENSION_LABEL[item.dimension] ?? item.dimension}
              </span>{' '}
              {item.value}
            </span>
            <span className="shrink-0 tabular-nums">
              <span className={color}>
                {item.liftPct >= 0 ? '+' : ''}
                {item.liftPct.toFixed(0)} %
              </span>
              <span className="ml-2 text-x-muted">
                n={item.sampleSize} · conf. {(item.confidence * 100).toFixed(0)} %
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ────────────────────────────────── Économie ─────────────────────────────── */

function Economics({ snapshot }: { snapshot: AnalyticsSnapshot }): React.ReactElement {
  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <h2 className="text-[10px] uppercase tracking-wider text-x-muted">Coût</h2>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <Metric label="Dépensé au total" value={`${snapshot.totalCostEur.toFixed(3)} €`} />
        <Metric
          label="Par réponse publiée"
          value={
            snapshot.published === 0 ? '—' : `${snapshot.costPerPublishedEur.toFixed(4)} €`
          }
        />
      </dl>
      <p className="mt-2 text-xs text-x-muted">
        Le coût par abonné gagné n’est pas affiché : aucun relevé d’abonnés n’est collecté, donc
        l’attribution vaut zéro et le rapport serait une division par une mesure absente. Un
        chiffre faux est pire qu’un tiret.
      </p>
    </section>
  )
}

/* ───────────────────────────────── Gouvernance ───────────────────────────── */

function Governance({ snapshot }: { snapshot: AnalyticsSnapshot }): React.ReactElement {
  const veto = snapshot.vetoRate
  const abandon = snapshot.abandonRate

  // Un taux de veto extrême dit que le seuil est mal réglé, pas que les réponses sont
  // bonnes ou mauvaises. C'est l'usage réel de ce chiffre.
  const vetoNote =
    veto.sample < 10
      ? null
      : veto.rate > 0.8
        ? 'Le CRITIC refuse presque tout : le seuil est probablement trop haut, ou le Voice Profile trop mince.'
        : veto.rate < 0.05
          ? 'Le CRITIC ne refuse presque rien : à ce niveau il ne protège plus de rien.'
          : null

  return (
    <section className="rounded-lg border border-x-border bg-x-surface p-3">
      <h2 className="text-[10px] uppercase tracking-wider text-x-muted">Gouvernance</h2>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <Metric
          label="Veto du CRITIC"
          value={veto.sample === 0 ? '—' : `${(veto.rate * 100).toFixed(0)} %`}
          hint={veto.sample === 0 ? 'aucun brouillon' : `n=${veto.sample}`}
        />
        <Metric
          label="Abandon après mise en scène"
          value={abandon.sample === 0 ? '—' : `${(abandon.rate * 100).toFixed(0)} %`}
          hint={abandon.sample === 0 ? 'aucune mise en scène' : `n=${abandon.sample}`}
        />
      </dl>
      {vetoNote !== null && <p className="mt-2 text-xs text-x-warning">{vetoNote}</p>}
      <p className="mt-2 text-xs text-x-muted">
        Un abandon n’est pas un échec : c’est votre désaccord avec le CRITIC, et il est mesuré
        comme tel.
      </p>
    </section>
  )
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}): React.ReactElement {
  return (
    <div>
      <dt className="text-x-muted">{label}</dt>
      <dd className="mt-0.5 text-base font-medium tabular-nums">
        {value}
        {hint !== undefined && <span className="ml-1 text-[10px] text-x-muted">{hint}</span>}
      </dd>
    </div>
  )
}
