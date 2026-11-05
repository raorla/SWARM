# TODO — SWARM

Convention : `[ ]` à faire · `[x]` fait · `[~]` en cours · `[!]` bloqué (raison entre parenthèses)
Chaque phase se termine par son DoD vérifié. On ne passe pas à la suivante sans validation.

---

## Phase 0 — Fondations  `[~]` — code livré, DoD à valider dans Chrome

**DoD** : l'extension charge · le side panel s'ouvre · un appel LLM de test passe et
débite le compteur de budget · plafonds et cadence couverts unitairement.

### 0.1 Outillage
- [x] `git init`, arborescence complète
- [x] `SPEC.md`, `FEEDBACK.md`, `TODO.md`
- [x] `package.json`, dépendances, scripts npm
- [x] TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- [x] Vite + `@crxjs/vite-plugin`
- [x] Tailwind + thème sombre cohérent X
- [x] Vitest + `fake-indexeddb`
- [x] ESLint : interdiction de `Date.now()` / `Math.random()` dans `src/` (MH-17)
- [x] `.gitignore`, `.prettierrc`
- [x] `README.md`, `PRIVACY.md`, `CHANGELOG.md`
- [x] `docs/architecture.md`, `docs/risks-and-limits.md`, `docs/adr/`

### 0.2 Socle partagé
- [x] `shared/result.ts` — `Result<T, E>`, pas d'exception aux frontières
- [x] `shared/time.ts` — horloge injectable (MH-17)
- [x] `shared/rng.ts` — RNG seedable, log-normal (MH-17)
- [x] `shared/logger.ts` — redaction des secrets (MH-08)
- [x] `shared/env.ts` — `MODE`, dry-run par défaut en dev (MH-15)
- [x] `shared/i18n.ts` — FR + EN (MH-11)
- [x] `shared/zod-helpers.ts`

### 0.3 Manifest MV3
- [x] `manifest.config.ts` typé, permissions justifiées une par une
- [x] Side panel, service worker, content script, offscreen déclarés
- [x] `commands` : kill switch `Alt+Shift+K`, panel `Alt+Shift+S`
- [x] CSP avec `wasm-unsafe-eval`
- [x] `optional_host_permissions` par provider, demandés au runtime

### 0.4 Messagerie inter-contextes
- [x] `messaging/contract.ts` — union discriminée, Zod aux deux bouts
- [x] `messaging/send.ts` / `listen.ts` — typés, timeout, erreurs structurées
- [x] Test : un message malformé est rejeté, pas propagé

### 0.5 Persistance
- [x] `db/schema.ts` — les 12 tables de SPEC §5
- [x] `db/migrations/001-initial.ts` + registre de migrations
- [~] `db/repositories/` — `config.repo.ts` et `action.repo.ts` faits ; les autres au fil des phases
- [x] `db/backup.ts` — export/import chiffré (MH-06)
- [x] `db/retention.ts` — purge à 30 jours (MH-13)
- [x] Index unique sur `actions.idempotencyKey` (MH-07)
- [x] Test : migration d'une base v1 vide, round-trip d'export

### 0.6 Niche Pack (MH-10)
- [x] `niches/pack.schema.ts` — schéma Zod
- [x] `niches/loader.ts` — import/export/validation
- [x] `niches/packs/memecoin.pack.json`
- [x] `niches/packs/saas-b2b.pack.json`
- [x] `niches/packs/generic.pack.json`
- [x] Test d'agnosticisme bloquant : le même code tourne sur les trois packs

### 0.7 Adaptateur LLM
- [x] `llm/types.ts` — requête/réponse/usage unifiés
- [x] `llm/errors.ts` — classification retryable / non-retryable (MH-16)
- [x] `llm/retry.ts` — backoff exponentiel + jitter, chaîne de repli (MH-16)
- [x] `llm/json-repair.ts` — retry → réparation → fallback (SPEC §8)
- [x] `llm/keystore.ts` — AES-GCM + PBKDF2, clés jamais loggées
- [x] `llm/pricing.ts` — synchronisé depuis le catalogue OpenRouter
- [x] `llm/budget.ts` — compteur lisant `usage`, réserve 25 % (MH-05)
- [x] `llm/providers/openrouter.ts` (défaut)
- [x] `llm/providers/anthropic.ts` (repli direct pour le caching — R-03)
- [x] `llm/providers/openai-compatible.ts` (Ollama / LM Studio)
- [x] `llm/router.ts` — modèle par agent, escalade Opus sur le top-10 EV
- [x] `llm/client.ts` — façade, seule autorisée à sortir du navigateur
- [x] Test : usage réel débite le compteur, budget épuisé bloque l'appel
- [!] **Mesurer `cache_read_input_tokens` via OpenRouter** → tranche R-03 *(nécessite une clé API réelle — bouton « Lancer » dans l'onglet Swarm)*

### 0.8 Governor
- [x] `governor/caps.ts` — plafonds durs, compteurs journaliers
- [x] `governor/cadence.ts` — délais log-normaux 4–18 min
- [x] `governor/windows.ts` — fenêtres actives, pause nocturne, jours off
- [x] `governor/killswitch.ts` — persisté (MH-03)
- [x] `governor/topic-guard.ts` — noyau universel non désactivable (MH-02)
- [x] `governor/audit.ts` — append-only, hash chaîné
- [x] `governor/index.ts` — `requestPermit()`, `StagePermit` type opaque
- [x] Tests : plafonds, cadence sur horloge simulée, fenêtres, kill switch, topic-guard

### 0.9 Contextes d'extension
- [x] `background/index.ts` + `router.ts` + `lifecycle.ts` + `alarms.ts`
- [x] `offscreen/index.html` + stub
- [x] `content/index.ts` — stub avec garde d'invalidation de contexte
- [x] `sidepanel/` — coquille React 4 onglets + écran de test LLM

### 0.10 Vérification du DoD
- [x] `npm run build` produit un `dist/` chargeable
- [!] Extension chargée en mode développeur, side panel ouvert *(à faire côté navigateur)*
- [!] Appel LLM test réussi, coût affiché *(nécessite une clé API réelle)*
- [x] `npm test` vert
- [x] `CHANGELOG.md` de la phase rédigé

### 0.11 Ajouts non prévus, faits pendant la construction
- [x] `governor/types.ts` — `StagePermit` en type marqué : contourner le governor ne compile pas
- [x] `background/services.ts` — reconstruction des services à chaque réveil du worker
- [x] `background/offscreen.ts` — création idempotente de l'offscreen document
- [x] `scripts/build-zip.ts` — vérifie que chaque chemin déclaré au manifest existe dans le bundle
- [x] Entrée Rollup explicite pour l'offscreen (créé au runtime, donc invisible pour le bundler)
- [x] `tests/setup.ts` — double de l'API `chrome` + `fake-indexeddb`
- [x] Seuil de couverture CI à 90 % sur `src/governor/**` (atteint : 100 % lignes, 92 % branches)

---

## Phase 1 — Scout + Overlay  `[~]` — code livré, DoD à valider sur un vrai compte
**DoD** : je peux répondre à un post avec l'IA sans quitter X.

- [x] `content/dom/x-selectors.ts` — source unique, fallbacks en cascade
- [x] `content/dom/selector-health.ts` — détection de rupture + alerte
- [x] `content/dom/snapshot-on-break.ts` — fixture anonymisée (MH-14)
- [x] `content/dom/dom-schemas.ts` — Zod du DOM parsé
- [x] `content/scout/observer.ts` — Mutation + Intersection
- [x] `content/scout/extract-post.ts` — DOM → `PostSnapshot`
- [x] `content/scout/feed-router.ts` — timeline / search / notifs / bookmarks
- [x] `content/scout/throttle.ts` — débit borné, backpressure
- [x] `content/overlay/` — Shadow DOM, bouton sous chaque post
- [x] `content/actuator/stage-draft.ts` — écrit dans le composeur, ne soumet jamais
- [x] Fixtures DOM + tests de parsing
- [x] Test de performance : pas de dégradation du FPS de scroll
- [x] E2E Playwright : overlay bout-en-bout

### 1.11 Ajouts non prévus, faits pendant la construction
- [x] `content/dom/query.ts` — résolveur de cascade avec télémétrie ; union dédupliquée
      des candidats pour couvrir un déploiement progressif de X
- [x] `swarm/prompts/` + registre à hachage de version (MH-04), utilisé dès la Phase 1
- [x] `swarm/agents/quick-reply.ts` — génération one-shot, référence de comparaison
      pour les Phases 2 à 5
- [x] `background/quick-reply.handler.ts` — garde-fous ordonnés côté service worker
- [x] `background/selector-alerts.ts` — persistance + notification + repli sur badge
- [x] `scripts/check-selectors.ts` — vérification en CI, une attente déclarée par fixture
- [x] `scripts/serve-fixtures.mjs` — E2E déterministe sans compte X ni réseau
- [x] Cible E2E `localhost:4319` dans le manifest, absente de tout build de production
- [x] Séparation E2E `local/` (CI) et `live/` (garde `SWARM_E2E_LIVE=1`)

### 1.12 Vérification du DoD
- [x] `npm run check` vert : lint + typecheck + 394 tests + vérification des sélecteurs
- [x] `npm run e2e` vert : 6 tests dans un vrai Chromium
- [!] Répondre à un vrai post sur x.com *(nécessite une clé API et un compte — `tests/e2e/live/`)*

## Phase 2 — Voice Profile + WRITER + CRITIC  `[~]` — code livré, blind test à passer

**DoD** : les réponses sont indiscernables de mon style sur un blind test de 10 exemples.

**Ordre imposé** : 2.0 avant tout le reste. Le protocole du blind test doit être figé
*avant* d'écrire la première ligne de code, sinon on ajuste la cible aux résultats obtenus
et le DoD ne mesure plus rien.

---

### 2.0 Figer le protocole du blind test  `[x]` — préenregistré dans [`docs/blind-test-protocol.md`](./docs/blind-test-protocol.md)

Réserve R-02 : le DoD tel qu'écrit dans la spec n'a pas de protocole, donc n'est pas
mesurable. Proposition à valider :

- [x] **Matériel** : 10 paires. Chaque paire = un vrai post de l'utilisateur + une variante
      SWARM produite sur le *même* sujet, dans le même format et la même longueur cible.
- [x] **Juges** : 3 personnes qui ne savent pas laquelle est laquelle, et qui ne sont pas
      l'utilisateur (il reconnaîtra toujours ses propres posts).
- [x] **Tâche du juge** : pour chaque paire, désigner celui qui est écrit par l'humain.
- [x] **Seuil de succès** : ≤ 60 % d'identifications correctes sur les 30 jugements
      (50 % = hasard pur, 100 % = échec total).
- [x] **Préenregistrement** : le protocole, le seuil et les 10 sujets sont écrits dans
      `docs/blind-test-<date>.md` **avant** de produire les variantes.
- [x] **Trace** : jugements bruts et calcul consignés dans le même fichier. Un DoD dont on
      ne peut pas relire la mesure n'est pas un DoD.
- [x] Clôturer R-02 dans `FEEDBACK.md` une fois le protocole validé.

**Friction assumée** : mobiliser 3 juges à chaque itération est impraticable. D'où 2.3, une
métrique automatique qui sert de signal quotidien. Le blind test reste la porte, pas le
tableau de bord.

---

### 2.1 Collecte des posts de l'utilisateur  `[x]`

- [x] Handle connu : **@ACMECTO** (D-11). Stocké dans `config.ownHandle`.
- [x] Détection automatique depuis le DOM comme confort d'onboarding — nouveau sélecteur
      dans `x-selectors.ts` + fixture. Non bloquant : la valeur est déjà connue.
- [ ] `content/scout/collect-own-posts.ts` — parcours **explicitement déclenché** du profil
      de l'utilisateur, borné, avec progression visible.
- [x] Garde-fou : le parcours ne fonctionne que sur le profil de l'utilisateur lui-même,
      vérifié contre le handle configuré. Refus explicite sur tout autre profil.
- [x] Table `ownPosts` + **migration v2** (`db/migrations/002-own-posts.ts`).
- [x] `db/repositories/own-post.repo.ts`.
- [x] Réutiliser le marqueur `isOwnPost` déjà produit par l'extraction (Phase 1) pour
      compléter le corpus au fil de la navigation normale, sans parcours dédié.
- [x] Tests : borne de parcours respectée, refus sur un profil tiers, déduplication.

> **Décision à documenter** : collecter 200 posts demande de faire défiler un profil, ce qui
> frotte contre « pas de scroll infini automatisé » (SPEC §4.1). L'arbitrage retenu : c'est
> une action **ponctuelle, explicitement demandée, bornée, sur son propre profil**, avec
> progression affichée. Ce n'est pas de la collecte de masse en arrière-plan, et la
> distinction doit être écrite dans `docs/risks-and-limits.md`.

---

### 2.2 Extraction du Voice Profile  `[x]`

**Aucun appel LLM pour les statistiques.** Elles sont déterministes, gratuites, et doivent
rester calculables quand le budget est épuisé — même raisonnement que MH-01.

- [x] `memory/voice-profile.ts` — extraction depuis le corpus.
- [x] Statistiques de forme : longueur moyenne et médiane, phrases par post, taux d'emoji et
      inventaire des emojis employés, taux de question, taux d'exclamation, taux de
      majuscule initiale, taux de minuscule initiale, taux de lien, taux de hashtag, taux de
      mention, profil de ponctuation (tiret cadratin, points de suspension, point-virgule),
      taux de retour à la ligne interne.
- [x] Statistiques de registre : richesse lexicale (ratio type/occurrence), longueur moyenne
      des mots, taux de contractions, taux de familiarité, langues employées et leur part.
- [x] **Tics de langage** : n-grammes les plus fréquents et ouvertures de phrase récurrentes.
      C'est le signal le plus discriminant et le plus facile à rater.
- [x] Sujets récurrents.
- [x] **Sélection des exemples canoniques** : les plus proches du centre statistique **et**
      divers en registre — pas les plus likés. Trier par engagement biaiserait le profil vers
      un seul registre, celui qui a marché une fois.
- [x] Règles do/don't : dérivées des statistiques, un seul appel LLM pour les formuler.
- [x] **Indice de confiance** exposé, fonction de la taille du corpus. Sous ~50 posts,
      l'imitation est faible : le profil doit le dire, et le CRITIC doit devenir plus sévère
      plutôt que le produit prétendre savoir écrire comme l'utilisateur.
- [x] Détection de péremption : profil trop ancien ou trop de nouveaux posts depuis.
- [x] Bouton « re-entraîner depuis mes posts » dans l'onglet Config.
- [x] Schéma Zod, et validation à la lecture comme à l'écriture.
- [x] Tests sur corpus de fixtures FR et EN, dont un corpus volontairement trop petit.

---

### 2.3 Métrique de distance de voix  `[x]`

Le signal quotidien qui remplace le blind test entre deux portes. Sans elle, on ne saurait
pas si un changement de prompt améliore ou dégrade le style, et on itérerait à l'aveugle.

- [x] `memory/voice-distance.ts` — même calcul statistique appliqué à un texte candidat,
      comparé au profil, résultat dans [0, 1].
- [x] **Règles d'applicabilité par dimension** : une réponse de 12 mots ne se compare pas à
      un profil de posts de 40 mots sur la longueur médiane. Chaque dimension déclare si
      elle est pertinente à cette échelle ; les autres sont écartées du calcul, pas notées à
      zéro.
- [x] Pondération des dimensions, réglable.
- [x] Consommée par : le CRITIC (en entrée), l'onglet Flux (badge), et un test de
      non-régression.
- [x] Tests : texte identique → distance nulle ; texte d'un registre opposé → distance
      haute ; une réponse courte n'est pas pénalisée pour sa longueur.

---

### 2.4 Socle d'agents  `[x]`

- [x] `swarm/agent.ts` — interface `Agent<Input, Output>`, wrapper de métriques (coût réel,
      latence, réparation, hash de prompt).
- [ ] `swarm/registry.ts`.
- [x] Propagation de `agentTrail` jusqu'à l'action, avec `combinedHash` (MH-04, déjà écrit).
- [x] Tests : la trace d'agents porte le coût réel de chaque étape, pas une estimation.

---

### 2.5 WRITER  `[x]`

- [x] `swarm/prompts/writer.md`.
- [x] `swarm/agents/writer.ts` — 3 variantes.
- [x] **Trois angles distincts, pas trois reformulations.** C'est le mode de défaillance
      attendu : un modèle produit volontiers la même idée trois fois. Le schéma de sortie
      impose un angle par variante, et un test assure leur diversité.
- [x] Injection du Voice Profile dans le préfixe cachable.
- [x] Brief minimal dérivé du post (le vrai STRATEGIST arrive en Phase 6).
- [x] Respect des angles autorisés par le pack de niche actif.
- [x] Tests : diversité des angles, frontière de cache préservée, respect du lexique banni.

---

### 2.6 CRITIC  `[x]` — seuil calibrable, jeu étiqueté livré

L'agent qui empêche le produit de devenir un générateur de bruit. Sa qualité *est* la
qualité du produit.

- [x] `swarm/prompts/critic.md`.
- [x] `swarm/agents/critic.ts`.
- [x] Notation par variante : authenticité de la voix, valeur ajoutée, risque réputationnel,
      redondance avec l'historique, coût d'attention, note globale.
- [x] Injection de `criticExtraRules` du pack actif.
- [x] **Droit de veto réel** : si aucune variante ne passe le seuil, l'opportunité est
      rejetée avec motif. Le rejet est un `onDone`, jamais un `onError`.
- [x] **Anti-complaisance** : le CRITIC ne doit pas voir la justification du WRITER comme une
      preuve. À écrire explicitement dans son prompt, sinon il ratifie.
- [x] Motif de rejet **actionnable** : « redondant avec ta réponse du 12 » vaut mieux que
      « qualité insuffisante ».
- [x] Le seuil de veto est configurable et le taux de rejet est une métrique affichée.
- [x] **Calibration** — tâche à part entière : un CRITIC qui rejette 95 % ou 5 % est inutile.
      Constituer un jeu de fixtures de réponses bonnes et mauvaises, mesurer le taux de
      rejet, ajuster le seuil, consigner la mesure.
- [x] Tests : chemin de veto, rejet = résultat, calibration sur fixtures.

---

### 2.7 Chaînage et intégration  `[x]`

- [x] Chaîne WRITER → CRITIC substituée à QUICK-REPLY dans l'overlay.
- [x] **Conserver QUICK-REPLY comme référence**, derrière un réglage. C'est la seule façon de
      mesurer ce que la Phase 2 apporte réellement ; le supprimer rendrait
      « le swarm fait mieux » invérifiable.
- [x] Overlay : afficher les 3 variantes, les notes du CRITIC, la distance de voix.
      Sélection au clavier.
- [x] Persistance dans `drafts` (schéma v1 déjà prévu) avec `promptVersions` par agent.
- [x] Journal d'audit : entrée `critic.rejected` avec son motif.
- [x] Tests : la chaîne complète persiste ce qu'il faut pour que la Phase 5 puisse apprendre.

---

### 2.8 Coût  `[~]`

- [ ] Mesurer le coût réel par opportunité sur la chaîne complète.
- [x] **Assertion de test** contre le chiffrage de SPEC §3.2 (~0,014 €/cycle). Un
      dépassement doit faire échouer la CI, pas se découvrir en fin de mois.
- [x] Vérifier que la frontière de cache tient sur WRITER et CRITIC — même test de
      non-régression que celui écrit en Phase 1 pour QUICK-REPLY.
- [ ] **Trancher R-03** si ce n'est pas déjà fait : sans propagation du cache par OpenRouter,
      basculer WRITER et CRITIC sur Anthropic en direct.

---

### 2.9 Vérification du DoD  `[~]`

- [x] `npm run check` vert.
- [ ] Produire les 10 paires selon le protocole préenregistré en 2.0.
- [ ] Recueillir les 30 jugements, calculer, consigner dans `docs/blind-test-<date>.md`.
- [ ] Résultat ≤ 60 % → phase validée. Au-dessus → itérer sur le WRITER et le Voice Profile,
      **sans toucher au protocole**.
- [ ] `CHANGELOG.md` de la phase.

---

### 2.10 Ce qui reste avant de passer la porte

- [x] `content/scout/collect-own-posts.ts` — parcours borné du profil de @ACMECTO.
      **La persistance et l'extraction sont prêtes** : il ne manque que l'alimentation.
      En attendant, le corpus se remplit passivement via `isOwnPost` (Phase 1).
- [x] Calibration du seuil de veto sur un jeu de fixtures de réponses bonnes et mauvaises.
      `calibrationStats()` est écrit, le jeu de fixtures reste à constituer.
- [x] Bouton « re-entraîner depuis mes posts » dans l'onglet Config.
- [x] Détection de péremption du profil.
- [ ] **Trancher R-03** (prompt caching via OpenRouter) — un test chiffre déjà l'écart.
- [ ] Passer le blind test et consigner les résultats.

> **Note sur le corpus de @ACMECTO** — voir FEEDBACK D-11. Le compte est un compte de
> projet dont la voix native est largement promotionnelle, donc largement écartée par le
> noyau MH-02. Le Voice Profile expose `guardExcludedRatio` pour le dire, et il est possible
> que le corpus assaini soit trop mince pour constituer 10 paires de blind test. Ce serait
> un résultat en soi, pas un échec technique.


### Questions ouvertes de la phase

| # | Question | Bloque | Défaut si sans réponse |
|---|---|---|---|
| ~~Q2-01~~ | ~~Handle X de l'utilisateur~~ | — | **Résolu : @ACMECTO** (D-11) |
| Q2-02 | Qui sont les 3 juges du blind test ? | 2.9 uniquement | À trouver au moment de la porte |
| Q2-03 | Seuil de veto initial du CRITIC | 2.6 | 0,6 sur la note globale, calibré ensuite |
| Q2-04 | Le corpus fait-il au moins 50 posts ? | qualité, pas le code | Le profil expose sa confiance et le CRITIC durcit |

## Phase 3 — QUALIFIER + file d'opportunités  `[~]` — code livré, mesure réelle à faire
**DoD** : 200 posts triés pour < 0,05 €. **Asserté en CI** sur les tarifs de référence ;
la mesure sur appels réels demande une clé.

- [x] `scoring/ev.ts` + `weights.ts` + `explain.ts` + `saturation.ts` + `freshness.ts`
- [x] `swarm/agents/qualifier.ts` — batchs de 50
- [x] Routage vers le modèle de triage
- [x] Onglet **Flux** + navigation clavier `A`/`E`/`R`/`Espace`
- [x] Décomposé de score cliquable
- [x] Accessibilité clavier complète (SPEC §8)
- [x] **Assertion CI du DoD** : `tests/unit/swarm/qualifier.test.ts` échoue si le prompt
      s'allonge, si la sortie grossit ou si la taille des lots baisse — les trois changements
      qui paraissent inoffensifs et multiplient le coût.
- [x] **Mesure de coût réelle sur 200 posts** — faite le 2026-08-26 : **0,025 €**, 200/200
      verdicts, zéro échec. DoD atteint avec une marge de 2. Deux défauts corrigés au passage
      (FEEDBACK D-18, D-19) : le DoD était manqué à 0,065 € avant.
      Relançable : `npm run measure:qualifier`.

### 3.10 Ajouts non prévus, faits pendant la construction
- [x] `scoring/ev.ts` — moyenne géométrique pondérée plutôt que produit brut : conserve
      « un facteur nul annule tout » sans écraser tous les scores vers zéro.
- [x] `db/repositories/opportunity.repo.ts` — file, expiration, statuts terminaux,
      déduplication avant triage.
- [x] `background/qualify.handler.ts` — chaîne de filtres **gratuits** avant toute dépense.
- [x] `background/queue.handler.ts` — lecture de file, rédaction avec escalade de modèle sur
      le top-10 EV, rejet manuel distinct du veto du CRITIC.
- [x] `sidepanel/hooks/useFluxKeyboard.ts` — raccourcis inertes dans toute zone de saisie.
- [x] Écran de file vide qui **distingue les quatre causes** au lieu de les confondre.
- [x] Horloge injectable dans les handlers du service worker (MH-17 appliqué au background).

## Phase 4 — PUBLISHER + Governor  `[~]` — code livré, journée réelle à faire
**DoD** : une journée d'usage réel sans dépassement de plafond. **Non atteint** : demande un
compte réel, une clé API et 24 h. Tout le reste est en place.

- [x] `swarm/orchestrator.machine.ts` — régions parallèles, snapshot persisté (MH-03),
      `CONFIRM_TIMEOUT_MS`, tests de forme de la machine
- [x] `governor/index.ts` — `requestPermit()` comme seule porte, `StagePermit` marqué
- [x] Journal d'audit **visible** : `background/audit.handler.ts` +
      `sidepanel/components/AuditLogPanel.tsx`, chaîne vérifiée à chaque lecture
- [x] Onglet Swarm — cockpit, kill switch, jauge de budget, compteurs de plafonds
- [x] Réglages réels : `background/settings.handler.ts` + `GuardrailsPanel.tsx`, bornés
      côté service worker (on peut resserrer, jamais desserrer)
- [x] Sauvegarde chiffrée branchée à une UI (`BackupPanel.tsx`) — export et restauration
- [x] Saisie de clé et déverrouillage du coffre (`ProviderPanel.tsx`) — sans quoi le
      produit était complet et inutilisable
- [ ] **Brancher les acteurs de la machine au service worker** (D-15). Aujourd'hui le
      Copilote fonctionne en requête/réponse et n'a pas besoin d'une boucle ; la machine
      sert le cycle autonome et la détection d'abandon. À faire avec la journée réelle,
      parce que c'est là que les valeurs de `CONFIRM_TIMEOUT_MS` se règlent.
- [ ] **Détection d'abandon en production** (MH-09) : `markAbandoned` existe et n'est
      appelé par personne. Il faut décider *quand* un brouillon mis en scène est réputé
      abandonné — à l'expiration du permis, à la fermeture de l'onglet, au staging suivant.
- [ ] `swarm/agents/publisher.ts` — l'actuateur (`content/actuator/stage-draft.ts`) fait le
      travail ; il n'y a pas d'agent PUBLISHER distinct. À trancher : le créer, ou acter
      qu'il n'a pas lieu d'être en Copilote et retirer la ligne de la spec.
- [!] Une journée réelle instrumentée — nécessite un compte réel et une clé API.

## Phase 5 — ANALYST + boucle d'apprentissage  `[~]` — boucle branchée, attribution inerte
**DoD** : les prompts changent démontrablement selon les performances passées. **Mécanique
en place et testée** (`fingerprintBefore`/`fingerprintAfter`) ; la démonstration sur données
réelles demande des réponses publiées et mesurées.

- [x] `analytics/measure.ts` — sélection des mesures dues à J+1 / J+7
- [x] `analytics/attribution.ts` — répartition proportionnelle aux clics profil
- [x] `analytics/aggregate.ts` — patterns, seuil d'échantillon, confiance
- [x] `analytics/inject.ts` — réinjection dans les prompts, empreinte de digest
- [x] **Branchement réel** : `background/analyst.handler.ts`, appelé par l'alarme `MEASURE`
      (c'était le trou : le code était juste et personne ne l'appelait)
- [x] Mesure passive avec fenêtre de tolérance par échéance (D-14)
- [x] Onglet **Analytics** — couverture de mesure affichée **avant** les patterns, top/flop,
      coût par réponse, taux de veto, taux d'abandon
- [ ] **Relevé du nombre d'abonnés** — sans lui, l'attribution vaut zéro partout et le coût
      par abonné gagné n'est pas affichable (R-10). Demande un sélecteur sur la page de
      profil, donc une fixture capturée sur le DOM réel (R-07), plus une table
      `followerSamples` (migration v3).
- [ ] Relevé des **clics profil** et des **impressions** depuis l'écran d'analytique de X —
      même dépendance : une fixture réelle. En attendant, `null` et non zéro.
- [!] Démonstration du DoD sur données réelles — nécessite 7 jours de publications mesurées.

## Phase 6 — Mémoire relationnelle + vector store  `[~]` — fonctionnel en hachage, ONNX à venir
- [x] `memory/embeddings.ts` — `HashingEmbedder`, déterministe, zéro octet à télécharger
- [x] `memory/vector-store.ts` — recherche cosinus exhaustive
- [x] `memory/relationships.ts` — CRM social, `warmth` 0–5, asymétrie, décroissance
- [x] `memory/dedupe.ts` — anti-répétition sémantique
- [x] `memory/warmth.ts` — progression de familiarité
- [x] `memory/voice-profile.ts` + `voice-distance.ts` (MH-18)
- [ ] `offscreen/embeddings.worker.ts` — modèle ONNX local (MH-01). Le hachage détecte la
      reformulation, pas le synonyme : « liquidité verrouillée » et « LP lock » restent
      invisibles l'un à l'autre. L'interface est prête (ADR 0002), il manque le modèle.
- [ ] Choix du modèle et **affichage de l'URL de téléchargement avant de télécharger** —
      c'est le seul octet non embarqué que le produit ferait descendre.
- [ ] `offscreen/vector-index.ts` — index approché (hnswlib-wasm). Inutile avant plusieurs
      dizaines de milliers de vecteurs : la recherche exhaustive suffit largement au volume
      d'un compte. À ne faire que si la mesure le demande.
- [ ] `swarm/agents/strategist.ts` — l'agent STRATEGIST n'existe pas comme module : le choix
      d'angle est fait par le WRITER (3 angles) et arbitré par le CRITIC. À trancher :
      l'écrire, ou acter la fusion dans FEEDBACK et corriger la spec.

## Phase 7 — Simulation / backtest  `[~]` — rejeu opérationnel, archive à constituer
- [x] `simulation/recorder.ts` — archive de timeline (opt-in nommé, MH-13)
- [x] `simulation/replay.ts` — rejeu déterministe, horloge et RNG seedés (MH-17)
- [x] `simulation/compare.ts` — comparaison de configurations
- [x] Reproductibilité vérifiée par test : deux runs identiques → résultats identiques
- [ ] UI de backtest : lancer un rejeu, comparer deux configs, voir les décisions. Aujourd'hui
      accessible seulement par code.
- [ ] Archive réelle de 30 jours — se remplit passivement, donc c'est du temps, pas du code.
- [ ] Rappeler dans l'UI ce que le backtest ne mesure pas : il compare des **politiques de
      sélection** sur des verdicts archivés, pas des qualités de rédaction.

## Phase 8 — Threads, médias, autopilote, packaging  `[~]` — livré sauf autopilote (volontaire)
- [x] `swarm/thread/thread-composer.ts` — découpage aux frontières de sens, refus plutôt que
      coupure d'un mot, numérotation, A/B de hooks structurel
- [x] `swarm/media/image-brief.ts` — brief + texte alternatif, chiffres du brouillon imposés,
      aucun fournisseur embarqué (D-12)
- [x] `AutopilotWarning.tsx` — défilement jusqu'au bout, phrase à recopier, refus en bouton
      principal, et la mention que l'accepter ne change rien puisque le code n'existe pas
- [x] `autopilot/` — **le module n'existe pas, et c'est la décision** (SPEC §4.6, R-01).
      `AUTOPILOT_IMPLEMENTED === false` est asserté par un test.
- [x] Build de production sans avertissement, `scripts/build-zip.ts` avec garde anti-E2E
- [x] `PRIVACY.md` finalisé (divulgations CWS incluses)
- [x] Fiche Chrome Web Store et revue de conformité : `docs/chrome-web-store.md`
- [x] Test d'egress : aucune primitive réseau hors de `src/llm/`, aucun SDK de télémétrie,
      aucun hôte inattendu dans les sources
- [ ] UI du composeur de threads et de l'A/B de hooks — la logique est là, l'écran non.
- [ ] Icônes définitives (les 4 tailles sont des placeholders)
- [ ] Cinq captures d'écran sur un compte réel + vidéo de démonstration pour la revue
- [ ] Décision du propriétaire sur le nom « SWARM » (voir la revue, point 2)
- [ ] `PRIVACY.md` publié à une URL stable, à renseigner dans la fiche

---

## Ce qui reste, trié par ce qui bloque

### Bloqué par une ressource externe (aucun code à écrire d'ici là)
| # | Attend | Débloque |
|---|---|---|
| ~~B-01~~ | ~~Une clé API OpenRouter~~ | **Levé le 2026-08-26.** R-03 confirmé, DoD Phase 3 mesuré, CRITIC calibré. Voir FEEDBACK partie B quinquies. |
| B-02 | Un compte X réel + 24 h | DoD Phase 4, captures d'écran, détection d'abandon réglée |
| B-03 | 7 jours de publications mesurées | DoD Phase 5 sur données réelles |
| B-04 | 3 juges humains | Blind test de la Phase 2 (protocole préenregistré) |
| B-05 | Un DOM de profil X capturé | Relevé d'abonnés, clics profil, impressions (R-10) |
| B-06 | Un modèle ONNX choisi | Embeddings sémantiques (MH-01) |

### Mesures disponibles (clé requise, `.env`)
| Commande | Ce qu'elle mesure | Coût | Dernier résultat |
|---|---|---|---|
| `npm run measure:cache` | R-03 — propagation du cache de prompt | ~0,002 € | ✓ confirmé, 3 135 tokens lus en cache |
| `npm run measure:qualifier` | DoD Phase 3 — 200 posts < 0,05 € | ~0,025 € | ✓ 0,025 €, marge ×2 |
| `npm run calibrate:critic` | Seuil de veto, sur jeu étiqueté | ~0,09 € | ✓ 0,45 recommandé (défaut appliqué) |
| `npm run live` | les trois d'affilée | ~0,12 € | — |

À relancer après tout changement de prompt, de modèle ou de format de sortie : ce sont les trois
endroits où une régression de coût est invisible en test unitaire.

- [ ] Élargir le jeu étiqueté du CRITIC à 40+ réponses (18 aujourd'hui — la calibration le dit
      elle-même « indicatif seulement »).
- [ ] Mesurer le coût réel du chemin WRITER → CRITIC, qui n'a pas encore de mesure dédiée. C'est
      le chemin où le cache de prompt s'applique vraiment, donc celui dont l'estimation est la
      plus incertaine.
- [ ] Rejouer `measure:qualifier` sur une **archive réelle** plutôt que sur des posts
      synthétiques (`simulation/recorder.ts`) : la longueur et la langue sont réalistes, le
      contenu non.

### Vérifié dans un vrai Chrome (2026-08-26)
- [x] L'extension se charge, le service worker répond, le side panel s'ouvre.
- [x] Porte de consentement (MH-12) — écran livré, parcours E2E complet.
- [x] Écran de saisie de clé, plafonds réglables, sauvegarde chiffrée : atteignables.
- [ ] **Non encore parcouru dans un navigateur** : saisie de clé réelle + premier appel LLM
      depuis le panel, collecte du corpus sur le profil de @ACMECTO, mise en scène d'un
      brouillon dans le composeur de X. C'est la prochaine session de test manuel.
- [x] `INSTALL.md` — guide d'installation, dépannage, valeurs par défaut. Un test compare ses
      chiffres aux constantes du code : le guide ne peut plus mentir en silence.
- [x] Sélecteur de pack de niche — sans lui, le compte pilote tournait sur `generic`.
- [ ] Icônes définitives (toujours des placeholders).

### Faisable maintenant, par ordre de valeur
1. **Brancher les acteurs de l'orchestrateur** + décider la règle d'abandon (Phase 4).
2. **UI d'édition des packs de niche** — aujourd'hui un pack s'importe par fichier, ce qui
   suffit techniquement mais ferme le produit à un utilisateur non technique.
3. **Onboarding** (`sidepanel/onboarding/` est vide) — consentement MH-12, saisie de clé,
   handle, choix de pack, avertissement sur les règles de X. Le premier écran décide de
   l'usage correct du produit.
4. **UI de backtest** et **UI de threads** — logique livrée, écrans manquants.
5. **Trancher STRATEGIST et PUBLISHER** : les écrire ou acter leur fusion, et corriger la
   spec en conséquence. Un agent nommé dans la spec et absent du code est une dette de
   lisibilité.
6. **Icônes définitives** et la liste de pré-soumission de `docs/chrome-web-store.md`.

### Décisions qui appartiennent au propriétaire
- Le nom du produit (revue CWS, point 2).
- Le plafond de réponses par défaut : 25 (spec) contre 12 (R-04, prudence initiale).
- Publier ou non l'extension avant d'avoir un mode autonome — la réponse par défaut est oui,
  puisque le Copilote est le produit.

---

## Dette et vigilance permanente

Ces lignes ne se cochent pas : elles sont vraies à chaque commit ou elles ne le sont pas.

- [x] `scripts/check-selectors.ts` exécuté par `npm run check` — le DOM de X est le premier
      risque de maintenance du produit
- [x] Test d'agnosticisme de niche : aucun terme de niche codé dans `src/`
- [x] Aucun secret dans les logs — test bloquant sur le logger
- [x] Aucune sortie réseau hors de `src/llm/` — `tests/unit/security/egress.test.ts`
- [x] `npm run build` sans avertissement Rollup (les imports dynamiques inefficaces sont des
      chunks qui ne se séparent pas : le signal est vrai, on le traite)
- [x] `npm run zip` refuse un bundle E2E (content script hors des domaines X)
- [ ] Aucun de ces contrôles n'est encore lancé par une CI : il n'y a pas de dépôt distant.
      `npm run check` les couvre tous en local — à brancher sur un workflow au premier push.
- [ ] Couverture du `governor` maintenue à 100 % des branches — à vérifier par
      `npm run test:cov` avant chaque livraison, le seuil n'est pas encore bloquant
- [ ] Prix des modèles resynchronisés, jamais codés en dur : l'alarme `PRICES` est
      enregistrée et son handler ne fait rien. Le catalogue embarqué vieillit donc en
      silence — à brancher sur `https://openrouter.ai/api/v1/models`. **Priorité relevée** :
      la mesure du 2026-08-26 a montré qu'une erreur de tarif ne se voit nulle part et fausse
      le plafond d'un facteur dix (FEEDBACK D-17).
