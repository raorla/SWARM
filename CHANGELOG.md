# CHANGELOG

Une entrée par phase de livraison. Format : ce qui est livré · décisions techniques
prises · ce qui reste ouvert.

## [Première installation dans Chrome] — 2026-08-26

1 013 tests. Trois défauts, et le premier est le plus grave du projet.

### L'extension était intégralement inerte

Installée dans Chrome, elle se chargeait, affichait son side panel, et laissait **tous** les
messages expirer. Le panel restait indéfiniment sur « Lecture de la configuration… ». Aucune
erreur, aucun log.

`chrome.runtime.onMessage.hasListeners()` renvoyait `false` dans le worker. En suivant le graphe
d'imports du bundle : `service-worker-loader.js` importait le chunk du **content script**. Le
service worker exécutait le code du scout, qui n'enregistre aucun écouteur de message.

La cause : le point d'entrée s'appelait `src/background/index.ts`, le content script
`src/content/index.ts`, et **@crxjs indexe ses entrées par nom de base**. Renommé en
`service-worker.ts`. Deux gardes ajoutées, parce qu'un nom de fichier se renomme sans y penser :
un test qui suit le graphe du bundle et vérifie que l'écouteur y est — et que le code du content
script n'y est pas — plus le même contrôle dans `build-zip.ts`.

**1 000 tests passaient.** Ils testent le code, qui était juste ; le défaut était dans
l'assemblage, et rien ne regardait l'assemblage. Même leçon que les mesures réelles de la veille,
appliquée au build : vérifier l'artefact, pas seulement les sources.

### Pas d'import dynamique dans un service worker

La première correction chargeait les handlers à la demande. Vite entoure chaque `import()` d'un
helper de préchargement qui insère un `<link>` et écoute `window` : dans un worker, chaque
handler échouait sur « document is not defined ». Imports statiques, donc — le motif standard en
MV3 — et `modulePreload: false`, qui supprime au passage les avertissements
« cross-world extension resource mismatch » des pages d'extension.

Gardé de l'intention initiale : les écouteurs s'enregistrent au niveau supérieur, sans `await`
avant. MV3 ne réveille le worker que si l'écouteur a été ajouté pendant l'évaluation initiale —
un `await` plus haut et les alarmes ne réveillent plus rien, donc la mesure J+1/J+7 et la purge
s'arrêtent sans erreur.

Ajouté : un fil d'Ariane de démarrage dans `chrome.storage.local`. Une exception pendant
l'évaluation du module d'un worker disparaît ; ce marqueur transforme « rien ne répond » en
« le module s'est arrêté à telle étape ».

### Le consentement était impossible à accorder

`hasConsented()` gardait le triage et les deux chemins de rédaction, et **rien n'appelait
`acceptConsent()`** : MH-12 nommait l'écran, il n'avait jamais été écrit. Une installation neuve
affichait ses quatre onglets et refusait tout, en silence.

`Step0Consent.tsx` énonce trois choses avant les onglets — le risque de suspension même en
Copilote, ce que le produit ne fait pas, ce que ça coûte et où. Le refus est possible et sans
conséquence. Une case à cocher, pas une phrase à recopier : la friction se calibre sur le risque,
et recopier une phrase reste réservé à l'autopilote.

L'E2E parcourt désormais la **première ouverture complète** : porte de consentement, refus,
retour, acceptation, cockpit, puis écran de configuration. C'est le seul test de la suite qui
vérifie que le produit est *atteignable*, et pas seulement correct.

### Ouvert

- L'installation manuelle est prête à tester. Ce qui n'est pas encore parcouru dans un vrai
  navigateur : la saisie de clé et le premier appel LLM depuis le panel, la collecte du corpus
  sur un profil réel, la mise en scène d'un brouillon dans le composeur de X.
- Icônes toujours des placeholders.

## [Mesures réelles] — première clé API · 2026-08-26

1 000 tests. Trois points bloqués depuis la Phase 0 sont mesurés et clos ; quatre défauts
trouvés en une heure, dont trois rendaient le produit hors budget ou inutilisable.

### Ce que ces mesures ont coûté et rapporté

Coût total : **0,19 €** de crédit OpenRouter. Ce qu'elles ont montré, aucun test à réponse
factice ne pouvait le voir — et le trait commun des quatre défauts est qu'**aucun ne provoquait
d'erreur**. Le produit tournait, la suite était verte.

### R-03 est confirmé

Le cache de prompt passe bien à travers OpenRouter : préfixe de 1 764 tokens, **3 135 tokens
lus depuis le cache** au second appel, facturés à 10 %. Le chiffrage à 1 €/jour tient et la
bifurcation vers Anthropic direct n'est pas nécessaire.

Nuance qui n'était pas dans l'hypothèse : le cache **ne s'applique pas au QUALIFIER**, dont le
préfixe (~1 400 tokens) est sous le minimum de Haiku. Le DoD tient sans lui, mais le tenir pour
acquis ferait sous-estimer le coût du triage de moitié.

### Le cache multipliait la facture estimée par dix

Les deux API comptent à l'envers l'une de l'autre : `input_tokens` d'Anthropic **exclut** les
tokens cachés, `prompt_tokens` d'OpenRouter les **inclut**. Notre calcul facturait donc les
tokens cachés deux fois, dont une au plein tarif : **0,0096 € au lieu de 0,0010 €** sur un appel
très caché.

Le coût réel facturé par le provider était juste ; c'est notre estimation qui dérivait — donc le
plafond quotidien coupait après un dixième du budget. Le produit s'arrêtait en croyant avoir
dépensé son euro.

### Le DoD de la Phase 3 était manqué, pour deux raisons empilées

200 posts coûtaient **0,065 €** au lieu de 0,05 €, avec trois lots sur quatre en échec.

**`effort: 'low'` n'économise pas, il dépense.** Sur un modèle à raisonnement étendu, un effort
— même « low » — *active* la réflexion, facturée en sortie au tarif le plus cher. Les lots
étaient tronqués avant le premier verdict. Trier n'est pas raisonner : c'est classer cinquante
fois de suite sur un critère écrit dans le prompt. `effort` est désormais optionnel dans
`RouteConfig` — il était obligatoire, ce qui forçait à choisir un niveau là où le bon choix est
« aucun ».

**Les noms de clés coûtaient plus que les données.** La sortie objet pesait ~54 tokens par
verdict, moitié en clés répétées cinquante fois par lot. Le format est devenu un tuple,
`["0",0.9,"data"]`, et `note` est omise par défaut.

Résultat : **10,2 tokens par verdict, 200/200 verdicts, zéro échec, zéro réparation, 0,025 €** —
DoD atteint avec une marge de 2. Le chiffrage d'origine supposait 25 tokens par verdict : il
était faux dans les deux sens.

### Une troncature n'est plus prise pour un JSON illisible

Une réponse coupée par `max_tokens` **est** un JSON invalide, et les confondre envoie chercher
le bug dans le parseur alors que le correctif est le plafond de sortie. Nouveau `kind`
`truncated`, sur les deux providers (`finish_reason: 'length'` chez OpenRouter,
`stop_reason: 'max_tokens'` chez Anthropic), **non réessayable** — le même appel tronquerait au
même endroit.

### Le seuil de veto du CRITIC était trop haut

Calibré sur les 18 réponses étiquetées : le CRITIC discrimine nettement — 0,30 à 0,65 pour les
bonnes, 0,00 à 0,20 pour les mauvaises, aucun faux positif. Mais à **0,60, l'ancien défaut, le
rappel tombe de 83 % à 17 %** : cinq bonnes réponses sur six rejetées.

C'est le scénario que D-11 anticipait, et il serait passé pour un problème de rédaction — aucune
erreur, juste un produit qui refuse tout. Le défaut passe à **0,45**, le milieu du plateau et
non son bord : `calibrate()` recommandait le seuil le plus sévère à score égal, ce qui plaçait
la recommandation à un pas d'une falaise.

### Un `.env`, et trois gardes pour qu'il n'atteigne jamais le bundle

Vite expose au client **toute** variable `VITE_*` : nommer la clé `VITE_OPENROUTER_KEY` —
réflexe naturel — l'inlinerait dans `dist/`, puis dans le zip, puis au Chrome Web Store, sans
qu'aucune erreur ne se produise. Les tests vérifient qu'aucune variable `VITE_` n'existe, que
`src/` ne lit que `MODE`, que `dist/` ne contient aucun motif de clé, et que `.env` est ignoré
par git.

Les mesures tournent via Vitest (`vitest.live.config.ts`) et non via `node` : les modules de
`src/` utilisent l'alias `@/`, que le résolveur ESM de Node ne suit pas. Elles s'exécutent donc
contre le vrai code de production, et `npm run test` reste hermétique et gratuit.

### Un défaut trouvé par le changement de date

`voice-profile.handler.ts` figeait `systemClock` au niveau du module, alors que les autres
handlers avaient été corrigés (MH-17) : la péremption du profil se calculait avec l'heure réelle
contre un `builtAtMs` écrit avec l'horloge injectée. Le test qui aurait dû le voir passait parce
que sa date simulée valait la date du jour — il a échoué le lendemain, en ayant l'air d'un test
instable. Un bug réel déguisé en bruit de suite.

Corrigé, plus deux autres modules qui figeaient leur horloge, plus un test structurel qui
échoue si un module du service worker recommence.

### Ouvert

- La couverture du blind test et la journée réelle restent bloquées sur des humains et un
  compte, pas sur une clé.
- L'attribution d'abonnés reste inerte : elle demande un sélecteur sur le DOM de profil (R-10).
- 18 échantillons de calibration, c'est indicatif. Cible : 40+.

## [Phases 4 à 8] — Governor, ANALYST, mémoire, backtest, threads, packaging

953 tests, verts. 6 E2E. Build sans avertissement, zip conforme.

### Trois défauts trouvés en branchant les pièces entre elles

Chacun était invisible en test unitaire, parce que chaque pièce prise séparément était juste.
C'est le mode de défaillance propre à cette phase : ce qui casse est le raccordement.

**1. Le coffre ne pouvait pas rester déverrouillé.** `buildKeystore()` reconstruisait un
keystore verrouillé à chaque appel et le clair ne vivait que dans l'objet. En MV3 le service
worker meurt après ~30 s : un déverrouillage fait dans le side panel n'existait donc plus au
message suivant. Le produit pouvait demander la passphrase indéfiniment sans jamais réussir un
appel LLM — un chemin **inatteignable**, pas fragile. Corrigé par un cache de session
(`chrome.storage.session` : en mémoire, jamais sur le disque, effacé à la fermeture du
navigateur), TTL 8 h, bouton de verrouillage immédiat. La passphrase, elle, n'est stockée nulle
part, et un test vérifie qu'elle n'apparaît jamais dans le cache. Le coût de sécurité de ce
choix est écrit dans FEEDBACK D-13 plutôt que passé sous silence.

**2. Le journal d'audit ne pouvait pas se vérifier.** `hashEntry()` hachait l'objet entier, or
Dexie ajoute une clé primaire `id` à la ligne relue : le hash recalculé n'était jamais celui
écrit, et `verifyChain()` déclarait la chaîne **rompue à la première entrée, toujours**. Le
journal « inaltérable » était invérifiable en production, et seuls les tests en mémoire
passaient. Corrigé par une liste fermée de champs de contenu (`HASHED_FIELDS`), avec un test qui
échoue si un champ est ajouté à `AuditEntry` sans être ajouté à la liste — sinon il serait
modifiable en base sans que rien ne bronche. Découvert en écrivant l'écran qui affiche le
journal : c'est le premier endroit où la vérification devenait visible, ce qui est aussi
l'argument pour l'afficher.

**3. La boucle d'apprentissage n'était appelée par personne.** `src/analytics/` savait mesurer,
attribuer et agréger ; l'alarme `MEASURE` loggait « mesure due » et retournait. La Phase 5
était donc du code juste et mort — la panne la plus discrète possible, puisque tous ses tests
passaient. `background/analyst.handler.ts` fait le raccordement.

### Ce qui manquait pour que le produit démarre

Le keystore chiffré, le routage de modèles, le compteur de budget et les plafonds
fonctionnaient tous, et **rien ne permettait de saisir une clé**. L'onglet Config a maintenant
quatre écrans réels : provider et clé (avec la permission d'hôte demandée depuis le clic, seul
endroit où Chrome l'accepte), Voice Profile, plafonds et cadence, sauvegarde chiffrée.

Le principe des réglages : **on peut resserrer, jamais desserrer**. Les bornes sont appliquées
côté service worker, pas dans l'attribut `max` d'un `<input>` — qui est une indication, pas un
contrôle. `follow` et `dm` restent à zéro quoi qu'on envoie, et le passage en autopilote est
refusé par le contrat du message : il a son écran de consentement, en faire un champ de réglage
ordinaire serait un contournement.

### La mesure est passive, et le dit

Mesurer un post à J+1 par le chemin évident — ouvrir son URL dans un onglet, lire, fermer —
serait exactement l'automatisation que le produit refuse, et le signal le plus visible côté X.
Les métriques sont donc relevées **quand l'utilisateur passe sur son profil ou son fil**, avec
une fenêtre de tolérance par échéance : un relevé de J+4 ne mesure pas J+1, et accepter les deux
fabriquerait des patterns à partir d'un écart de calendrier.

Conséquence assumée : la couverture est partielle. L'onglet Analytics l'affiche **avant** le
classement des patterns et prévient sous 60 % — un pattern calculé sur une couverture inconnue
n'est pas un pattern. L'attribution d'abonnés vaut zéro faute de relevés, donc le coût par
abonné gagné n'est pas affiché du tout : un chiffre faux est pire qu'un tiret.

### Threads et médias

Le composeur de threads découpe aux frontières de sens — paragraphes, puis phrases — et
**refuse** plutôt que de couper un mot : un thread coupé au caractère ne se lit pas post par
post, ce qui annule l'intérêt du format. L'A/B de hooks est structurel : il pénalise les
ouvertures qui annoncent au lieu de dire, les marqueurs de thread, le format « N leçons », et
ne recommande **rien** quand l'écart entre variantes est du bruit.

Les images sont un **brief**, pas une génération (D-12) : à 1 €/jour, deux images mangeraient
le budget de qualification de la journée. Le brief impose la liste des chiffres présents dans le
brouillon et interdit tout autre chiffre — un graphique inventé publié depuis un compte de
projet est un mensonge, pas une maladresse.

### Autopilote : livré comme une absence

`AutopilotWarning.tsx` demande de défiler jusqu'au bout, de recopier une phrase qui **nomme la
conséquence** (« peut faire suspendre mon compte »), et met le refus en bouton principal. Il dit
aussi que l'accepter ne change rien, parce que le code de soumission automatique n'existe pas :
`AUTOPILOT_IMPLEMENTED === false` est asserté par un test. Ce n'est pas un réglage désactivé,
c'est du code absent.

### Packaging

Deux gardes ajoutées après avoir constaté le problème :

- `npm run zip` **refusait** de voir qu'il empaquetait le build E2E. Un `npm run e2e` suivi d'un
  `npm run zip` produisait une extension qui s'injecte dans `localhost:4319`. La garde contrôle
  les **cibles d'injection** et non la présence du mot « localhost » — première version, qui
  refusait à tort `optional_host_permissions: http://localhost/*`, légitime pour le provider
  local.
- `tests/unit/security/egress.test.ts` lit les sources et refuse toute primitive réseau hors de
  `src/llm/`, tout SDK de télémétrie, tout hôte inattendu, et toute URL interpolant un secret.
  « Zéro donnée sortant du navigateur » est écrit dans `PRIVACY.md` et attesté au Chrome Web
  Store : une promesse de ce genre ne se tient pas par relecture.

`docs/chrome-web-store.md` contient la fiche, les divulgations et la revue de conformité, y
compris les quatre points qui demandent un arbitrage humain — dont le nom « SWARM », qui évoque
dans ce contexte la coordination de comptes, exactement ce que le produit refuse de faire.

### Ouvert

- Les acteurs de l'orchestrateur XState ne sont pas branchés au service worker (D-15) : le
  Copilote n'a pas de boucle autonome à faire avancer. À faire avec la journée réelle, qui est
  aussi le DoD de la Phase 4.
- La détection d'abandon (MH-09) attend une règle décidée sur données réelles.
- Le relevé du nombre d'abonnés demande une fixture capturée sur le DOM de profil (R-10).
- Le modèle ONNX (MH-01), l'onboarding, les UI de packs, de threads et de backtest : voir TODO.

## [Phase 3] — QUALIFIER + file d'opportunités · code livré, mesure réelle à faire

703 tests, verts **avec et sans instrumentation de couverture**. 6 E2E. Build et zip OK.

### La décision de conception qui compte

La spec écrit `EV = portée × pertinence × fraîcheur × (1/saturation) × affinité`. Un produit
de cinq facteurs dans [0, 1] s'écrase vers zéro : cinq facteurs à 0,6 donneraient 0,078, et le
classement perdrait sa résolution là où se trouve la majorité des posts.

On applique donc une **moyenne géométrique pondérée**. Elle conserve la propriété essentielle
du produit — un facteur nul annule tout, donc un post hors niche à portée immense vaut zéro —
tout en gardant le résultat à l'échelle des facteurs : cinq facteurs à 0,6 donnent 0,6.

Deux corollaires que le code applique :

- **La période de refroidissement d'affinité annule le score.** Vingt heures après avoir
  répondu à un compte, son affinité tombe à zéro, donc l'EV tombe à zéro, donc l'opportunité
  sort de la file. C'est ce facteur — et non un plafond — qui empêche le produit de devenir un
  reply guy sur trois comptes.
- **Le facteur limitant n'est pas le plus faible**, c'est celui au plus fort déficit *pondéré*.
  C'est la réponse à « pourquoi ce score est-il si bas ? », qui n'est pas la même question que
  « quel facteur est le plus faible ».

### Ce qui rend l'économie du produit tenable

Le QUALIFIER est précédé d'une **chaîne de filtres gratuits** : posts déjà vus, posts propres,
auteurs exclus, langue non gérée, périmés, saturés, sujets interdits (MH-02), posts trop courts.
Sur une timeline réelle, elle écarte la majorité du lot pour zéro euro. Chaque filtre est testé
séparément, et un test vérifie qu'un lot entièrement filtré ne déclenche **aucun** appel.

Le reste part au modèle par lots de 50, avec un préfixe cachable et une sortie minimale — `note`
bornée à 40 caractères. Le modèle ne calcule ni portée, ni fraîcheur, ni saturation : le code les
mesure exactement à partir des métriques du DOM, et il le fait mieux qu'une estimation.

**Le DoD est asserté en CI.** `tests/unit/swarm/qualifier.test.ts` échoue si le prompt s'allonge,
si la sortie grossit ou si la taille des lots baisse. Un test montre aussi que la **sortie
domine le coût** — Haiku facture la sortie cinq fois l'entrée : un champ libre de 400 caractères
au lieu de 40 tuerait le DoD sans que rien d'autre ne change.

### L'onglet Flux

Une carte à la fois, pas une liste : une liste invite à parcourir, le produit veut une décision
par opportunité. Tout au clavier — `A` rédiger, `E` consigne, `R` rejeter, `Espace` suivant,
plus `J`/`K`, `O`, `D`, `?`, `Échap`. L'aide est **générée depuis la table de raccourcis**, donc
toujours exacte.

Les raccourcis sont **inertes dans toute zone de saisie** — `input`, `textarea`, `select`,
`contenteditable`, `role="textbox"`. Avec des raccourcis d'une lettre, taper « rejeter » dans une
note rejetterait l'opportunité à la lettre `r` ; chaque type de champ est testé séparément.

L'écran de file vide **distingue quatre causes** — rien de trié, budget épuisé, seuils trop
stricts, rien d'intéressant — au lieu de les confondre. Les confondre ferait chercher un bug là
où il y a un réglage.

### Un défaut de conception corrigé

Les handlers du service worker figeaient `systemClock` au niveau du module. Tout le triage dépend
du temps — fraîcheur, expiration, refroidissement d'affinité — et un handler qui fige son horloge
est un handler qu'on ne peut pas tester sur ces règles. C'est exactement ce que MH-17 veut éviter,
et la règle n'avait été appliquée qu'au code métier, pas au background. L'horloge y est désormais
injectable, avec `systemClock` par défaut.

### Deux tests de performance rendus honnêtes

Le fichier de performance a échoué deux fois pour des raisons sans rapport avec le produit : une
fois sous la suite complète, une fois sous `--coverage` (V8 ralentit l'exécution de trois à cinq
fois). Un test de performance instable finit désactivé, ce qui est pire qu'aucun test.

Il mesure désormais deux propriétés **insensibles à l'environnement** : la **linéarité** du coût
de parsing — le vrai risque est un comportement quadratique, pas trois millisecondes — et
l'invariant de l'ordonnanceur avec un coût par élément **simulé**. Les valeurs absolues sont
mesurées là où elles ont un sens : dans un vrai navigateur, par l'E2E qui relève la latence du
fil principal pendant un défilement.

Défaut de harnais également corrigé : les bases de test étaient toutes nommées à partir de
`opened.length`, qui retombe à zéro après chaque test — donc tous les tests rouvraient la même
base, et `fake-indexeddb` faisait courir la suppression de l'une avec l'ouverture de la suivante.

### Ouvert

- La mesure réelle du DoD (200 posts sur appels réels) demande une clé API.
- **R-03** reste le point à trancher : sans propagation du prompt caching par OpenRouter, le
  chiffrage change pour WRITER et CRITIC — le triage, lui, tient même sans cache.
- L'onglet Analytics et la boucle d'apprentissage sont la Phase 5.

## [Phase 2.10] — Finition de la Phase 2

571 tests. Ce qui restait de la Phase 2, sauf ce qui demande une clé API ou des humains.

**Collecte du corpus** — `own-identity.ts` détecte le handle par deux chemins (le `href` du
lien de profil est canonique, le texte du bouton de compte est le repli) et expose
`isOwnProfilePage()`, qui est le garde du collecteur. `collect-own-posts.ts` parcourt le
profil sous **cinq bornes indépendantes** — quota, défilements, durée, détection de fin,
interruption — chacune testée séparément parce qu'une seule borne se contourne toujours par
un cas limite. Le profil visé est vérifié **à chaque tour de boucle**, pas seulement à
l'entrée : une navigation en cours de collecte l'arrête net.

**Calibration** — `calibrate.ts` balaie les seuils sur un jeu étiqueté et recommande une
valeur mesurée. Trois choix de conception : les **faux positifs pèsent trois fois** les faux
négatifs (publier une mauvaise réponse est irréversible, en rater une bonne coûte une
occasion) ; les **seuils absurdes sont refusés** (rejeter 98 % obtient un excellent score et
rend le produit inutile) ; et une **notation dégénérée est détectée** avant de faire
confiance au seuil — le mode de défaillance le plus courant d'un juge LLM n'est pas de se
tromper, c'est de tout noter entre 0,7 et 0,8.

`labelled-set.memecoin.ts` fournit 19 réponses étiquetées à la main, couvrant les quatre
familles de défaut qu'un générateur produit spontanément, et **majoritairement des rejets** :
un jeu majoritairement bon ferait paraître excellent un seuil laxiste.

**Péremption du profil** — un profil vieilli est plus dangereux qu'un profil absent : le
produit croit connaître un style qui a changé. Trois causes détectées : l'âge (30 jours), les
nouveaux posts accumulés (40), le changement de handle — qui invalide tout, puisque ce n'est
plus la même personne.

**Onglet Config** — le panneau Voice Profile affiche `guardExcludedRatio` en avertissement au
delà de 50 %. C'est le seul endroit où ce champ devient actionnable : sans lui, l'utilisateur
attribuerait au CRITIC des rejets qui viennent de son corpus.

### Un vrai bug, trouvé par un test de collecte

`logNormalDelay` renvoyait un **flottant**. Toute horloge avancée de cette valeur devenait
fractionnaire, et `observedAtMs` échouait alors sa validation `int` — très loin de la cause.
Un vrai `Date.now()` est toujours entier ; `FakeClock.advance` arrondit désormais aussi, pour
qu'une horloge de test ne masque pas exactement les bugs qu'on cherche.

---

## [Phase 2] — Voice Profile + WRITER + CRITIC · code livré, blind test à passer

`npm run check` vert : **lint + typecheck + 507 tests + vérification des sélecteurs**.
`npm run e2e` vert : 6 tests dans un vrai Chromium.

### Le constat qui a changé le design

Le compte pilote **@ACMECTO** est un compte de **projet** ($acme, Solana), pas un
compte personnel. Sa voix native est promotionnelle : « maximum potential », « from microcap
to legendary », adresses de contrat — soit exactement ce que le noyau MH-02 bloque.

Un Voice Profile extrait naïvement de ce corpus aurait encodé le registre promotionnel comme
« la voix de l'utilisateur ». Le WRITER aurait appris à shiller, le CRITIC aurait rejeté
100 % de ses variantes, et le produit serait mort-né sur son propre compte pilote — en
donnant l'impression que le CRITIC est mal calibré alors qu'il aurait fait son travail.

D'où **MH-18** : le Voice Profile sépare la **forme** du **registre**.

| | Extrait du corpus | Reproduit par le WRITER |
|---|---|---|
| Forme — longueur, rythme, ponctuation, retours à la ligne, emojis, tics | corpus **entier** | oui |
| Registre — exemples canoniques, règles `do` | corpus **assaini** | seulement ce qui passe le garde-fou |

Sans cette séparation, le Voice Profile serait le canal par lequel le contenu interdit rentre
dans le produit — non pas malgré les garde-fous, mais *à travers* eux, sous l'étiquette
« c'est le style de l'utilisateur ». C'est le contournement le plus naturel et le moins
visible du noyau MH-02, et il n'aurait été découvert qu'en Phase 5. Quatre tests le figent.

### Livré

**Protocole du blind test** — préenregistré dans `docs/blind-test-protocol.md` avant toute
production de variante : 10 paires, 3 juges, réponse forcée, seuil ≤ 60 %, ordre A/B tiré au
sort avec graine consignée. Le fichier dit aussi ce que le test **ne** mesure pas — il mesure
l'indiscernabilité, pas la qualité. R-02 clôturée.

**Corpus** — table `ownPosts`, migration v2, repository qui **qualifie à l'écriture** : le
Voice Profile relit la qualification des dizaines de fois, le classifieur n'a pas à tourner
en boucle. `requalify()` pour quand les règles changent.

**Voice Profile** — 25 statistiques de forme sans un seul appel LLM (elles doivent rester
calculables budget épuisé), tics de langage à fenêtre variable, sélection d'exemples
canoniques par proximité au centre statistique et **non par engagement** — trier par likes
biaiserait le profil vers un registre qui a marché une fois. Indice de confiance calculé sur
le corpus **assaini**, et `guardExcludedRatio` exposé comme diagnostic honnête.

**Distance de voix** — le signal quotidien entre deux blind tests, avec la propriété qui fait
tout le travail : chaque dimension déclare si elle est **applicable**. Une réponse de 12 mots
ne se compare pas à un profil de posts de 40 mots sur la longueur médiane ; les dimensions
non applicables sont écartées du calcul, pas notées à zéro. Sans cette règle, le CRITIC
rejetterait les bonnes réponses courtes.

**Socle d'agents** — `defineAgent` centralise le chargement du prompt, la validation et la
trace. Chaque agent n'écrit que ses messages et son interprétation ; la trace est identique
par construction, seul moyen fiable de garantir qu'aucun agent ne l'oublie.

**WRITER** — trois variantes, **trois angles distincts** et non trois reformulations
(`angleDiversity` mesure et remonte au CRITIC). Profil faible annoncé au modèle plutôt que
tu : un modèle qui ne sait pas qu'il n'a pas de profil en invente un.

**CRITIC** — droit de veto réel, et trois choix qui portent sa qualité : le **seuil est
appliqué en code** (un juge LLM dit `pass` en donnant 0,4 ; le désaccord est tracé, pas
résolu en sa faveur), le **risque réputationnel a son propre plafond** (une moyenne
masquerait le cas « excellente partout, risquée sur un point »), et la **distance de voix est
calculée mécaniquement** plutôt que laissée à son appréciation.

**Chaîne** — WRITER → CRITIC, trace consolidée, hash combiné (MH-04). Le coût est remonté
**même en cas de veto** : un veto a coûté deux appels, et ne compter que les succès
fausserait le coût par follower gagné. Un CRITIC en panne **rejette** au lieu de laisser
passer : « échouer ouvert » serait ici le pire choix possible.

**QUICK-REPLY conservé** derrière `config.draftMode`. C'est la seule façon de mesurer ce que
la Phase 2 apporte : le supprimer rendrait « le swarm fait mieux que la génération one-shot »
invérifiable, et c'est la thèse du produit.

**Overlay** — onglets de variantes, notation du CRITIC visible, écart de forme, coût du refus
affiché, navigation clavier `1`–`3` et `Échap`. Les touches sont inertes dans la zone de
saisie : taper « 2 » dans le brouillon ne doit pas changer de variante.

### Défauts trouvés par les tests

- L'extraction d'ouvertures récurrentes utilisait une fenêtre fixe de trois mots, ce qui
  ratait tous les tics d'un seul mot — les plus courants. Fenêtre variable de 1 à 3, avec
  déduplication par préfixe.
- Le test de pondération de la distance était confondu par la longueur : ajouter un emoji
  change aussi le nombre de caractères. On inspecte désormais la contribution de la dimension.

### Ouvert

- Le **parcours de collecte** du profil reste à écrire. La persistance et l'extraction sont
  prêtes ; le corpus se remplit passivement via `isOwnPost` en attendant.
- La **calibration** du seuil de veto : `calibrationStats()` existe, le jeu de fixtures de
  réponses bonnes et mauvaises reste à constituer.
- **R-03** (prompt caching via OpenRouter) : un test chiffre l'écart, la mesure réelle demande
  une clé.
- Le **blind test** lui-même. Avec une réserve honnête : le corpus assaini de @ACMECTO
  pourrait être trop mince pour constituer 10 paires. Ce serait un résultat, pas un échec
  technique — et le protocole le dit d'avance.

## [Phase 1] — Scout + Overlay · code livré, DoD à valider sur un vrai compte

`npm run check` vert : **lint + typecheck + 394 tests + vérification des sélecteurs**.
`npm run e2e` vert : **6 tests dans un vrai Chromium**, extension chargée en MV3.

### Livré

**Sélecteurs DOM** — `x-selectors.ts` comme source unique, 19 sélecteurs en cascades
ordonnées (`data-testid` d'abord), chacun déclarant s'il est requis. `query.ts` résout les
cascades et alimente la télémétrie. `selector-health.ts` distingue une absence normale d'une
rupture (seuil d'échecs consécutifs, période de silence). `snapshot-on-break.ts` capture un
fragment DOM anonymisé (MH-14), avec un garde de sortie testé qui refuse toute donnée
identifiante.

**SCOUT** — `IntersectionObserver` pour ne lire que ce qui est réellement entré dans le
viewport, `MutationObserver` pour suivre la virtualisation du fil, détection de navigation
SPA. Travail découpé en tranches avec budget par frame, seau à jetons pour le débit, mise en
lots pour ne pas réveiller le service worker à chaque post. `/messages` n'est pas observé du
tout — ne pas lire est plus fort que filtrer ce qu'on a lu.

**Overlay** — bouton discret sous chaque post, fiche de rédaction en Shadow DOM, en DOM
natif plutôt qu'en React (le poids embarqué dans le content script est payé par le scroll de
X). Le bouton d'action s'appelle « Ouvrir dans le composeur », jamais « Publier ».

**ACTUATOR** — `stage-draft.ts` écrit dans le composeur par trois méthodes en cascade
(`execCommand`, événement `paste`, écriture directe) et **vérifie** que le texte a survécu au
rendu suivant. Sans cette vérification, un échec silencieux de l'éditeur laisserait croire
que le brouillon est prêt, et ferait enregistrer une action inexistante.

**Prompts versionnés** (MH-04) — `.md` en Git, assemblés avec les garde-fous partagés,
hachés en SHA-256. Le hash traverse jusqu'à l'action.

**Agent QUICK-REPLY** — génération one-shot, délibérément ce que fait la concurrence. Elle
atteint le DoD de la phase et sert de **référence de comparaison** pour les Phases 2 à 5 :
sans point de comparaison, « le swarm fait mieux » serait invérifiable.

**Handler côté service worker** — garde-fous ordonnés : consentement, coffre, topic-guard,
budget. La cadence n'est **pas** vérifiée : l'utilisateur a cliqué, il attend une réponse ;
la cadence protège du rythme automatique, pas de l'intention humaine.

**Outillage de test** — 8 fixtures DOM, serveur de fixtures pour un E2E déterministe sans
compte X, `check-selectors.ts` en CI avec une attente déclarée par fixture, E2E séparé en
`local/` (CI) et `live/` (garde `SWARM_E2E_LIVE=1`).

### Trois décisions corrigées par les tests, pas par relecture

Détail dans `FEEDBACK.md` partie B bis (D-08 à D-10).

- **Shadow DOM `closed` → `open`.** `closed` n'apportait aucune sécurité réelle — il
  n'empêche pas x.com de retirer notre nœud — mais rendait l'overlay **intestable** en E2E et
  gênait l'accessibilité. Découvert par un test qui ne trouvait pas son propre bouton.
- **`queryAll` : premier candidat → union dédupliquée.** X déploie son DOM
  progressivement ; « premier candidat gagnant » aurait ignoré la moitié de la timeline en
  silence, sans déclencher aucune alerte.
- **Mesure de fluidité : FPS → latence du fil principal.** `requestAnimationFrame` est bridé
  dans un onglet non visible : le test mesurait le navigateur, pas le produit.

### Autres défauts trouvés par les tests

- `SlicedQueue` se replanifiait indéfiniment quand l'ordonnanceur n'accordait aucun budget —
  gaspillage en production, débordement de pile en test. Borné à trois tranches sans progrès.
- Le motif de deuil ne reconnaissait que « perdu », pas « perdre » à l'infinitif.
- L'heuristique de sujet de pack comptait les apostrophes comme des mots significatifs.
- Le repli par événement `paste` échouait entièrement si `DataTransfer` n'était pas
  constructible ; il se replie maintenant sur un objet minimal.

### Nettoyage de fond

Les espaces insécables littéraux dans les expressions régulières ont été remplacés par des
échappements. Un caractère invisible dans du code source est illisible et se supprime par
accident — le test qui les couvre les construit désormais par code point, pour ne pas
réintroduire le même piège dans sa propre source.

### Ouvert

Le DoD complet — « répondre à un vrai post sur x.com » — demande une clé API et un compte.
Le parcours est écrit dans `tests/e2e/live/reply-on-x.spec.ts` et s'exécute avec
`SWARM_E2E_LIVE=1`. La mesure de **R-03** (prompt caching à travers OpenRouter) reste le
point à trancher le plus tôt : tout le chiffrage à 1 €/jour en dépend.

## [Phase 0] — Fondations · code livré, DoD à valider dans Chrome

`npm run check` vert : **lint + typecheck + 232 tests**. `npm run build` produit un
`dist/` chargeable, `npm run zip` un paquet CWS. Couverture du `governor` : **100 % des
lignes, 92 % des branches** (seuil CI à 90 %).

### Livré

**Outillage** — Vite 8 + `@crxjs/vite-plugin` 2.7, TypeScript strict
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, zéro `any`), Tailwind 4,
Vitest 4 + `fake-indexeddb`, ESLint 10 avec trois règles qui portent des invariants
produit et non du style.

**Socle partagé** — `Result<T, E>` aux frontières, horloge et RNG injectables (MH-17),
logger à redaction (MH-08), i18n FR/EN (MH-11), helpers Zod de frontière.

**Manifest MV3** — 7 permissions justifiées une par une, 3 optionnelles, providers en
`optional_host_permissions` demandés au runtime, CSP `wasm-unsafe-eval`, kill switch au
clavier. `api.twitter.com` retiré (décision D-04).

**Messagerie** — union discriminée validée par Zod aux deux bouts, avec les trois pièges
MV3 traités : destinataire endormi, contexte invalidé, handler qui oublie de répondre.

**Persistance** — 12 tables Dexie, migrations versionnées, `idempotencyKey` unique en
base (MH-07), export chiffré (MH-06), purge de rétention (MH-13).

**Niche Pack** (MH-10) — schéma Zod, 3 packs livrés (`memecoin`, `saas-b2b`, `generic`),
test d'agnosticisme bloquant.

**Adaptateur LLM** — 3 providers (OpenRouter par défaut, Anthropic direct, endpoint
local), keystore AES-GCM/PBKDF2, prix synchronisables, budget segmenté avec réserve
qualité (MH-05), retry classifié (MH-16), réparation de JSON en trois temps.

**Governor** — `requestPermit()` unique porte d'entrée, `StagePermit` en type marqué,
plafonds, cadence log-normale, fenêtres et jours off, kill switch persisté (MH-03),
topic-guard à noyau non désactivable (MH-02), audit à hash chaîné.

**Contextes** — service worker sans état en mémoire, offscreen document, content script
avec double garde, side panel React 4 onglets avec cockpit et test de connexion LLM.

### Décisions techniques

Les quatre validées par l'utilisateur et les 17 must-have ajoutés sont dans `FEEDBACK.md`.
Trois écarts à la spec d'origine, consignés en D-05 à D-07 : React 19 au lieu de 18,
Tailwind 4 en configuration CSS-first, Zod 4.

Deux décisions prises en cours de route et documentées dans le code :

- **`StagePermit` est un type marqué.** L'invariant « rien n'agit sans permis » n'est plus
  une convention de revue : un objet littéral ne satisfait pas le type, donc contourner le
  governor ne compile pas.
- **L'offscreen document a une entrée Rollup explicite.** Il est créé au runtime, donc
  aucun `import` ne le référence et le bundler ne le voyait pas. `scripts/build-zip.ts`
  vérifie désormais sa présence, parce que l'échec se manifestait sinon par un 404 à
  l'exécution, difficile à relier à sa cause.

### Trois bugs trouvés par les tests, pas par la relecture

- `newInstallSeed()` produisait une graine de **longueur variable** — `toString(16)`
  perdait les zéros de tête.
- `ConfigRepo.update()` ne protégeait `installSeed` **qu'au typage**. Un objet venu d'un
  `JSON.parse` (import de config, restauration) passait au travers et changeait les jours
  off d'une installation existante.
- L'heuristique de sujet de pack comptait les apostrophes comme des mots significatifs,
  gonflait le denominateur et ratait son propre seuil.

### Limite documentée plutôt que masquée

Le `topic-guard` ne fait pas de morphologie : « doxxent » n'est pas reconnu comme une forme
de « doxxing ». Un test nommé `LIMITE CONNUE` le fige explicitement. Le classifieur LLM de
la Phase 3 traitera les cas limites **en plus** de celui-ci, jamais à sa place — un
garde-fou qui dépend d'un appel réseau et d'un budget n'est pas un garde-fou.

### Reste ouvert

Trois points du DoD demandent le navigateur et une clé API réelle : chargement de
l'extension en mode développeur, appel LLM de test, et la mesure qui tranche **R-03** —
la propagation du prompt caching à travers OpenRouter, dont dépend tout le chiffrage à
1 €/jour. Le bouton est dans l'onglet Swarm ; il affiche `cacheRead` en évidence pour ça.

Le reste est dans `FEEDBACK.md` partie D.
