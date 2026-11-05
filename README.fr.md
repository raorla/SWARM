# SWARM

Copilote autonome multi-agents pour **un** compte X (Twitter). Extension Chrome
Manifest V3, **local-first** : pas de backend, aucune donnée sortante hors du provider
LLM que vous choisissez.

> **État : les neuf phases sont écrites et testées ; trois DoD attendent le monde réel.**
> Le scout observe ce que vous voyez, le QUALIFIER trie par lots pour quelques centimes,
> l'onglet Flux présente les opportunités une par une, le CRITIC peut refuser, la mesure à
> J+1/J+7 alimente les patterns et les patterns retournent dans les prompts. Ce qui manque
> demande une clé API, un compte réel et du temps : la journée instrumentée sans dépassement
> de plafond, sept jours de mesures, et le blind test à trois juges. La liste exacte, triée
> par ce qui la bloque, est dans [TODO.md](./TODO.md#ce-qui-reste-trié-par-ce-qui-bloque).
>
> **L'autopilote n'existe pas dans le binaire.** Ce n'est pas un réglage désactivé : le code
> de soumission automatique n'est pas écrit, et un test l'atteste.

---

## En une phrase

Là où les outils existants font de la **génération one-shot** (un post entre, une
réponse IA sort), SWARM est un **système** : une escouade d'agents qui observent,
qualifient, rédigent, critiquent, mettent en scène, **mesurent le résultat réel et se
corrigent**. La boucle de feedback est le produit.

## Le swarm

```
                    ┌─────────────────────────────────────────┐
                    │      ORCHESTRATOR — XState, persisté    │
                    └─────────────────────────────────────────┘
                                       │
   ┌───────────┬───────────┬───────────┼───────────┬───────────┬───────────┐
   ▼           ▼           ▼           ▼           ▼           ▼           ▼
┌───────┐  ┌────────┐  ┌────────┐  ┌───────┐  ┌───────┐  ┌────────┐  ┌────────┐
│ SCOUT │→ │QUALIF. │→ │STRATEG.│→ │WRITER │→ │CRITIC │→ │PUBLISH.│→ │ANALYST │
│  DOM  │  │ triage │  │ angle  │  │3 var. │  │ VETO  │  │ staging│  │J+1/J+7 │
│passif │  │  EV    │  │mémoire │  │ voix  │  │       │  │        │  │        │
└───────┘  └────────┘  └────────┘  └───────┘  └───────┘  └────────┘  └────────┘
                            ▲                                             │
                            └────────── patterns gagnants ────────────────┘
                                       (la boucle fermée)
```

Le **CRITIC** a un droit de veto : si aucune variante ne passe le seuil, l'opportunité est
rejetée. Le taux de rejet est une métrique affichée, pas un bug. Son seuil est appliqué en
code et non seulement demandé au modèle — un juge LLM dit régulièrement « ça passe » en
donnant une note qui ne passe pas.

Le **Voice Profile** sépare la forme du registre. Vos statistiques d'écriture — longueur,
rythme, ponctuation, tics — sont extraites de tous vos posts. Vos *exemples* et vos règles,
en revanche, ne viennent que des posts qui passent les garde-fous du produit. Sans cette
séparation, le profil deviendrait le chemin par lequel le contenu interdit rentre, sous
l'étiquette « c'est votre style ».

Le **PUBLISHER** ne clique jamais « Publier ». Il pré-remplit le composeur de X ; vous
cliquez. Ce n'est pas un réglage : le code de soumission n'existe pas.

L'**ANALYST** mesure à J+1 et J+7, et il le fait **passivement** : les métriques sont relevées
quand vous passez sur votre profil ou votre fil. SWARM n'ouvre aucun onglet de lui-même — ce
serait l'automatisation qu'il refuse, et le signal le plus visible côté X. Le prix de ce choix
est une couverture de mesure partielle, que l'onglet Analytics affiche **avant** les patterns :
un classement calculé sur une couverture inconnue n'est pas un classement.

Deux écarts entre ce schéma et le code, écrits ici plutôt que découverts : **STRATEGIST** n'est
pas un module séparé — le choix d'angle est fait par le WRITER (trois angles) et arbitré par le
CRITIC ; et l'**orchestrateur** XState est écrit et testé mais pas branché au service worker,
parce que le Copilote n'a pas de boucle autonome à faire avancer. Les deux sont suivis dans
TODO et argumentés dans FEEDBACK (D-15).

## Ce que SWARM ne fait pas

- Gérer plusieurs comptes de façon coordonnée
- Envoyer un DM automatiquement
- Publier sans intervention humaine
- Répondre sur santé, deuil, politique, crise
- Donner un conseil financier, prédire un prix, promouvoir un ticker non sollicité
- Scraper X hors de votre session de navigation
- Envoyer quoi que ce soit à un serveur autre que votre provider LLM
- Collecter de la télémétrie sans votre accord explicite

Cette liste est un engagement produit, pas une note de bas de page. Voir
[docs/risks-and-limits.md](./docs/risks-and-limits.md).

## Ce dont vous avez besoin pour l'utiliser

- Une **clé API** chez un provider (OpenRouter, Anthropic, ou un endpoint local Ollama /
  LM Studio — dans ce dernier cas, rien ne quitte votre machine). Prenez une clé **dédiée**,
  avec un plafond de dépense côté provider : le chiffrement local protège du vol du profil
  Chrome, pas d'un attaquant qui contrôle déjà la machine.
- Une **passphrase** pour le coffre. Elle n'est stockée nulle part et n'est pas récupérable.
  Le déverrouillage vaut pour la session du navigateur, huit heures au plus.
- Environ **1 €/jour** en usage soutenu. Le plafond quotidien est dans l'extension et il
  coupe ; le coût réel de chaque appel est lu dans la réponse du provider, jamais estimé.

## Démarrage

```bash
npm install
npm run dev              # build en watch + HMR
npm run check            # lint + typecheck + tests + vérification des sélecteurs
npm run build            # dist/ chargeable en mode développeur
npm run e2e              # E2E local : extension dans un vrai Chromium, sans compte X
npm run check:selectors  # rejoue les fixtures DOM contre x-selectors.ts
```

`npm run test` est **hermétique et gratuit** : aucun appel réseau, aucune clé. Les mesures qui
dépensent vraiment sont séparées, nommées, et derrière un `.env` :

```bash
cp .env.example .env     # puis renseigne SWARM_OPENROUTER_KEY
npm run measure:cache      # ~0,002 € — le cache de prompt passe-t-il ? (R-03)
npm run measure:qualifier  # ~0,025 € — DoD Phase 3 : 200 posts sous 0,05 €
npm run calibrate:critic   # ~0,09 €  — seuil de veto, sur jeu étiqueté
npm run live               # les trois d'affilée
```

Chacune imprime un verdict et échoue si la propriété mesurée ne tient plus. À relancer après
tout changement de prompt, de modèle ou de format de sortie : c'est là qu'une régression de coût
est invisible en test unitaire. Sans clé, elles se sautent en disant ce qui manque.

**Le `.env` ne va jamais dans le bundle** — et ce n'est pas qu'une intention : aucune variable
n'est préfixée `VITE_` (Vite n'expose que celles-là), et trois tests vérifient qu'aucun motif de
clé n'apparaît dans `dist/`, que `src/` ne lit que `MODE` de l'environnement, et que `.env` est
ignoré par git.

### Installer pour tester

```bash
npm run build     # produit dist/
```

Puis `chrome://extensions` → mode développeur → « Charger l'extension non empaquetée » →
dossier `dist/`.

**Le parcours complet — consentement, clé, pack de niche, test d'appel, collecte du corpus — est
dans [INSTALL.md](./INSTALL.md)**, avec la section de dépannage et les valeurs par défaut. L'ordre
des étapes compte : chacune débloque la suivante.

Après un `npm run e2e`, `dist/` contient un build de test qui s'injecte aussi dans `localhost` :
relance `npm run build` avant de charger ou de recharger l'extension. `npm run zip` refuse ce
bundle-là ; le chargement manuel, non.

En développement, le governor démarre en **mode simulation** (aucune écriture DOM
possible). Il faut un opt-in explicite pour agir sur un vrai compte — voir
[FEEDBACK.md](./FEEDBACK.md) § MH-15.

### E2E sur un vrai compte

`npm run e2e` tourne sur des fixtures servies en local : déterministe, sans compte X, sans
réseau. Le parcours complet sur x.com est dans `tests/e2e/live/` et ne s'exécute qu'avec un
garde explicite :

```bash
SWARM_E2E_LIVE=1 SWARM_E2E_PROFILE=/chemin/profil npx playwright test
```

Sans ce garde, chaque commit produirait de l'automatisation non sollicitée sur X — ce que le
produit s'interdit. Le garde fait partie de la posture, ce n'est pas une commodité.

### Quand X casse le parsing

C'est le premier risque de maintenance du produit, et il est outillé pour ça :

1. L'utilisateur reçoit une alerte (badge, ou notification si accordée) nommant le sélecteur.
2. Un fragment DOM **anonymisé** est conservé dans `chrome.storage.local`.
3. Ce fragment devient une fixture, et le nouveau sélecteur va **en tête** de la cascade —
   sans retirer l'ancien : X déploie progressivement, les deux coexistent des jours durant.

## Documentation

| Fichier | Contenu |
|---|---|
| [INSTALL.md](./INSTALL.md) | Installer dans Chrome et tester, étape par étape |
| [SPEC.md](./SPEC.md) | Spécification produit et technique — source de vérité |
| [TODO.md](./TODO.md) | Découpage en 9 phases, avec DoD |
| [FEEDBACK.md](./FEEDBACK.md) | Décisions, must-have ajoutés, réserves assumées, questions ouvertes |
| [docs/architecture.md](./docs/architecture.md) | Contextes MV3, flux de données, contraintes |
| [docs/risks-and-limits.md](./docs/risks-and-limits.md) | Risques d'usage, règles de X, limites connues |
| [docs/adr/](./docs/adr/) | Décisions d'architecture, une par fichier |
| [PRIVACY.md](./PRIVACY.md) | Ce qui sort du navigateur, et rien d'autre |
| [docs/chrome-web-store.md](./docs/chrome-web-store.md) | Fiche du magasin, divulgations, revue de conformité |
| [docs/blind-test-protocol.md](./docs/blind-test-protocol.md) | Protocole préenregistré du test d'indiscernabilité |
| [CHANGELOG.md](./CHANGELOG.md) | Par phase |

## Contribuer

Trois règles qui ne se négocient pas :

1. **Zod à chaque frontière.** LLM, DOM, storage, messages inter-contextes. Un LLM qui
   renvoie du JSON malformé ne doit jamais casser l'app.
2. **Aucune action sur X en dehors de `governor.requestPermit()`.** Le type `StagePermit`
   est opaque et seul le governor peut le construire — si vous devez le contourner,
   c'est le design qui est faux.
3. **Pas de `Date.now()` ni de `Math.random()` dans `src/`.** Utilisez
   `shared/time.ts` et `shared/rng.ts` : sans horloge injectable, le governor n'est pas
   testable, et sans RNG seedable le backtest n'est pas reproductible. Un lint
   l'applique.
4. **Aucune sortie réseau hors de `src/llm/`.** Un test lit les sources et refuse `fetch`,
   `WebSocket`, `sendBeacon`, tout SDK de télémétrie et tout hôte inattendu. « Zéro donnée
   sortante » est écrit dans `PRIVACY.md` et attesté au Chrome Web Store : ça ne se tient pas
   par relecture.
5. **`npm run build` avant `npm run zip`.** Le build E2E ajoute `localhost` aux cibles du
   content script ; l'empaquetage le refuse, mais la bonne habitude est de ne pas l'y mettre.
