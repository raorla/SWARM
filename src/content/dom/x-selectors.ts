/**
 * SOURCE UNIQUE des sélecteurs DOM de X — SPEC §8.
 *
 * X modifie son DOM sans préavis, plusieurs fois par an. C'est **le** risque de
 * maintenance du produit, et il est traité comme tel :
 *
 *  1. Aucun sélecteur ailleurs dans le code. Une chaîne CSS hors de ce fichier est un bug
 *     de revue : au prochain changement de X, on ne saura pas où chercher.
 *  2. **Cascades ordonnées.** `data-testid` d'abord — c'est ce que X change le moins, parce
 *     que ses propres tests en dépendent. Puis les attributs sémantiques (`role`,
 *     `aria-label`), puis la structure. Jamais de classe CSS générée : elles changent à
 *     chaque déploiement.
 *  3. Chaque sélecteur déclare s'il est **requis**. Un sélecteur optionnel absent est
 *     normal (un post sans média n'a pas de nœud média) ; un sélecteur requis absent sur
 *     un conteneur trouvé est une rupture. C'est cette distinction qui évite les fausses
 *     alertes, et sans elle la détection de rupture serait du bruit qu'on finirait par
 *     ignorer.
 *
 * `scripts/check-selectors.ts` rejoue les fixtures de `tests/fixtures/x-dom/` en CI.
 */

export interface SelectorSpec {
  /** Identifiant stable, utilisé par la télémétrie de santé et les messages d'alerte. */
  readonly name: string
  /** Sélecteurs CSS, du plus fiable au plus fragile. Le premier qui matche gagne. */
  readonly candidates: readonly string[]
  /**
   * `true` : son absence sur un conteneur trouvé signale une rupture du DOM de X.
   * `false` : son absence est un état légitime du post.
   */
  readonly required: boolean
  /** Ce que ce sélecteur désigne, pour le message d'alerte adressé à l'utilisateur. */
  readonly describes: string
}

const spec = (
  name: string,
  describes: string,
  required: boolean,
  candidates: readonly string[],
): SelectorSpec => ({ name, describes, required, candidates })

/* ────────────────────────────── Conteneurs ───────────────────────────────── */

export const POST_CONTAINER = spec('post.container', 'un post dans le fil', true, [
  'article[data-testid="tweet"]',
  'article[role="article"]',
  '[data-testid="cellInnerDiv"] article',
])

export const TIMELINE = spec('timeline', 'le fil principal', true, [
  '[data-testid="primaryColumn"] [aria-label][role="region"]',
  '[data-testid="primaryColumn"]',
  'main[role="main"]',
])

/* ─────────────────────────────── Contenu du post ─────────────────────────── */

export const POST_TEXT = spec('post.text', 'le texte du post', true, [
  '[data-testid="tweetText"]',
  'div[lang][dir]',
])

export const POST_AUTHOR_BLOCK = spec('post.authorBlock', 'le bloc auteur', true, [
  '[data-testid="User-Name"]',
  '[data-testid="UserName"]',
])

/**
 * Le handle se lit dans le `href` du lien de profil, pas dans le texte : le texte peut
 * être un nom d'affichage traduit ou décoré, le href est canonique.
 */
export const POST_AUTHOR_LINK = spec(
  'post.authorLink',
  'le lien du profil auteur',
  true,
  [
    '[data-testid="User-Name"] a[href^="/"][role="link"]',
    'a[href^="/"][role="link"] time',
    'a[href^="/"][role="link"]',
  ],
)

export const POST_TIME = spec('post.time', "l'horodatage du post", true, [
  'time[datetime]',
  'a[href*="/status/"] time',
])

/** Le lien permanent porte l'identifiant du post : `/handle/status/1234…`. */
export const POST_PERMALINK = spec('post.permalink', 'le lien permanent', true, [
  'a[href*="/status/"]:has(time)',
  'a[href*="/status/"]',
])

export const POST_MEDIA = spec('post.media', 'un média joint', false, [
  '[data-testid="tweetPhoto"]',
  '[data-testid="videoPlayer"]',
  '[data-testid="card.wrapper"]',
  '[data-testid="previewInterstitial"]',
])

export const POST_QUOTE = spec('post.quote', 'un post cité', false, [
  '[role="link"][tabindex="0"] article',
  'div[id] > div > div[role="link"]',
])

/* ─────────────────────────── Barre d'actions et métriques ────────────────── */

export const ACTION_BAR = spec('post.actionBar', "la barre d'actions du post", true, [
  '[role="group"][aria-label]',
  '[role="group"]',
])

export const REPLY_BUTTON = spec('post.replyButton', 'le bouton Répondre', true, [
  '[data-testid="reply"]',
  'button[aria-label*="epl"]',
])

export const LIKE_BUTTON = spec('post.likeButton', "le bouton J'aime", false, [
  '[data-testid="like"]',
  '[data-testid="unlike"]',
])

export const REPOST_BUTTON = spec('post.repostButton', 'le bouton Repost', false, [
  '[data-testid="retweet"]',
  '[data-testid="unretweet"]',
])

/** Compteur visible à l'intérieur d'un bouton d'action. */
export const METRIC_TEXT = spec('post.metricText', 'un compteur de métrique', false, [
  '[data-testid="app-text-transition-container"]',
  'span[data-testid="app-text-transition-container"] span',
  'span',
])

/* ────────────────────────────── Composeur ────────────────────────────────── */

export const COMPOSER_EDITOR = spec('composer.editor', 'la zone de saisie', true, [
  '[data-testid="tweetTextarea_0"]',
  '[data-testid^="tweetTextarea_"]',
  '[role="textbox"][contenteditable="true"]',
])

export const COMPOSER_SUBMIT = spec('composer.submit', 'le bouton Publier', true, [
  '[data-testid="tweetButton"]',
  '[data-testid="tweetButtonInline"]',
])

export const COMPOSER_DIALOG = spec('composer.dialog', 'la fenêtre de rédaction', false, [
  '[aria-labelledby="modal-header"]',
  'div[role="dialog"]',
])

/* ──────────────────────── Identité de l'utilisateur ──────────────────────── */

/**
 * Bouton de compte de la barre latérale — porte le handle de l'utilisateur connecté.
 *
 * Sert au confort d'onboarding : proposer le handle plutôt que le faire saisir. On ne s'y
 * fie jamais seul (l'utilisateur confirme), parce qu'un handle mal détecté ferait collecter
 * le corpus de quelqu'un d'autre.
 */
export const SIDENAV_ACCOUNT = spec(
  'nav.accountSwitcher',
  'le bouton de compte de la barre latérale',
  false,
  [
    '[data-testid="SideNav_AccountSwitcher_Button"]',
    '[aria-label*="Account menu"]',
    '[data-testid="UserAvatar-Container-unknown"]',
  ],
)

/** Lien « Profil » de la barre latérale — second chemin vers le handle. */
export const SIDENAV_PROFILE_LINK = spec(
  'nav.profileLink',
  'le lien Profil de la barre latérale',
  false,
  [
    '[data-testid="AppTabBar_Profile_Link"]',
    'a[aria-label="Profile"]',
    'nav a[href^="/"][role="link"]',
  ],
)

/**
 * Bouton de fin de timeline de profil.
 *
 * X n'expose pas de marqueur « fin de liste ». On détecte la fin par absence de nouveaux
 * posts après plusieurs défilements, et on utilise ce sélecteur uniquement pour repérer un
 * blocage explicite (« Something went wrong », bouton Réessayer).
 */
export const RETRY_BUTTON = spec('timeline.retry', 'le bouton Réessayer du fil', false, [
  '[data-testid="TimelineRetryButton"]',
  'button[role="button"][aria-label*="etry"]',
])

/* ─────────────────────────────── Navigation ──────────────────────────────── */

export const TAB_LIST = spec('nav.tabList', 'les onglets du fil', false, [
  '[role="tablist"]',
])

export const ACTIVE_TAB = spec('nav.activeTab', "l'onglet actif", false, [
  '[role="tab"][aria-selected="true"]',
])

/**
 * Tous les sélecteurs, indexés par nom.
 *
 * Sert à deux choses : la vérification en CI (`scripts/check-selectors.ts`) et le
 * diagnostic dans l'onglet Config — l'utilisateur doit pouvoir voir *lequel* est cassé,
 * pas seulement « le parsing ne marche plus ».
 */
export const ALL_SELECTORS: readonly SelectorSpec[] = [
  SIDENAV_ACCOUNT,
  SIDENAV_PROFILE_LINK,
  RETRY_BUTTON,
  POST_CONTAINER,
  TIMELINE,
  POST_TEXT,
  POST_AUTHOR_BLOCK,
  POST_AUTHOR_LINK,
  POST_TIME,
  POST_PERMALINK,
  POST_MEDIA,
  POST_QUOTE,
  ACTION_BAR,
  REPLY_BUTTON,
  LIKE_BUTTON,
  REPOST_BUTTON,
  METRIC_TEXT,
  COMPOSER_EDITOR,
  COMPOSER_SUBMIT,
  COMPOSER_DIALOG,
  TAB_LIST,
  ACTIVE_TAB,
]

/** Sélecteurs dont la rupture rend le produit inopérant. */
export const CRITICAL_SELECTORS: readonly SelectorSpec[] = ALL_SELECTORS.filter(
  (s) => s.required,
)

/** Attribut posé sur les posts déjà traités — évite de les retraiter au scroll. */
export const PROCESSED_ATTR = 'data-swarm-seen'

/** Attribut de l'ancre d'overlay, pour la retrouver sans conserver de référence DOM. */
export const OVERLAY_ANCHOR_ATTR = 'data-swarm-anchor'
