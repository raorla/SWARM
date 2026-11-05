# FEEDBACK — décisions, must-have ajoutés, désaccords assumés

> Journal des arbitrages. Ce fichier existe pour que personne — moi inclus, dans trois
> semaines — n'ait à redécouvrir *pourquoi* une contrainte est là.
> Format : décision · pourquoi · comment c'est appliqué dans le code.

---

## Partie A — Décisions validées par l'utilisateur (2026-08-25)

| # | Question | Réponse | Conséquence |
|---|---|---|---|
| D-11 | Handle du compte pilote | **@ACMECTO** — compte de **projet** ($acme, Solana), pas un compte personnel | Voir D-11 ci-dessous : conflit entre la voix native du compte et le noyau MH-02 |
| D-01 | Niche | Memecoin pour le compte pilote, **mais produit vendu à des niches arbitraires** | → MH-10 Niche Pack. Zéro niche dans le TS. |
| D-02 | Provider | **OpenRouter** multi-modèles | Adaptateur OpenRouter en premier, interface commune pour les autres |
| D-03 | Budget | **~1 €/jour**, plafond dur | → MH-05 réserve de budget, prompt caching obligatoire, MH-01 embeddings locaux |
| D-04 | Publication | **Copilote DOM seul, pas d'API X** | → MH-09 état `confirming`. Aucun code de soumission avant Phase 8. |
| D-12 | Génération d'images | **Brief seulement, aucun fournisseur embarqué** | Voir Partie B quater. `IMAGE_GENERATION_IMPLEMENTED === false`, asserté. |
| D-13 | Déverrouillage du coffre | **Cache de session (`chrome.storage.session`), TTL 8 h** | Voir Partie B quater. Sans lui, le chemin LLM était inatteignable en MV3. |
| D-14 | Mesure J+1 / J+7 | **Passive — aucune navigation autonome** | Couverture partielle, affichée et chiffrée dans l'onglet Analytics. |
| D-15 | Orchestrateur XState | **Écrit, testé, non branché au service worker** | Le Copilote n'a pas de boucle autonome. Reste à faire, voir TODO Phase 4. |
| D-16 | Périmètre du hash d'audit | **Liste fermée de champs de contenu** | Corrige un défaut qui rendait la chaîne invérifiable en base. |
| D-17 | Comptabilité des tokens OpenRouter | **`prompt_tokens` moins les tokens cachés** | Le cache faisait ×10 le coût estimé au lieu de le diviser par 10. |
| D-18 | Format de sortie du QUALIFIER | **Tuples compacts, `note` optionnelle** | 10 tokens par verdict au lieu de 54. Sans ça, DoD Phase 3 manqué. |
| D-19 | Raisonnement du QUALIFIER | **Aucun** (`effort` absent, pas `'low'`) | `'low'` *active* la réflexion, facturée en sortie : lots tronqués. |
| D-20 | Seuil de veto du CRITIC | **0,45 mesuré**, au lieu de 0,6 deviné | À 0,6, 5 bonnes réponses sur 6 rejetées. |
| D-21 | Secrets de développement | **`.env` pour les scripts Node uniquement** | Une variable `VITE_*` finirait dans le zip du Chrome Web Store. |
| D-22 | Nom du point d'entrée du SW | **`service-worker.ts`**, jamais `index.ts` | @crxjs indexe par nom de base : collision avec le content script → extension muette. |
| D-23 | Imports dans le service worker | **Statiques uniquement** | Le helper de préchargement de Vite touche `document`, absent d'un worker. |
| D-24 | Consentement (MH-12) | **Écran livré, porte avant les onglets** | Il était vérifié à trois endroits et impossible à accorder. |

Défauts appliqués faute de réponse (révisables sans coût) : langues **FR + EN**,
`follows/jour = 0`, `DM/jour = 0`, plafond initial **12 réponses/jour**.

### Écarts assumés à la stack décrite dans la spec

Trois choix de version divergent de §3 du prompt d'origine. Chacun est réversible, et
chacun est signalé ici plutôt que fait en silence.

| # | Spec demandait | Livré | Raison | Coût du retour arrière |
|---|---|---|---|---|
| D-05 | React 18 | **React 19.2** | React 18 a deux majeures de retard. Démarrer un produit commercial dessus, c'est programmer une migration dans six mois, sur un code qui aura entre-temps quatre onglets et un onboarding. shadcn/ui supporte 19. | Une ligne de `package.json` — aucune API React 19 spécifique n'est utilisée. |
| D-06 | `tailwind.config.ts` | **Tailwind 4, config CSS-first** | Tailwind 4 n'a plus de fichier de configuration JS : les tokens vivent dans `@theme` au sein du CSS. Forcer la v3 pour respecter la lettre de la spec voudrait dire démarrer sur une majeure dépassée. | Rétrogradation possible, mais elle demanderait de réécrire `globals.css`. |
| D-07 | Zod (version non précisée) | **Zod 4** | Version courante. L'API utilisée (`safeParse`, `discriminatedUnion`, `z.output`) est stable entre 3 et 4. | Nul en pratique. |

Dis-moi si l'un des trois te gêne — le premier est le seul qui coûte quelque chose à
défaire plus tard, et c'est aujourd'hui qu'il coûte le moins.

---

## Partie B — Must-have que j'ajoute au cahier des charges

Chacun corrige un mode de défaillance que la spec d'origine laissait ouvert.

### MH-01 · Embeddings 100 % locaux
**Décision** : les embeddings tournent dans l'Offscreen Document via un petit modèle
ONNX (`transformers.js`, ~30 Mo bundlé). Aucun appel API d'embedding.
**Pourquoi** : trois raisons qui pointent dans le même sens. (1) À 1 €/jour, une ligne
de coût récurrente sur les embeddings est intenable. (2) Envoyer chaque post lu à une
API d'embedding contredit frontalement le « zéro donnée sortante » — le vector store
serait le plus gros canal d'egress du produit. (3) Surtout : si le budget quotidien est
épuisé, la mémoire relationnelle et l'anti-répétition doivent **continuer à
fonctionner**. Un cap atteint ne doit pas rendre le système amnésique.
**Comment** : `src/offscreen/embeddings.worker.ts`, jamais d'embedding dans `llm/`.

### MH-02 · Contenu financier dans le noyau universel du topic-guard
**Décision** : « pas de prédiction de prix, pas de conseil d'investissement, pas de
promotion de ticker non sollicitée » rejoint santé/deuil/politique/crise dans la couche
**non désactivable**.
**Pourquoi** : la niche pilote est memecoin, ce qui fait du contenu de réponse une
promotion financière de fait. Les règles de X sur le spam financier sont appliquées plus
durement que ses règles d'automatisation, et « reply guy crypto » est le pattern le plus
signalé de la plateforme. Second risque, commercial celui-là : une extension
d'automatisation d'engagement à finalité crypto est exposée au refus en review Chrome
Web Store sous la politique spam/comportement trompeur.
**Nuance importante** : ce n'est pas une censure de la niche. Le pack `memecoin` parle
culture, mèmes, mécanique on-chain, dynamique communautaire. Il ne dit pas « ça va faire
×10 ». C'est aussi, accessoirement, la frontière entre une réponse qui gagne des
followers et une réponse qui se fait mute.
**Comment** : `src/governor/topic-guard.ts`, constante `UNIVERSAL_BLOCKED` non
surchargeable par un pack + règle miroir dans le prompt CRITIC.

### MH-03 · Kill switch et état d'orchestrateur persistés
**Décision** : le kill switch est un enregistrement Dexie, pas un booléen en mémoire.
Le snapshot XState est persisté à chaque transition.
**Pourquoi** : un service worker MV3 est tué sans préavis. Un kill switch en RAM se
relève tout seul au réveil suivant — c'est-à-dire qu'il ne marche pas du tout, et
précisément dans le cas où on en a besoin. Même raisonnement pour la file : un
orchestrateur en RAM perd les opportunités en cours.
**Comment** : `src/governor/killswitch.ts` lit Dexie à chaque `requestPermit()`.

### MH-04 · Hash de version de prompt sur chaque action
**Décision** : chaque `action` stocke le hash SHA-256 des prompts qui l'ont produite ;
table `promptVersions` séparée.
**Pourquoi** : sans ça la boucle d'apprentissage (le cœur du produit, §1.1) corrèle des
performances mesurées à J+7 à des prompts qui ont changé entre temps. Elle produirait
des conclusions confiantes et fausses — pire que pas de boucle du tout. C'est le seul
must-have de cette liste dont l'absence rendrait le différenciateur n°2 mensonger.
**Comment** : `src/swarm/prompts/index.ts` hashe au chargement ; le hash traverse
l'`agentTrail`.

### MH-05 · Budget segmenté avec réserve
**Décision** : 25 % du budget quotidien sanctuarisés pour CRITIC et ANALYST.
**Pourquoi** : avec un budget global unique, une journée de triage vorace épuise
l'enveloppe avant la relecture — et le système publie sans contrôle qualité. C'est
exactement le mode de défaillance que le CRITIC existe pour empêcher, réintroduit par la
comptabilité.
**Comment** : `src/llm/budget.ts`, buckets par rôle d'agent.

### MH-06 · Export / import chiffré de la base
**Décision** : export complet (JSON chiffré) et réimport, dès la Phase 0.
**Pourquoi** : « local-first » veut aussi dire « aucune sauvegarde ». Un profil Chrome
corrompu, une extension désinstallée par erreur, un `unlimitedStorage` évincé, et
l'utilisateur perd son Voice Profile, son CRM social et son historique de patterns —
soit la totalité de la valeur accumulée, qui est justement ce qu'aucun concurrent ne
peut lui rendre. Un produit dont la valeur s'accumule localement doit être exportable
dès le premier jour, pas quand quelqu'un aura perdu ses données.
**Comment** : `src/db/backup.ts` + bouton Config. Permission `downloads` optionnelle.

### MH-07 · Clé d'idempotence sur les actions
**Décision** : chaque action porte une `idempotencyKey` déterministe
(`postId + draftHash`), unique en base.
**Pourquoi** : le service worker peut mourir entre « brouillon mis en scène » et
« écriture en base ». Au réveil, l'orchestrateur rejoue son snapshot et remet le même
brouillon en scène. En Copilote c'est un doublon agaçant ; en Autopilote (Phase 8) c'est
une double réponse au même post — le comportement qui fait suspendre un compte.
**Comment** : index unique Dexie, `put` idempotent.

### MH-08 · Logger avec redaction, et un test qui l'assure
**Décision** : `src/shared/logger.ts` redacte clés API, passphrases, tokens ; test
unitaire qui échoue si un secret connu traverse.
**Pourquoi** : « jamais loggées » (spec §3.1) est une intention tant que rien ne la
vérifie. Une clé API dans la console d'un content script est lisible par n'importe quel
script de la page.
**Comment** : allowlist de champs sérialisables + `tests/unit/shared/logger.test.ts`.

### MH-09 · État `confirming` et détection d'abandon
**Décision** : nouvel état après `staging`. Observe l'apparition réelle de la réponse,
avec timeout → `published` / `abandoned`.
**Pourquoi** : en Copilote c'est l'humain qui clique Publier. Sans détection, ANALYST
mesure des actions qui n'ont jamais existé et la boucle d'apprentissage s'entraîne sur
du bruit. Bénéfice secondaire non trivial : le **taux d'abandon** est le désaccord
silencieux de l'utilisateur avec le CRITIC — un signal d'apprentissage gratuit que la
concurrence n'a même pas les moyens de collecter.
**Comment** : `src/content/actuator/failure-detect.ts` + état XState.

### MH-10 · Niche Pack comme artefact de premier ordre
**Décision** : voir SPEC.md §1.3.
**Pourquoi** : le compte pilote est memecoin, la clientèle ne l'est pas. Si la niche
fuit dans le TypeScript, chaque nouveau client devient un fork. Un pack déclaratif rend
l'agnosticisme **testable** (la CI fait tourner deux packs) au lieu de simplement
affirmé — et devient un actif commercial séparément vendable.
**Comment** : `src/niches/`, schéma Zod, test d'agnosticisme bloquant.

### MH-11 · i18n dès la Phase 0
**Décision** : toutes les chaînes UI passent par `t()`, catalogues FR + EN.
**Pourquoi** : coût quasi nul maintenant, coût élevé plus tard. L'utilisateur est
francophone, la clientèle CWS sera majoritairement anglophone. Retrofiter l'i18n sur
quatre onglets et un onboarding, c'est une semaine perdue en Phase 8.
**Comment** : `src/shared/i18n.ts` (léger, pas de dépendance lourde).

### MH-12 · Écran de consentement + zéro télémétrie par défaut
**Décision** : étape 1 de l'onboarding = consentement explicite (règles X, limites, ce
que le produit ne fait pas). Aucune télémétrie, aucun analytics produit, sans opt-in.
**Pourquoi** : obligation morale et pratique. L'utilisateur doit savoir *avant* de
connecter son compte que l'automatisation d'engagement sur X porte un risque, même en
Copilote. Et une extension local-first qui phone-home discrètement perd son unique
argument de confiance.
**Comment** : `src/sidepanel/onboarding/Step0Consent.tsx`, consentement horodaté en
base ; aucun endpoint de télémétrie dans le code.

### MH-13 · Rétention de données et purge automatique
**Décision** : le texte brut des posts non retenus est purgé après 30 jours
(configurable) ; les opportunités rejetées gardent le motif, pas le contenu.
**Pourquoi** : un vector store et une table `opportunities` qui grossissent sans borne
finissent par se faire évincer par le navigateur — et on garde par défaut le contenu de
tiers qui n'a servi à rien. Exception explicite : l'archive du backtest (Phase 7), qui
est un opt-in nommé avec sa propre durée de vie.
**Comment** : alarme quotidienne `purge`, `src/db/retention.ts`.

### MH-14 · Capture de snapshot DOM à la rupture de sélecteur
**Décision** : quand un sélecteur ne matche plus, on capture le fragment DOM
**anonymisé** (handles et textes remplacés) en fixture locale, et on alerte.
**Pourquoi** : SPEC §8 dit « alerte au lieu d'échec silencieux ». Une alerte sans
preuve oblige à reproduire le bug à l'aveugle. Un fragment anonymisé transforme une
rupture en fixture de test — c'est-à-dire en réparation de 20 minutes au lieu d'une
soirée. Vu que le DOM de X est le premier risque de maintenance du produit, c'est
l'outil qui rentabilise le plus vite.
**Comment** : `src/content/dom/snapshot-on-break.ts` → `tests/fixtures/x-dom/`.

### MH-15 · Mode `dry-run` par défaut en développement
**Décision** : un flag de build met le governor en mode simulation ; aucune écriture DOM
possible. Il faut un opt-in explicite pour agir sur un vrai compte.
**Pourquoi** : le développement de ce produit se fait sur un vrai compte X. Un bug
pendant un test qui met 40 brouillons en scène, ou pire, est un accident évitable par
défaut. La simulation existe déjà en Phase 7 pour le backtest — l'avoir dès la Phase 0
coûte une variable.
**Comment** : `src/shared/env.ts` → `MODE`, vérifié dans `requestPermit()`.

### MH-16 · Chaîne de repli provider + gestion du 429
**Décision** : chaque appel déclare un provider primaire et un repli ; les 429/5xx
partent en backoff exponentiel avec jitter, les 4xx non-retryables échouent vite.
**Pourquoi** : OpenRouter route vers des fournisseurs tiers dont la disponibilité n'est
pas garantie. Sans repli, une indisponibilité amont fige le swarm en silence. Et un
retry aveugle sur un 400 brûle du budget sans jamais réussir.
**Comment** : `src/llm/retry.ts`, classification des erreurs dans `src/llm/errors.ts`.

### MH-17 · Horloge et RNG injectables
**Décision** : aucun `Date.now()` ni `Math.random()` direct dans `src/`. Un lint
l'interdit.
**Pourquoi** : sans horloge injectable, la cadence log-normale, les fenêtres horaires et
le réveil J+1/J+7 ne sont pas testables — on livrerait le governor sur la foi d'une
relecture. Sans RNG seedable, le backtest de la Phase 7 n'est pas reproductible, donc
inutilisable pour comparer deux configs.
**Comment** : `src/shared/time.ts`, `src/shared/rng.ts`, règle ESLint `no-restricted-globals`.

---

## Partie B ter — Le compte pilote change une hypothèse de la Phase 2

### D-11 · @ACMECTO est un compte de projet, dont la voix native est interdite par MH-02

**Constat.** Le compte pilote est le compte du token $acme sur Solana. Sa voix native est
promotionnelle : annonces, adresses de contrat, formulations de type « maximum potential »,
« from microcap to legendary ».

Ces formulations sont exactement celles que le noyau universel du topic-guard bloque
(MH-02), et ce blocage n'est pas négociable — c'est lui qui protège le compte d'une
suspension pour spam financier.

**Le problème que ça pose, et qui n'était pas visible avant de regarder le compte.** Un
Voice Profile extrait naïvement de ce corpus encoderait le registre promotionnel comme
« la voix de l'utilisateur ». Le WRITER apprendrait à shiller, le CRITIC rejetterait 100 %
de ses variantes, et le produit serait mort-né sur son propre compte pilote — en donnant
l'impression que le CRITIC est mal calibré alors qu'il ferait exactement son travail.

**Ce que ça change dans le design.** Le Voice Profile doit séparer deux choses que la spec
traitait comme une seule :

| | Extrait du corpus | Reproduit par le WRITER |
|---|---|---|
| **Forme** — longueur, rythme, ponctuation, retours à la ligne, majuscules, emojis, tics | oui | oui |
| **Registre de contenu** — ce dont le compte parle et comment il le vend | oui, mais filtré | seulement ce qui passe le garde-fou |

La forme est légitimement imitable et c'est elle qui porte l'essentiel de la
reconnaissabilité. Le registre passe par un filtre : voir MH-18.

**Ce que ça implique pour le produit, et qu'il faut dire à l'utilisateur.** SWARM n'écrira
pas de posts de promotion pour $acme. Il écrira des réponses de **culture memecoin** —
mèmes, mécanique on-chain, dynamique de communauté. C'est ce que MH-02 avait décidé ; le
compte pilote en fait maintenant une conséquence concrète et visible.

---

### MH-18 · Le Voice Profile sépare la forme du registre, et assainit le registre

**Décision** : l'extraction du Voice Profile passe le corpus au topic-guard avant d'en
dériver les règles de registre. Les statistiques de **forme** sont calculées sur le corpus
entier ; les **exemples canoniques** et les **règles do** ne sont tirés que des posts qui
passent le garde-fou. Le profil expose `guardExcludedRatio`.

**Pourquoi** : sans ce filtre, le Voice Profile devient le canal par lequel le contenu
interdit rentre dans le produit — non pas malgré les garde-fous, mais *à travers* eux, sous
l'étiquette « c'est le style de l'utilisateur ». C'est le contournement le plus naturel et
le moins visible du noyau MH-02, et il n'aurait été découvert qu'en Phase 5, quand le taux
de rejet du CRITIC aurait été inexplicablement à 100 %.

**Effet secondaire utile** : `guardExcludedRatio` est un diagnostic honnête. S'il est à
90 %, le produit peut le dire — « la voix de ce compte est à 90 % non reproductible sous les
garde-fous » — au lieu de produire silencieusement une imitation dégradée.

**Comment** : `memory/voice-profile.ts`, avec un test qui vérifie qu'aucun terme du lexique
banni ni aucun motif du noyau universel ne peut apparaître dans une règle `do`.

---

## Partie B bis — Décisions révisées en cours de construction

Trois choix pris en Phase 1 ont été **corrigés par les tests**, pas par relecture. Ils sont
consignés ici parce que la version initiale paraissait raisonnable, et que c'est exactement
le genre de décision qu'on reprendrait à l'identique sans trace écrite.

### D-08 · Shadow DOM en mode `open`, pas `closed`
**Choix initial** : `closed`, pour l'isolation maximale.
**Corrigé en** : `open`.
**Pourquoi** : `closed` empêche seulement de lire `.shadowRoot` depuis la page. Il n'empêche
pas x.com de retirer notre nœud hôte, donc il n'apporte aucune sécurité réelle dans ce
modèle de menace — et notre contenu n'est pas secret. En revanche il coûte cher : Playwright
ne traverse pas une racine fermée, ce qui rendait l'overlay **intestable de bout en bout**,
et il gêne l'introspection des outils d'accessibilité alors que SPEC §8 exige une navigation
clavier complète. L'isolation des styles, seul bénéfice recherché, est identique dans les
deux modes. Découvert par un E2E qui ne trouvait pas son propre bouton.

### D-09 · `queryAll` prend l'union des candidats, pas le premier qui matche
**Choix initial** : renvoyer les résultats du premier candidat de la cascade, pour éviter
les doublons.
**Corrigé en** : union de tous les candidats, dédupliquée par identité de nœud.
**Pourquoi** : X déploie ses changements de DOM **progressivement**. Pendant plusieurs
jours, l'ancienne et la nouvelle structure coexistent dans le même fil. « Premier candidat
gagnant » aurait ignoré la moitié de la timeline, en silence, sans qu'aucun sélecteur ne
paraisse cassé — le pire mode de défaillance possible pour ce module, puisqu'il n'aurait
déclenché aucune alerte. Le `Set` règle le problème des doublons qui avait motivé le choix
initial. Découvert par un test d'observer qui ne voyait pas un post en DOM dégradé.

### D-10 · Mesure de fluidité par latence du fil principal, pas par FPS
**Choix initial** : compter les images rendues pendant un défilement (SPEC §8 dit « mesure
de FPS »).
**Corrigé en** : mesurer le pire retard d'un minuteur à 0 ms pendant le défilement.
**Pourquoi** : `requestAnimationFrame` est fortement bridé dans un onglet non visible, ce
qui est le cas par défaut en CI. Le test mesurait le bridage du navigateur, pas notre coût,
et échouait pour une raison sans rapport avec le produit. La latence des minuteurs n'est pas
bridée et mesure directement ce qui nous intéresse : le blocage du fil principal. C'est une
meilleure mesure de la même propriété, pas un renoncement.

---

## Partie B quater — Décisions des phases 4 à 8

Quatre arbitrages pris en construisant les dernières phases. Les deux premiers corrigent des
défauts réels, découverts en branchant les pièces entre elles — aucun test unitaire ne pouvait
les voir, puisque chaque pièce prise séparément était correcte.

### D-13 · Le coffre est mis en cache pour la session du navigateur

**Défaut trouvé.** `buildKeystore()` reconstruisait un keystore **verrouillé** à chaque appel,
et le clair ne vivait que dans l'objet. En MV3 le service worker meurt après ~30 s : un
déverrouillage fait dans le side panel n'existait donc plus au message suivant. Le produit
pouvait demander la passphrase indéfiniment sans jamais réussir un appel LLM. Ce n'était pas
une fragilité, c'était un chemin **inatteignable**.

**Décision.** Le coffre déchiffré est mis en cache dans `chrome.storage.session` — en mémoire,
jamais écrit sur le disque, effacé à la fermeture du navigateur — avec un TTL de 8 h et un
bouton « verrouiller maintenant ». La passphrase, elle, n'est stockée nulle part, et un test
vérifie qu'elle n'apparaît jamais dans le cache.

**Ce que ça coûte, dit franchement.** C'est un affaiblissement réel par rapport à « le clair
ne quitte pas une invocation » : du code exécuté dans le contexte de l'extension pendant la
session lit le coffre. Ce même code lirait la clé au premier appel sortant, donc l'écart de
risque est faible ; la limite est déjà énoncée dans `PRIVACY.md`, et la contrepartie est une
extension qui fonctionne. Atténuation à recommander à l'utilisateur, et l'écran le fait : une
clé dédiée avec un plafond de dépense côté fournisseur.

### D-16 · Le hash du journal d'audit porte sur une liste fermée de champs

**Défaut trouvé.** `hashEntry()` hachait l'objet entier. Dès que le journal est adossé à
Dexie, la ligne relue porte une clé primaire `id` en plus — donc le hash recalculé n'était
jamais celui écrit, et `verifyChain()` déclarait la chaîne **rompue à la première entrée,
toujours**. Le journal « inaltérable » était invérifiable en production, et seuls les tests en
mémoire pouvaient passer. Découvert en écrivant l'écran qui affiche le journal, c'est-à-dire au
premier endroit où la vérification devenait visible.

**Décision.** `HASHED_FIELDS` liste explicitement les champs de contenu couverts. Un champ
ajouté par le stockage n'a plus d'effet ; et un test échoue si un champ de contenu est ajouté à
`AuditEntry` sans être ajouté à la liste — sinon il serait modifiable en base sans que la
chaîne bronche.

### D-12 · Les images sont un brief, pas une génération

**Décision.** `swarm/media/image-brief.ts` produit une consigne prête à coller et le texte
alternatif correspondant. Aucun fournisseur d'images n'est embarqué, et rien n'est joint au
composeur de X.

**Trois raisons, par poids réel :**

1. **Le budget.** Une image coûte de trois à quarante fois une réponse texte complète. À
   1 €/jour, deux images par jour mangent le budget de qualification — c'est-à-dire ce qui
   produit la valeur. Une journée illustrée serait une journée sans opportunités.
2. **Joindre un fichier est une automatisation d'un autre ordre.** Taper du texte dans un
   champ que l'humain valide, c'est le Copilote. Fabriquer un `DataTransfer` et déclencher un
   `drop` sur l'`input[type=file]` de X est un signal d'automatisation nettement plus net,
   pour un gain esthétique.
3. **Une image engage plus que du texte.** Un graphique inventé ne se rattrape pas par une
   réponse de suivi. C'est pourquoi le brief **impose** la liste des chiffres présents dans le
   brouillon et interdit tout autre chiffre : c'est le garde-fou central du module.

`IMAGE_PROVIDERS` est vide et `IMAGE_GENERATION_IMPLEMENTED === false` est asserté par un
test : le produit livré ne dépense rien en images.

### D-14 · La mesure J+1 / J+7 est passive

**Décision.** Les métriques d'un post publié sont relevées **quand l'utilisateur passe sur son
profil ou son fil**, via la table `ownPosts`. SWARM n'ouvre aucun onglet de son propre chef.

**Pourquoi.** Le chemin évident — ouvrir `x.com/<handle>/status/<id>` à J+1, lire, fermer —
est exactement le comportement d'automatisation que le produit refuse, et c'est aussi le signal
le plus visible côté X. Il ne fonctionnerait de toute façon qu'avec le navigateur ouvert.

**Conséquence assumée, et affichée.** La couverture de mesure est partielle.
`measurementCoverage` la chiffre, l'onglet Analytics l'affiche **avant** le classement des
patterns, et sous 60 % il dit explicitement que le classement ne porte pas sur toutes les
réponses. Un pattern calculé sur une couverture inconnue n'est pas un pattern.

**Limite qui reste ouverte.** L'attribution d'abonnés vaut zéro, faute de relevés du nombre
d'abonnés — le DOM de X ne l'expose pas dans le fil. Le coût par abonné gagné n'est donc pas
affiché du tout, plutôt que divisé par une mesure absente. Voir TODO Phase 5.

### D-15 · L'orchestrateur XState n'est pas branché au service worker

**État.** `swarm/orchestrator.machine.ts` est écrit, testé, avec ses snapshots persistés et
ses régions parallèles. Le service worker, lui, fonctionne en requête/réponse : le content
script observe, le handler qualifie, la file se remplit, l'utilisateur décide.

**Pourquoi c'est cohérent et non un oubli.** Le Copilote n'a pas de boucle autonome à faire
avancer : chaque action part d'un geste de l'utilisateur. La machine sert le cycle autonome —
donc l'Autopilote, qui n'est pas implémenté — et la détection d'abandon, qui a besoin d'une
journée réelle pour être réglée. La brancher maintenant ajouterait un ordonnanceur que rien ne
pilote.

**Ce que ça laisse à faire est écrit dans TODO Phase 4**, avec la journée instrumentée qui
sert de DoD.

---

## Partie B quinquies — Ce que la première clé API a révélé (2026-08-26)

Quatre défauts, trouvés en une heure de mesures réelles, qu'aucun test à réponse factice ne
pouvait voir. Ils partagent un trait : **aucun ne provoque d'erreur visible**. Le produit
tournait, les 984 tests passaient, et trois de ces quatre défauts rendaient le produit
inutilisable ou hors budget.

C'est l'argument le plus solide pour ces mesures : elles ne vérifient pas que le code fait ce
qu'on croit, elles vérifient que **le monde est comme on le croit**.

### D-17 · La comptabilité des tokens d'OpenRouter est inverse de celle d'Anthropic

**Défaut.** `computeCostEur` facture l'entrée au plein tarif et le cache à 10 %, ce qui est
correct **avec la convention d'Anthropic** : `input_tokens` y exclut les tokens cachés.
OpenRouter, lui, met le total dans `prompt_tokens`, dont `cached_tokens` est un sous-ensemble.
Résultat : les tokens cachés étaient facturés deux fois, dont une au plein tarif.

**Mesure.** Un appel à 3 135 tokens cachés sur 3 150 était estimé **0,0096 €** au lieu de
**0,0010 €**. Le cache de prompt, dont toute l'architecture existe pour diviser le coût par
dix, **multipliait la facture estimée par dix**.

**Conséquence produit.** Le coût réel facturé par OpenRouter était juste ; c'est notre
estimation qui dérivait. Donc le plafond quotidien coupait après un dixième du budget réel :
le produit s'arrêtait en croyant avoir dépensé son euro. Le mode de défaillance le plus
frustrant possible — tout marche, mais peu et sans raison apparente.

### D-18 et D-19 · Le DoD de la Phase 3 était manqué, pour deux raisons empilées

Le triage de 200 posts coûtait **0,065 €** au lieu des 0,05 € promis, et trois lots sur quatre
échouaient. Deux causes distinctes, découvertes l'une après l'autre :

**1. `effort: 'low'` n'économise pas, il dépense** (D-19). Sur les modèles à raisonnement
étendu, un effort — même « low » — **active** la réflexion, et les tokens de réflexion sont
facturés en sortie, au tarif le plus cher. Les quatre lots étaient tronqués par le plafond de
sortie avant d'avoir écrit un verdict. Trier un post n'est pas une tâche de raisonnement :
c'est une classification, cinquante fois de suite, sur un critère écrit dans le prompt.
`effort` est désormais **optionnel** dans `RouteConfig`, et absent pour le QUALIFIER — le champ
était obligatoire, ce qui forçait à choisir un niveau là où le bon choix est « aucun ».

**2. Les noms de clés coûtaient plus que les données** (D-18). La sortie objet
`{ "id": "0", "relevance": 0.9, "angle": "data", "note": "…" }` pesait ~54 tokens par verdict,
dont la moitié en clés répétées cinquante fois par lot. Le format est devenu un tuple —
`["0",0.9,"data"]` — et `note` est optionnelle, omise par défaut.

**Résultat mesuré** : **10,2 tokens par verdict** (contre 54), 200/200 verdicts, zéro échec,
zéro réparation, **0,025 € pour 200 posts** — DoD atteint avec une marge de 2. Le chiffrage
d'origine annonçait 25 tokens par verdict : il était faux **dans les deux sens**, et seule la
mesure le disait.

Correctif de robustesse au passage : un angle inventé par le modèle (« insight »,
« clarification » — trois ou quatre par lot) invalidait le lot entier et déclenchait un appel
de réparation. Un angle inconnu n'est pas une donnée corrompue, c'est un angle qu'on ne sait
pas exploiter : il devient `null`, comme le faisait déjà `interpret` pour les angles hors pack.

### D-20 · Le seuil de veto du CRITIC était trop haut, et ça ne se voyait pas

**Mesure** (`npm run calibrate:critic`, rapport dans `docs/critic-calibration.md`) : sur les
18 réponses étiquetées à la main, le CRITIC discrimine nettement — les 6 à publier notent 0,30
à 0,65, les 12 à rejeter notent 0,00 à 0,20. Aucun faux positif à aucun seuil.

**Mais** : tout seuil de 0,30 à 0,55 donne le même résultat, et à **0,60 — l'ancien défaut —
le rappel s'effondre de 83 % à 17 %**. Cinq bonnes réponses sur six auraient été rejetées.

C'est exactement le scénario que D-11 anticipait pour un compte de projet, et il serait passé
pour un problème de rédaction : aucune erreur, aucun crash, juste un produit qui refuse presque
tout. Le diagnostic aurait été cherché du côté du WRITER ou du Voice Profile pendant des jours.

Le défaut est passé à **0,45** — le **milieu du plateau**, pas son bord. `calibrate()` a été
corrigé pour ça : il recommandait le seuil le plus sévère à score égal, ce qui plaçait la
recommandation à un pas d'une falaise. Le milieu a le même score mesuré et la marge maximale
des deux côtés, ce qui est la seule qualité qui compte pour un seuil qu'une mise à jour de
modèle fera dériver.

**Réserve** : 18 échantillons, c'est indicatif. Le rapport le dit et fixe la cible à 40+.

### D-21 · Le `.env` ne peut pas atteindre le bundle

Un `.env` existe désormais, pour les mesures. Le risque est précis : Vite expose au code client
**toute variable préfixée `VITE_`**. Nommer la clé `VITE_OPENROUTER_KEY` — le réflexe naturel —
l'inlinerait dans `dist/`, puis dans le zip, puis au Chrome Web Store. Rien n'échouerait ;
l'extension marcherait même mieux, puisqu'elle n'aurait plus besoin du coffre.

Trois gardes : aucune variable `VITE_` dans `.env` ni `.env.example` (test), `src/` ne lit que
`MODE` depuis `import.meta.env` (test), et `dist/` ne contient aucun motif de clé (test, quand
le bundle existe). Plus la vérification que `.env` est bien dans `.gitignore` — sans elle, la
première clé collée part au premier commit.

Les mesures elles-mêmes tournent via Vitest et non via `node`, avec leur propre configuration
(`vitest.live.config.ts`) : les modules de `src/` utilisent l'alias `@/`, que le résolveur ESM
de Node ne suit pas. Elles s'exécutent donc contre **le vrai code de production**, sans copie
— ce qui est tout l'intérêt d'une mesure — et `npm run test` reste hermétique et gratuit.

---

## Partie B sexies — La première installation dans Chrome (2026-08-26)

Trois défauts, et le premier est le plus grave du projet : **l'extension était intégralement
inerte**, avec 1 000 tests verts.

### D-22 · Le service worker exécutait le code du content script

**Symptôme.** Installée dans Chrome, l'extension se chargeait, affichait son side panel, et
laissait **tous** les messages expirer. Le panel restait indéfiniment sur « Lecture de la
configuration… ». Aucune erreur, aucun log, aucun indice.

**Diagnostic.** `chrome.runtime.onMessage.hasListeners()` renvoyait `false` dans le worker. En
suivant le graphe d'imports du bundle : `service-worker-loader.js` importait le chunk du
**content script**. Le worker exécutait donc le code du scout — qui n'enregistre aucun écouteur
de message.

**Cause.** Le point d'entrée s'appelait `src/background/index.ts`, le content script
`src/content/index.ts`, et **@crxjs indexe ses entrées par nom de base**. Les deux
collisionnaient. Le loader généré portait déjà l'indice, visible après coup :
`index.ts-loader-<hash>.js`.

**Correctif.** `src/background/service-worker.ts`. Plus deux gardes, parce qu'un nom de fichier
est exactement le genre de chose qu'on renomme sans y penser : un test unitaire qui suit le
graphe du bundle et vérifie que l'écouteur y est (et que le code du content script n'y est
pas), et le même contrôle dans `scripts/build-zip.ts` — un zip se construit parfois sans lancer
les tests.

**Ce que ça dit sur la suite de tests.** 1 000 tests passaient. Ils testent le *code* ; celui-ci
était juste. Le défaut était dans l'**assemblage**, et rien ne regardait l'assemblage. C'est la
même leçon que les mesures réelles de la veille, appliquée au build : il faut vérifier
l'artefact, pas seulement les sources.

### D-23 · Pas d'import dynamique dans un service worker

En corrigeant D-22, la première version chargeait chaque handler à la demande — pour que
l'écouteur soit enregistré avant tout et qu'un module cassé ne rende pas le produit muet.
Bonne intention, mauvais résultat : Vite entoure chaque `import()` d'un helper de préchargement
qui insère un `<link rel="modulepreload">` et écoute `window`. Dans un worker, `document` et
`window` n'existent pas — chaque handler échouait sur « document is not defined », une erreur
qui ne dit rien de sa cause.

`build.modulePreload: false` supprime l'insertion du `<link>` mais pas le helper, encore utilisé
pour le CSS des imports dynamiques. Les imports du service worker sont donc **statiques**, ce
qui est aussi le motif standard en MV3. Le réglage `modulePreload: false` est conservé : il
faisait aussi apparaître des avertissements « cross-world extension resource mismatch » dans la
console des pages d'extension, pour des chunks préchargés jamais réutilisés.

Ce qui est gardé de l'intention initiale : les écouteurs sont enregistrés **au niveau supérieur,
sans `await` avant**. MV3 ne réveille le worker sur un événement que si l'écouteur a été ajouté
pendant l'évaluation initiale du module ; un `await` placé plus haut et les alarmes ne
réveillent plus rien — la mesure J+1/J+7 et la purge s'arrêteraient sans erreur.

Un fil d'Ariane (`swarm:boot:step` dans `chrome.storage.local`) marque l'étape atteinte au
démarrage. Une exception pendant l'évaluation du module d'un worker **disparaît** : pas de
console ouverte, pas d'utilisateur pour la voir. Ce marqueur transforme « rien ne répond » en
« le module s'est arrêté à telle étape ».

### D-24 · Le consentement était impossible à accorder

`hasConsented()` gardait les trois chemins qui dépensent ou agissent — triage, rédaction depuis
la file, rédaction depuis l'overlay — et **rien n'appelait `acceptConsent()`**. MH-12 nommait
l'écran ; il n'avait jamais été écrit.

Une extension fraîchement installée affichait donc ses quatre onglets et refusait tout, en
silence : chaque garde renvoyait un refus poliment formaté que personne n'affichait au bon
endroit. Aucun test ne pouvait le voir — les tests des handlers accordent le consentement
eux-mêmes dans leur préparation.

`Step0Consent.tsx` énonce trois choses avant les onglets : le risque de suspension même en
Copilote, ce que le produit ne fait pas, ce que ça coûte et où. Le refus est possible et sans
conséquence — un consentement qu'on ne peut pas refuser n'en est pas un. Une case à cocher, pas
une phrase à recopier : la friction se calibre sur le risque, et recopier une phrase est réservé
à l'autopilote. L'E2E parcourt maintenant la première ouverture complète, refus inclus.

---

## Partie C — Réserves assumées

### R-01 · L'Autopilote reste contraire aux règles de X
Aucune quantité de cadence log-normale ne rend l'Autopilote conforme. Le produit est
construit pour être excellent en Copilote ; la Phase 8 existe parce que la spec la
demande, derrière un opt-in et un écran d'avertissement. La position par défaut, y
compris commercialement, reste le Copilote. Documenté dans `docs/risks-and-limits.md`.

### R-02 · ~~Le DoD de la Phase 2 n'est pas mesurable en l'état~~ — **clôturée**
Protocole figé et préenregistré dans [`docs/blind-test-protocol.md`](./docs/blind-test-protocol.md)
le 2026-08-25 : 10 paires, 3 juges, réponse forcée, seuil ≤ 60 % d'identifications
correctes, ordre A/B tiré au sort avec graine consignée.

Le fichier dit aussi ce que le test **ne** mesure pas — il mesure l'indiscernabilité, pas la
qualité — et pose la contrainte propre à ce compte : les paires excluent les posts purement
promotionnels, qu'il serait absurde de comparer à des réponses que SWARM a interdiction de
produire (voir D-11).

### R-03 · ~~Le prompt caching via OpenRouter est une hypothèse~~ — **clôturée, mesurée**
**Mesuré le 2026-08-26** (`npm run measure:cache`) : la propagation fonctionne. Deux appels à
préfixe identique sur `anthropic/claude-sonnet-5`, préfixe de 1 764 tokens →
**3 135 tokens lus depuis le cache**, soit la totalité du préfixe, facturés à 10 %. Le
chiffrage de SPEC §3.2 tient et la bifurcation vers Anthropic direct n'est pas nécessaire.

**Nuance mesurée, qui n'était pas dans l'hypothèse** : le cache ne s'applique **pas au
QUALIFIER**. Sur quatre lots consécutifs, l'entrée reste identique d'un appel à l'autre —
aucun token lu. Explication la plus probable : son préfixe fait ~1 400 tokens, sous le minimum
de mise en cache pour Haiku. Le DoD de la Phase 3 tient sans cache (mesuré à 0,025 € pour
200 posts), donc rien n'en dépend ; mais tenir le cache pour acquis y ferait sous-estimer le
coût du triage de moitié.

### R-05 · Le topic-guard ne fait pas de morphologie
« doxxent » n'est pas reconnu comme une forme de « doxxing ». C'est la limite d'un
classifieur lexical, et la contourner par un préfixe de 4 lettres créerait des faux
positifs ailleurs (« deve » matcherait « devenir »). C'est assumé et figé par un test
nommé `LIMITE CONNUE` : la limite doit être visible dans la suite de tests plutôt que
découverte en production.

Ce garde-fou doit rester **gratuit, déterministe et indépendant du réseau** — c'est
précisément sa valeur. Le classifieur LLM de la Phase 3 traitera les cas limites *en plus*
de celui-ci, jamais à sa place : un garde-fou qui dépend d'un appel réseau et d'un budget
quotidien n'est pas un garde-fou.

### R-06 · Le chaînage par hash rend la falsification détectable, pas impossible
`auditLog` est chaîné par hash et `verifyChain()` signale toute rupture. Mais en local,
rien n'empêche un attaquant ayant accès à IndexedDB de reconstruire une chaîne cohérente.
C'est le maximum atteignable sans serveur, et le mot « inaltérable » de la spec §2.4 doit
se lire « altération détectable ». Documenté ainsi dans le code.

### R-07 · Les fixtures DOM sont synthétisées, pas capturées
`tests/fixtures/x-dom/` reproduit la structure de X à partir de ses `data-testid`
documentés. Un test vert sur ces fixtures prouve que **le parseur fait ce qu'on croit**, pas
que **X ressemble à ça**. Confondre les deux donnerait une confiance imméritée : la suite
resterait verte le jour où X change son DOM.

La vérification contre le DOM réel passe par `snapshot-on-break.ts` (MH-14), qui capture un
fragment anonymisé à la première rupture. C'est écrit dans le README des fixtures pour que
personne ne se croie couvert par la suite unitaire.

### R-08 · Le topic-guard du prompt et celui du code peuvent divergent
Les garde-fous existent en deux endroits : le texte du prompt (`_shared/guardrails.md`) et
le classifieur lexical (`governor/topic-guard.ts`). Un test vérifie que le prompt énonce les
catégories que le code applique, mais rien ne garantit qu'ils resteront exactement
équivalents. C'est accepté : ils ne font pas le même travail — le prompt oriente la
génération, le code refuse la sortie. La redondance est voulue ; la divergence, à surveiller.

### R-09 · La couverture de mesure dépend du comportement de l'utilisateur
La boucle d'apprentissage se nourrit de relevés passifs (D-14). Un utilisateur qui ne consulte
jamais son profil publie sans jamais mesurer, donc n'apprend rien — et le produit ne peut pas
le lui reprocher, seulement le lui dire. `measurementCoverage` est affichée pour ça, avec une
invite explicite à ouvrir son profil.

C'est une limite structurelle du choix « aucune navigation autonome », pas un défaut à
corriger. Si elle se révèle bloquante à l'usage, la sortie est un bouton **explicite** « relever
maintenant » qui ouvre le profil sur un geste de l'utilisateur — jamais un onglet qui s'ouvre
seul.

### R-10 · L'attribution d'abonnés est inerte tant qu'aucun relevé n'existe
`analytics/attribution.ts` est écrit, testé, et n'a aucune donnée à traiter : le nombre
d'abonnés n'est lu nulle part. Conséquence — `attributedFollows` vaut 0 partout, et le score
d'engagement perd son terme le plus lourd (×20). Les patterns restent comparables entre eux,
puisque le biais est constant, mais « coût par abonné gagné » n'est pas affichable et ne l'est
pas. Débloquer demande un sélecteur sur la page de profil, donc une fixture capturée sur le
DOM réel (voir R-07). Suivi dans TODO Phase 5.

### R-04 · Le plafond à 12 réponses/jour est un choix, pas une limite technique
Le budget en supporte davantage. 12 est un choix de qualité et de charge d'attention en
Copilote. À relever quand l'onglet Analytics montrera un taux d'acceptation stable.

---

## Partie D — Questions ouvertes

| # | Question | Bloque | Défaut si sans réponse |
|---|---|---|---|
| ~~Q-01~~ | ~~Handle X du compte pilote~~ | — | **Résolu : @ACMECTO** (voir D-11) |
| Q-02 | Compte X de test pour Playwright | E2E (Phase 1) | E2E stubbés sur fixtures |
| Q-03 | Langues à gérer | QUALIFIER (Phase 3) | FR + EN |
| ~~Q-04~~ | ~~Protocole exact du blind test~~ | — | **Résolu**, préenregistré (voir R-02) |
| Q-05 | Le produit sera-t-il vendu via le CWS ou distribué en `.crx` ? | Phase 8 | CWS |
