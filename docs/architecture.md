# Architecture

## Les quatre contextes MV3

Une extension Manifest V3 n'est pas une application : c'est quatre processus aux durées
de vie différentes qui doivent coopérer. Presque toutes les contraintes d'architecture
de SWARM viennent de là.

| Contexte | Durée de vie | Rôle dans SWARM | Ne peut pas |
|---|---|---|---|
| **Service worker** (`background/`) | Éphémère, tué sans préavis (~30 s d'inactivité) | Orchestrateur, routage des messages, alarmes | Garder un état en RAM, tenir un calcul long |
| **Content script** (`content/`) | Vit avec l'onglet X | SCOUT (lecture), overlay, actuator (écriture composeur) | Faire des requêtes cross-origin librement, accéder à IndexedDB de l'extension |
| **Side panel** (`sidepanel/`) | Vit tant qu'il est ouvert | UI, cockpit, validation humaine | Être supposé ouvert |
| **Offscreen document** (`offscreen/`) | Créé à la demande, longue durée | Embeddings, WASM, agrégations | Toucher au DOM de X |

### Conséquences directes

**L'orchestrateur ne peut pas garder son état en mémoire.** Le snapshot XState est
persisté en base à chaque transition et rejoué au réveil du service worker. C'est une
contrainte, pas une optimisation.

**Le kill switch est un enregistrement, pas un booléen.** Un kill switch en RAM se
relève tout seul au réveil suivant. Voir `FEEDBACK.md` § MH-03.

**Toute action est idempotente.** Le service worker peut mourir entre l'action et son
enregistrement ; au réveil il rejoue. Sans clé d'idempotence, le même brouillon est mis
en scène deux fois. Voir § MH-07.

**Les traitements longs vont dans l'offscreen document.** Les embeddings, la recherche
vectorielle WASM et les agrégations d'analytics dépassent la fenêtre du service worker.

## Flux de données

```
   x.com (onglet utilisateur)
        │
        │  MutationObserver, lecture passive, débit throttlé
        ▼
   ┌─────────────────┐   PostSnapshot (validé Zod)   ┌──────────────────────┐
   │ content/scout   │ ────────────────────────────▶ │  background/router   │
   └─────────────────┘                               └──────────┬───────────┘
                                                                │
                                          snapshot persisté      ▼
                                                     ┌──────────────────────┐
                                                     │ swarm/orchestrator   │
                                                     │      (XState)        │
                                                     └──────┬───────┬───────┘
                                                            │       │
                        appels modèles, budget, retry        │       │  lecture/écriture typée
                                    ┌───────────────────────▶│       ▼
                          ┌─────────┴────────┐               │  ┌─────────────────┐
                          │   llm/client     │               │  │ db/repositories │
                          │  (seule sortie)  │               │  │    (Dexie)      │
                          └─────────┬────────┘               │  └────────┬────────┘
                                    ▼                        │           │
                            provider LLM choisi              │           │  embeddings
                                                             │           ▼
                    governor.requestPermit() ────────────────▶│  ┌─────────────────┐
                    (unique porte vers une action)            │  │   offscreen     │
                                    │                         │  │  vector store   │
                                    ▼                         │  └─────────────────┘
                        ┌───────────────────────┐             │
                        │ content/actuator      │             ▼
                        │  stage-draft.ts       │      ┌─────────────────┐
                        │ (n'a jamais soumis)   │      │   sidepanel     │
                        └───────────────────────┘      │  4 onglets      │
                                                       └─────────────────┘
```

Deux invariants lisibles sur ce schéma :

- **`llm/client.ts` est le seul module qui sort du navigateur.** Un `fetch` ailleurs
  dans `src/` est un bug de revue.
- **`governor.requestPermit()` est le seul chemin vers une action.** Le type
  `StagePermit` est opaque : seul le governor peut en construire une instance, donc le
  compilateur refuse une action non autorisée.

## Machine à états

Deux régions parallèles. La gouvernance tourne en permanence, indépendamment du pipeline
— c'est ce qui permet au kill switch d'être traité même pendant un appel LLM en cours.

```
region governance          nominal ⇄ paused (budget épuisé)
                                   ⇄ degraded (sélecteur cassé : lecture ok, écriture interdite)
                                   → halted (KILL — état absorbant, seul RESUME en sort)

region pipeline   idle
                   ├─ TICK ──────────▶ scouting ──▶ qualifying ──┐
                   └─ MANUAL_TRIGGER ─────────────────────────┐  │   (overlay : court-circuite le triage)
                                                              ▼  ▼
                                            drafting (strategizing ─▶ writing)
                                                              │
                                                              ▼
                                                          reviewing ──┬─ veto ─▶ nextOpportunity
                                                              │       │
                                                              ▼       └─ passé
                                                           queued
                                            ┌──────────────────┼──────────────────┐
                                    simulation           awaitingHuman       (autopilote : Phase 8)
                                            │                  │
                                            │            APPROVE / REJECT
                                            │                  ▼
                                            │              staging ──▶ confirming ──▶ published
                                            │                                  └────▶ abandoned
                                            ▼                  ▼
                                                     measuring ──▶ learning ──▶ idle
```

Points de conception non évidents :

1. `awaitingHuman` n'a **aucune transition temporelle**. Le mode Copilote ne peut pas
   dériver vers la publication automatique par oubli de validation : l'inaction ne vaut
   jamais consentement.
2. Le `always` de `queued` a `awaitingHuman` en **dernier fallback**. Si un garde est mal
   évalué, on retombe sur la validation humaine, jamais sur l'action.
3. Un veto du CRITIC est un `onDone`, pas un `onError`. Le rejet est un résultat.
4. `staging` écrit dans le composeur et s'arrête. `confirming` découvre si l'humain a
   publié — sans quoi ANALYST mesurerait des actions fantômes.

## Permissions

| Permission | Pourquoi | Sans elle |
|---|---|---|
| `sidePanel` | UI principale | Retour au popup exigu |
| `storage` | config, Voice Profile, clés chiffrées | Rien ne persiste hors IndexedDB |
| `unlimitedStorage` | vector store + archive de backtest dépassent le quota par défaut | Éviction silencieuse d'IndexedDB |
| `alarms` | seul réveil fiable du service worker : cadence, J+1/J+7, reset du budget, purge | `setTimeout` meurt avec le worker |
| `offscreen` | embeddings WASM et agrégations hors de la fenêtre du worker | Calculs tués en cours |
| `scripting` | réinjecter le content script dans les onglets X déjà ouverts après update | Recharger X à la main après chaque mise à jour |
| `tabs` | lire `url`/`status` de l'onglet ouvert par ANALYST pour savoir que la page a chargé | Mesures perdues silencieusement |
| `notifications` *(optionnelle)* | alerte de rupture de sélecteur, file de validation en attente | Échec silencieux — ce que SPEC §8 interdit |
| `downloads` *(optionnelle)* | export du journal d'audit et de la sauvegarde chiffrée | Copier-coller manuel |
| `idle` *(optionnelle)* | suspendre le swarm quand l'utilisateur est absent | Cadence moins crédible |
| `host_permissions` x.com / twitter.com | lecture DOM, overlay, actuator | Produit inopérant |
| `optional_host_permissions` providers | demandés **au runtime**, un seul domaine accordé selon le provider choisi | Demander 7 domaines à l'install pour n'en utiliser qu'un — mauvais signal en review CWS |
| CSP `wasm-unsafe-eval` | `hnswlib-wasm` et le runtime ONNX | Recherche vectorielle en JS pur, 10 à 50× plus lente |

**Explicitement non demandées** — c'est un engagement, pas un oubli : `<all_urls>`,
`webRequest`, `declarativeNetRequest`, `cookies`, `history`, `bookmarks`, `topSites`,
`identity`, `debugger`, `nativeMessaging`, `management`, `clipboardRead`.

## Le risque de maintenance numéro un

X change son DOM sans préavis. Traité comme un risque de premier ordre, pas comme un
aléa :

- **Un seul fichier** contient des sélecteurs : `content/dom/x-selectors.ts`.
- Chaque sélecteur a des **fallbacks en cascade**, `data-testid` d'abord.
- `selector-health.ts` compte les échecs de match et **alerte l'utilisateur** au lieu
  d'échouer en silence.
- `snapshot-on-break.ts` capture le fragment DOM **anonymisé** en fixture locale : une
  rupture devient une réparation de 20 minutes au lieu d'une soirée de reproduction à
  l'aveugle.
- `scripts/check-selectors.ts` rejoue les fixtures en CI.
