# Installer SWARM dans Chrome

Guide d'installation manuelle, pour tester l'extension sur ton compte. Compte quinze minutes,
dont dix d'attente pendant la collecte de ton corpus.

> **À lire avant de commencer.** SWARM automatise de l'engagement sur X. X encadre
> l'automatisation, et un compte peut être limité ou suspendu — **même avec validation humaine
> sur chaque action**. Les plafonds bas, la cadence humaine et les pauses réduisent le risque ;
> ils ne le suppriment pas. Voir [docs/risks-and-limits.md](./docs/risks-and-limits.md).

---

## 1. Prérequis

| | Version | Pourquoi |
|---|---|---|
| Node | ≥ 20 | `--experimental-strip-types` pour les scripts |
| Chrome | ≥ 116 | Side Panel API, `chrome.storage.session` |
| Clé LLM | — | OpenRouter, Anthropic, ou un endpoint local Ollama / LM Studio |

**Prends une clé dédiée, avec une limite de dépense côté fournisseur.** Le chiffrement local
protège du vol de ton profil Chrome, pas d'un attaquant qui contrôle déjà ta machine — c'est la
seule atténuation réelle, et elle est chez le fournisseur.

Sur [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) : crée une clé, puis règle
une limite de crédit dessus. Compte ~1 €/jour en usage soutenu ; le plafond quotidien est aussi
dans l'extension, et il coupe.

## 2. Construire

```bash
npm install
npm run build
```

`dist/` est le dossier à charger. Vérifie au passage que la suite est verte :

```bash
npm run check    # lint + typecheck + 1 013 tests + sélecteurs
```

> ⚠️ **Ne charge jamais `dist/` juste après `npm run e2e`.** Le build E2E ajoute
> `http://localhost:4319/*` aux cibles du content script, pour servir les fixtures. Relance
> `npm run build` avant de charger ou de recharger l'extension. (`npm run zip` refuse ce
> bundle-là ; le chargement manuel, non.)

## 3. Charger dans Chrome

1. `chrome://extensions`
2. Active **Mode développeur** (en haut à droite)
3. **Charger l'extension non empaquetée** → choisis le dossier `dist/`
4. Épingle l'icône SWARM dans la barre d'outils
5. Clique l'icône : le side panel s'ouvre

Raccourcis, réglables dans `chrome://extensions/shortcuts` :

| Raccourci | Effet |
|---|---|
| `Alt+Shift+S` | Ouvrir le side panel |
| `Alt+Shift+K` | **Kill switch** — arrête le swarm et vide la file d'actions en attente |

## 4. Première ouverture, dans l'ordre

L'ordre compte : chaque étape débloque la suivante.

### 4.1 Consentement

Trois points à lire, une case à cocher, puis **Activer SWARM**. « Pas maintenant » est un vrai
choix : l'extension reste inerte, elle ne lit rien et ne dépense rien.

Tant que le consentement n'est pas donné, le triage et la rédaction refusent tout — c'est voulu.

### 4.2 Clé et coffre — onglet **Config** → *Provider et clé*

1. Choisis le provider (**OpenRouter** par défaut, ou *Endpoint local* pour Ollama / LM Studio)
2. Colle ta clé
3. Choisis une **passphrase de coffre** — 8 caractères minimum. Elle n'est stockée nulle part et
   **n'est pas récupérable**. Note-la.
4. **Créer le coffre**

Chrome demandera l'autorisation d'accéder à `openrouter.ai`. Accepte : sans elle, aucun appel
n'est possible. Elle est demandée depuis ton clic, seul moment où l'API l'accepte.

Le déverrouillage vaut pour la session du navigateur, **8 heures au maximum**. Après une
fermeture de Chrome, il faut redonner la passphrase — la clé, elle, reste chiffrée sur le disque.

### 4.3 Pack de niche — onglet **Config** → *Pack de niche*

Par défaut le pack est `generic`, volontairement restrictif. **Choisis ta niche** : sans ça, le
tri remonte des posts sans rapport et rien ne le signale.

Trois packs sont livrés : `generic`, `memecoin`, `saas-b2b`. Ils sont modifiables dans
`src/niches/packs/` (l'éditeur dans l'UI n'existe pas encore).

### 4.4 Test de connexion — onglet **Swarm** → *Test de connexion LLM*

**Lancer.** Tu dois voir une réponse, un coût en euros, et le compteur de budget bouger. C'est le
test qui valide en une fois : la clé, la permission d'hôte, le déverrouillage, le routage de
modèle et la comptabilité de coût.

Si ça échoue ici, ne va pas plus loin — les étapes suivantes échoueront de la même façon avec un
message moins clair.

### 4.5 Voice Profile — onglet **Config** → *Voice Profile*

C'est ce qui fait écrire dans ta voix plutôt qu'en registre d'assistant.

1. Ouvre **ton profil X** dans l'onglet actif (`x.com/<ton_handle>`)
2. Reviens au panel → **Collecter mes posts**

La collecte parcourt la page que tu vois. Elle est bornée — 200 posts, 60 défilements, 4 minutes
— et **s'arrête si tu quittes la page**. Elle affiche sa progression : une collecte silencieuse
serait indiscernable d'un scraper.

Le panneau affiche ensuite la taille du corpus, la confiance du profil, et le
`guardExcludedRatio` : la part de tes posts écartée par les garde-fous. Sur un compte de projet,
ce taux peut être élevé — c'est un diagnostic, pas une panne.

### 4.6 Utiliser

**Sur x.com** — un bouton SWARM apparaît sous chaque post. Il rédige une réponse pour *ce* post,
immédiatement.

**Onglet Flux** — la file d'opportunités, remplie à mesure que le scout observe ce que tu
consultes. SWARM ne va rien chercher tout seul : il lit ce que tu vois. Tout se pilote au
clavier :

| Touche | Effet |
|---|---|
| `A` | Rédiger une réponse |
| `E` | Rédiger avec une consigne |
| `R` | Rejeter |
| `Espace` / `J` | Suivant |
| `K` | Précédent |
| `O` | Ouvrir le post sur X |
| `D` | Décomposé du score EV |
| `?` | Aide |

Les brouillons sont **mis en scène** dans le composeur de X. C'est toi qui cliques Publier — le
code de publication automatique n'existe pas.

## 5. Réglages par défaut

Ils sont abaissables, jamais relevables au-delà du maximum (onglet **Config** → *Plafonds et
cadence*).

| Réglage | Défaut | Maximum |
|---|---|---|
| Réponses / jour | 12 | 40 |
| Posts / jour | 3 | 5 |
| Follows, DM / jour | **0** | 0 — ces actions n'existent pas |
| Cadence entre actions | 4 à 18 min | plancher de 2 min |
| Fenêtre active | 09:00 → 23:00 | — |
| Jour de repos | ~1 par semaine, aléatoire | — |
| Budget / jour | 1 € | 10 € |
| Rétention du texte brut | 30 jours | 365 |
| Seuil de veto du CRITIC | 0,45 (mesuré) | — |

Mode par défaut : **Copilote** — validation humaine sur chaque action. L'autopilote a son propre
écran de consentement, et son code de soumission **n'existe pas** dans cette version.

## 6. Sauvegarde — à faire dès que tu as un corpus

« Local-first » veut aussi dire « aucune sauvegarde ailleurs ». Un profil Chrome perdu efface
tout : corpus de voix, mesures, patterns, journal d'audit. Il n'y a personne à qui le redemander.

**Config → Sauvegarde chiffrée → Exporter maintenant.** La passphrase de sauvegarde est
indépendante de celle du coffre, et tout aussi irrécupérable.

## 7. Quand ça ne marche pas

### Le panel reste sur « Lecture de la configuration… »

Le service worker ne répond pas. `chrome://extensions` → **Inspecter les vues : service worker**
→ onglet Console. Vérifie aussi le fil d'Ariane de démarrage, dans la console du worker :

```js
await chrome.storage.local.get('swarm:boot:step')
// attendu : { 'swarm:boot:step': 'listener-registered' }
```

Une autre valeur signifie que le module s'est arrêté avant d'enregistrer son écouteur.

### La file Flux est vide

Quatre causes différentes, et l'écran vide les distingue — lis-le. En résumé : rien de trié
encore (navigue sur x.com), budget épuisé, seuils du pack trop stricts, ou rien d'intéressant
dans ce que tu as consulté.

### « coffre verrouillé »

Normal après une fermeture de Chrome : Config → *Provider et clé* → passphrase → **Déverrouiller**.

### Une alerte de sélecteur cassé

X a changé son DOM. C'est le premier risque de maintenance du produit, et il est outillé : un
fragment anonymisé est conservé dans `chrome.storage.local`, à transformer en fixture. Voir la
section « Quand X casse le parsing » du [README](./README.md).

### Après un rebuild, l'extension a l'air inchangée

`chrome://extensions` → bouton **Recharger** sur la carte SWARM. Un rechargement de page ne
suffit pas pour le service worker.

## 8. Mettre à jour

```bash
npm run build
```

Puis **Recharger** dans `chrome://extensions`. Les données survivent : elles sont dans IndexedDB,
pas dans le bundle. Une migration de schéma s'applique automatiquement au premier accès.

## 9. Désinstaller

`chrome://extensions` → **Supprimer**. Cela détruit l'intégralité des données locales : corpus,
mesures, journal d'audit, clé chiffrée. Il n'y a rien à demander à personne — et rien à
récupérer, sauf ton export.

---

## Ce qui n'est pas encore parcouru dans un vrai navigateur

Honnêteté sur l'état : l'extension se charge, le service worker répond, le side panel s'ouvre, et
le parcours consentement → configuration est vérifié par un test de bout en bout dans un vrai
Chromium. **Ce qui n'a pas encore été fait sur un compte réel** :

- la saisie d'une clé et le premier appel LLM depuis le panel ;
- la collecte du corpus sur un profil X réel ;
- la mise en scène d'un brouillon dans le composeur de X.

C'est exactement ce que cette installation sert à tester. Ce qui casse là est attendu — dis-le,
c'est la seule façon de le corriger. Le suivi est dans [TODO.md](./TODO.md).
