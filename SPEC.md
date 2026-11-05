# SWARM — Spécification produit et technique

> Version 0.1 · Phase en cours : **0 — Fondations**
> Ce document est la source de vérité. Toute divergence entre le code et ce fichier
> est un bug de l'un ou de l'autre, à trancher explicitement.

---

## 1. Définition du produit

**SWARM** est un copilote autonome multi-agents pour **un** compte X (Twitter), livré
comme extension Chrome Manifest V3, **local-first** : aucun backend, aucune donnée
sortante hors du provider LLM que l'utilisateur choisit lui-même.

### 1.1 Thèse produit

Le marché existant (Tweethunter, Hypefury, Reply Guy, Tweetback…) fonctionne en
**génération one-shot** : un post entre, une réponse IA sort. Il en résulte du contenu
génériquement plausible, sans apprentissage ni stratégie.

SWARM est un **système** : une escouade d'agents spécialisés qui observent, qualifient,
rédigent, critiquent, mettent en scène, **mesurent le résultat réel et se corrigent**.

**La boucle de feedback est le produit.** Tout le reste est de la plomberie autour
d'elle. Si une décision d'architecture affaiblit la mesure ou l'attribution, elle est
mauvaise, quel qu'en soit le gain par ailleurs.

### 1.2 Les 6 différenciateurs (non négociables)

| # | Différenciateur | Absent de la concurrence |
|---|---|---|
| 1 | Orchestration multi-agents avec un agent **CRITIC** doté d'un droit de veto | Un seul appel LLM, aucun contrôle qualité |
| 2 | **Boucle d'apprentissage fermée** : re-mesure J+1/J+7, scoring des patterns gagnants | Aucune mesure de ce qui marche |
| 3 | **Mémoire relationnelle** (CRM social local) : historique, ton, familiarité par compte | Chaque réponse repart de zéro |
| 4 | **Scoring d'opportunité explicite** et réglable (`EV`) | Filtrage binaire par mots-clés |
| 5 | **Routage multi-modèles économique** : triage bon marché, rédaction forte, budget € plafonné | Un seul modèle pour tout |
| 6 | **Simulation / backtest** sur historique archivé, sans publier | Inexistant |

### 1.3 Différenciateur ajouté en Phase 0 : le Niche Pack

Le compte pilote est un compte **memecoin**, mais le produit est destiné à la vente à
des clients de niches arbitraires. Conséquence : **aucune notion de niche n'existe dans
le TypeScript**. Une niche est un artefact de données de premier ordre — un `NichePack`
importable, exportable, versionné et validé par Zod.

Un pack déclare : mots-clés, watchlists, sujets bloqués additionnels, préréglage des
poids EV, lexique admis/interdit, fragments de prompt, langues.

**Test d'agnosticisme** : la CI fait tourner le swarm sur deux packs (`memecoin`,
`saas-b2b`) et vérifie qu'aucun code n'a besoin de changer. Ce test est bloquant.

---

## 2. Garde-fous — implémentés, pas documentés

Ces contraintes vivent dans `src/governor/`. Aucun autre module n'a le droit de
déclencher une action sur X : l'unique porte d'entrée est `governor.requestPermit()`.
Pas de permis, pas d'action — garanti par le typage (`StagePermit` est un type
opaque que seul le governor peut construire).

### 2.1 Contraintes dures

| Contrainte | Valeur par défaut | Configurable |
|---|---|---|
| Comptes gérés | **1** | Non — jamais |
| Réponses / jour | 12 (relevable à 25) | Oui, plafond dur |
| Posts / jour | 3 | Oui |
| Follows / jour | **0** | Oui |
| DM / jour | **0** | Non — voir 2.2 |
| Délai entre actions | log-normal, 4–18 min | Oui |
| Fenêtres actives | 09:00–23:00 locales | Oui |
| Pause nocturne | oui | Oui |
| Jours off aléatoires | ~1/semaine | Oui |
| Mode par défaut | **Copilote** | Autopilote opt-in, Phase 8 |

### 2.2 Interdits absolus

- **Aucun DM automatique.** Les DM sont uniquement des brouillons ouverts dans l'UI de
  X pour envoi manuel. Il n'existe aucun code d'envoi de DM.
- **Aucune gestion multi-comptes coordonnée.** Pas de « ferme de comptes ». Le produit
  gère *son* compte.
- **Aucune réponse sur sujet sensible** : santé, deuil, politique, crise. Noyau
  universel du `topic-guard`, **non désactivable**, un pack ne peut qu'y ajouter.
- **Aucun conseil financier, prédiction de prix ou promotion de ticker non sollicitée.**
  Ajouté au noyau universel en Phase 0 — voir FEEDBACK.md § MH-02.
- **Aucun spam de mots-clés.**

### 2.3 Kill switch

Un clic depuis le side panel + raccourci `Alt+Shift+K`. Vide la file d'actions en
attente. **L'état est persisté**, pas en mémoire : le service worker MV3 meurt à tout
moment, un kill switch en RAM est un kill switch qui se relève tout seul. Il est
vérifié à chaque `requestPermit()`, et son état est absorbant — seul un `RESUME`
explicite en sort.

### 2.4 Journal d'audit

Append-only, **hash chaîné** (chaque entrée contient le hash de la précédente) : une
table simplement append-only n'est pas inaltérable. Enregistre pour chaque action
réellement effectuée : horodatage, agent responsable, version de prompt, coût token
réel, résultat.

---

## 3. Stack technique

| Couche | Choix | Raison |
|---|---|---|
| Extension | Manifest V3 | Seule option Chrome |
| Langage | TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | Aucun `any` non justifié par un commentaire |
| Build | Vite + `@crxjs/vite-plugin` | HMR sur les contextes d'extension |
| UI | React 18 + Tailwind + shadcn/ui, thème sombre | Cohérence visuelle avec X |
| Interface principale | **Side Panel API** | Le popup est trop exigu pour un cockpit |
| Traitements longs | **Offscreen Document** | Le service worker est tué vers 30 s |
| Persistance | Dexie.js (IndexedDB) + migrations versionnées | Volumes + requêtes indexées |
| Vector store | Embeddings **locaux** (ONNX/transformers.js dans l'offscreen), cosinus WASM | Coût nul, zéro egress — voir FEEDBACK.md § MH-01 |
| Validation | **Zod à toutes les frontières** | LLM, DOM, storage, messages inter-contextes |
| Orchestration | XState v5, snapshot **persisté** à chaque transition | Le SW meurt : un orchestrateur en RAM perd la file |
| Tests | Vitest (unitaire) + Playwright (E2E) | |
| Backend | **aucun** | |

### 3.1 Providers LLM

Adaptateur unifié : **OpenRouter (défaut)**, Anthropic, OpenAI, Google Gemini, xAI, et
tout endpoint OpenAI-compatible local (Ollama / LM Studio).

Clés stockées dans `chrome.storage.local`, **chiffrées WebCrypto AES-GCM** avec une clé
dérivée par PBKDF2 d'une passphrase utilisateur. Jamais loggées, jamais dans une URL.

> Honnêteté requise dans l'onboarding : le chiffrement au repos protège du vol de
> fichier, **pas** d'un attaquant déjà présent dans la session navigateur. Une clé API
> dans une extension est structurellement exposée à qui contrôle la machine.

### 3.2 Routage et budget

Deux vitesses (§1.2 n°5) :

| Agent | Modèle par défaut | Effort |
|---|---|---|
| QUALIFIER (triage de masse) | Haiku 4.5 (ou modèle ouvert < $0,20/MTok) | `low` |
| STRATEGIST | Haiku 4.5 | `low` |
| WRITER | Sonnet 5 — **Opus 5 sur le top-10 EV** | `low` |
| CRITIC | Sonnet 5 | `medium` |

**Budget : 1 €/jour, plafond dur.** Chiffrage de référence (tarifs Anthropic, cache
read à 0,1× l'input, ~1 $ ≈ 0,92 €) :

| Étape | Hypothèse | Coût |
|---|---|---|
| QUALIFIER | 200 posts, batchs de 50 → 4 appels (~5,3k in / 1,25k out) | 0,042 €/jour |
| STRATEGIST | 1,5k in (1k caché) / 200 out | 0,0015 €/opp |
| WRITER | 2k in (1,7k caché) / 400 out | 0,007 €/opp |
| CRITIC | 2,5k in (2k caché) / 300 out | 0,006 €/opp |
| Embeddings | locaux | 0 € |

→ **~0,014 € par cycle de rédaction**, ~68 cycles/jour dans le budget.
Consommation réelle attendue : **0,40–0,60 €/jour**. À valider en Phase 3.

Quatre règles qui découlent de ce chiffrage :

1. **Prompt caching obligatoire.** Le préfixe stable (Voice Profile + guardrails +
   top/flop patterns) est ~85 % du prompt de WRITER/CRITIC. Sans cache, le coût par
   opportunité triple. *À valider en Phase 0 : OpenRouter propage-t-il `cache_control`
   vers Anthropic ? Sinon, ces deux agents tapent Anthropic en direct.*
2. **Le compteur lit `usage` dans la réponse, jamais une estimation de longueur.** Les
   modèles 5 ont l'adaptive thinking actif par défaut et facturent les tokens de
   réflexion en output. Estimer, c'est mentir d'un facteur inconnu.
3. **`output_config.effort` bas par défaut.** L'output pèse plus que l'input.
4. **`llm/pricing.ts` se synchronise depuis le catalogue OpenRouter.** Un catalogue de
   300 modèles évolue plus vite qu'un build d'extension ; un compteur de budget avec
   des prix périmés est un compteur cassé.

### 3.3 Réserve de budget

Le budget est segmenté, pas global : une réserve (défaut 25 %) est sanctuarisée pour
CRITIC et ANALYST. Sans elle, une journée de triage vorace peut épuiser le budget avant
la relecture, et le produit publie sans contrôle qualité — exactement le mode de
défaillance qu'on prétend éviter.

---

## 4. Architecture du swarm

Orchestrateur central `src/swarm/orchestrator.machine.ts` (XState v5) pilotant 7
agents. Chaque agent implémente `Agent<Input, Output>` : prompt système versionné en
`.md`, modèle assigné, budget, métriques.

```
┌──────────────────────────────────────────────────────────────────────┐
│                       ORCHESTRATOR (XState, persisté)                │
│                                                                      │
│  region governance (parallèle, toujours active)                      │
│    nominal ⇄ paused (budget)  ⇄ degraded (sélecteur)  → halted (KILL)│
│                                                                      │
│  region pipeline                                                     │
│    idle → scouting → qualifying → drafting(strategizing→writing)     │
│         → reviewing → queued → awaitingHuman → staging → confirming  │
│         → measuring → learning → idle                                │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.1 SCOUT — collecte

Content script sur `x.com`. `MutationObserver` + `IntersectionObserver` sur : timeline
For You/Following, résultats de recherche configurés, watchlist, notifications,
bookmarks.

Extrait par post : texte, auteur (handle, followers, bio), métriques, âge, nombre de
réponses existantes, médias, thread parent, langue.

**Contrainte** : lecture passive de ce que l'utilisateur voit déjà. Pas de scroll
infini automatisé, pas de scraping de masse hors session. Débit throttlé, backpressure.

### 4.2 QUALIFIER — scoring (modèle de triage)

Calcule le score EV, batché ~50 posts par appel.

```
EV = portée_estimée × pertinence_niche × fraîcheur × (1 / saturation_réponses) × affinité_auteur
```

Formule visible et réglable dans l'onglet Config, avec décomposé cliquable sur chaque
carte du Flux.

Élimine : hors-niche, saturé (> 150 réponses), trop vieux (> 90 min, configurable),
sujets sensibles, comptes traités récemment (mémoire relationnelle), langues non gérées.

### 4.3 STRATEGIST — angle

Décide *quoi apporter* : contre-argument, donnée chiffrée, anecdote, question
relançante, blague, ressource. Consulte le vector store (« qu'ai-je déjà dit sur ce
sujet ? ») et la mémoire relationnelle de l'auteur. Sort un **brief d'intention**, pas
du texte.

### 4.4 WRITER — rédaction (modèle fort)

Brief → 3 variantes. Respecte le **Voice Profile**, construit depuis les 200 derniers
posts de l'utilisateur : longueur moyenne, ponctuation, emojis, majuscules, tics de
langage, niveau de langue, sujets récurrents.

### 4.5 CRITIC — contrôle qualité (bloquant)

Note chaque variante sur : authenticité de la voix (« est-ce que ça sonne IA ? »),
valeur réelle ajoutée, risque réputationnel, redondance avec l'historique, respect des
règles utilisateur, **et — ajout Copilote — coût d'attention** (« cette réponse te
ferait-elle perdre du temps à la relire ? »).

**Droit de veto** : si aucune variante ne passe le seuil, l'opportunité est rejetée
avec motif. C'est ce qui empêche le produit de devenir un générateur de bruit.

> Le taux de rejet est une **métrique affichée, pas un bug**. Un rejet est un `onDone`
> dans la machine, jamais un `onError`.

### 4.6 PUBLISHER — mise en scène (Copilote seul)

Décision Phase 0, validée : **le produit ne clique jamais « Publier ».**

- L'actuator (`stage-draft.ts`) écrit dans le composeur de X, met le focus, s'arrête.
- Il n'existe **aucun code** qui soumette un post. Pas un flag désactivé : du code
  absent. Le module `autopilot/` n'est pas créé avant la Phase 8 — un flag se retourne
  par accident, un fichier inexistant non.
- Nouvel état **`confirming`** : puisque l'humain clique, le système doit *découvrir* si
  la réponse est partie, sinon ANALYST mesure des actions fantômes. Observation de
  l'apparition dans le thread, avec timeout → `published` / `abandoned`.
- Le **taux d'abandon** devient une métrique : c'est le désaccord silencieux de
  l'utilisateur avec le CRITIC.
- En Copilote, le governor ne protège plus du bannissement (l'humain est dans la
  boucle) mais de la **saturation cognitive** : pas 25 brouillons empilés d'un coup. La
  cadence log-normale devient un régulateur d'attention.

### 4.7 ANALYST — mesure et apprentissage

Re-visite les actions publiées à **J+1 et J+7** : impressions, likes, réponses,
reposts, clics profil. Attribue les nouveaux followers aux réponses (corrélation
temporelle + visite de profil).

Alimente `patterns` : quels angles, longueurs, heures, types de comptes, formats
performent. Réinjecte **top 5 / flop 5** dans les prompts de STRATEGIST et WRITER à
chaque cycle.

Chaque action porte le **hash de la version de prompt** qui l'a produite. Sans ça, la
boucle d'apprentissage corrèle des performances à des prompts qui ont changé entre
temps — et n'apprend rien. Voir FEEDBACK.md § MH-04.

> C'est la fonctionnalité qui n'existe nulle part ailleurs. Elle doit être visible
> dans l'UI.

---

## 5. Modèle de données (Dexie)

| Table | Contenu |
|---|---|
| `opportunities` | postId, authorHandle, text, metrics, evScore, scoreBreakdown, status, rejectionReason, createdAt |
| `drafts` | opportunityId, variants[], selectedIndex, criticScores, voiceScore, promptVersions |
| `actions` | type (reply/post/thread/like/bookmark), content, stagedAt, publishedAt, xPostId, agentTrail[], tokenCost, promptVersionHash, idempotencyKey |
| `outcomes` | actionId, checkedAt, impressions, likes, replies, reposts, profileClicks, attributedFollows |
| `relationships` | handle, firstSeen, lastInteraction, interactionCount, theirTopics, ourTopics[], warmth (0–5), notes |
| `voiceProfile` | stats extraites, exemples canoniques, règles do/don't |
| `patterns` | dimension, value, sampleSize, avgEngagement, confidence |
| `config` | caps, windows, activeNichePack, budget, mode |
| `nichePacks` | packs installés (schéma §1.3) |
| `auditLog` | append-only, hash chaîné |
| `embeddings` | refType, refId, vector (local) |
| `promptVersions` | hash, agent, contenu, createdAt |

Toute écriture passe par `src/db/repositories/` — aucun accès Dexie brut ailleurs.

---

## 6. Interface

### Side panel, 4 onglets

1. **Flux** — file d'opportunités triées par EV. Chaque carte : le post original, le
   score avec décomposé cliquable, les 3 variantes, les notes du CRITIC.
   Clavier : `A` approuver · `E` éditer · `R` rejeter · `Espace` suivant.
   **Accessibilité clavier complète obligatoire** — c'est l'écran où l'utilisateur
   passe son temps.
2. **Swarm** — cockpit temps réel : quel agent tourne sur quoi, coût du jour vs budget,
   compteurs de plafonds, kill switch. Doit ressembler à un cockpit, pas à un spinner.
3. **Analytics** — croissance, performance par angle/heure/format, patterns gagnants,
   taux de rejet du CRITIC, taux d'abandon humain, coût par follower gagné.
4. **Config** — packs de niche, plafonds, fenêtres, Voice Profile (+ « re-entraîner
   depuis mes posts »), providers et modèles par agent, poids EV, budget.

### Overlay in-page

Bouton discret sous chaque post de X → génère une réponse à la demande. C'est le cas
d'usage rapide qui délivre la valeur immédiate, et il court-circuite le triage.
Monté en **Shadow DOM** : X change ses classes en continu, l'isolation évite la casse
visuelle dans les deux sens.

### Onboarding — 6 étapes

1. Écran de consentement (règles X, limites, ce que le produit ne fait pas)
2. Clé API + passphrase de chiffrement
3. Analyse de la voix
4. Choix / import du pack de niche
5. Choix du mode (Copilote seul en v1)
6. Run en simulation

---

## 7. Phases de livraison

| Phase | Contenu | Definition of Done |
|---|---|---|
| **0** | Scaffold, manifest, messagerie typée, Dexie + migrations, NichePack, adaptateur LLM + chiffrement, `governor` + tests | L'extension charge, le side panel s'ouvre, un appel LLM test débite le compteur, plafonds/cadence couverts unitairement |
| **1** | Scout + Overlay : parsing DOM résilient, extraction, overlay bout-en-bout | Je peux répondre à un post avec l'IA sans quitter X |
| **2** | Voice Profile + WRITER + CRITIC | Réponses indiscernables de mon style sur un blind test de 10 exemples |
| **3** | QUALIFIER + file d'opportunités, onglet Flux | 200 posts triés pour < 0,05 € |
| **4** | PUBLISHER + governor complet, Copilote, kill switch, audit | Une journée d'usage réel sans dépassement de plafond |
| **5** | ANALYST + boucle d'apprentissage, onglet Analytics | Les prompts changent démontrablement selon les performances passées |
| **6** | Mémoire relationnelle + vector store, anti-répétition sémantique | |
| **7** | Simulation / backtest, comparaison de configs | |
| **8** | Threads, médias, autopilote opt-in, packaging, politique de confidentialité, fiche CWS | |

---

## 8. Critères de qualité (bloquants en CI)

- **Zod à chaque frontière.** Un LLM qui renvoie du JSON malformé ne doit jamais casser
  l'app : retry → réparation → fallback.
- **Sélecteurs DOM centralisés** dans `src/content/dom/x-selectors.ts`, fallbacks en
  cascade, **détection automatique de rupture** avec alerte utilisateur au lieu d'échec
  silencieux. *X change son DOM : c'est le principal risque de maintenance du produit,
  traité comme tel.*
- **Prompts en `.md` versionnés**, jamais hardcodés dans le TS, hash stocké par action.
- **Tests** : governor, scoring, parsing, adaptateurs LLM, migrations, packs de niche.
  E2E Playwright sur les parcours critiques.
- **Performance** : le content script ne dégrade pas le scroll de X — mesure de FPS
  dans les tests.
- **Aucun secret dans les logs** : le logger redacte, et un test l'assure.
- **Horloge et RNG injectables** (`shared/time.ts`, `shared/rng.ts`) : sans ça la
  cadence log-normale n'est pas testable et le backtest n'est pas reproductible.

---

## 9. Ce que SWARM ne fera pas

Liste explicite, à maintenir. Elle protège autant l'utilisateur que le produit.

- Gérer plusieurs comptes de façon coordonnée
- Envoyer un DM automatiquement
- Cliquer « Publier » sans intervention humaine (jusqu'à la Phase 8, opt-in explicite)
- Répondre sur santé, deuil, politique, crise
- Donner un conseil financier, prédire un prix, promouvoir un ticker non sollicité
- Scraper X hors de la session de navigation de l'utilisateur
- Envoyer quoi que ce soit à un serveur autre que le provider LLM choisi
- Collecter de la télémétrie sans opt-in explicite
