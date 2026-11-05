# Fiche Chrome Web Store et revue de conformité

*Phase 8. Ce document contient (1) le texte de la fiche, (2) les réponses aux formulaires de
divulgation, (3) la revue de conformité article par article, avec ce qui reste à trancher.*

Il n'est pas un brouillon marketing : chaque affirmation de la fiche doit être vraie du code
livré, parce qu'une fiche qui promet plus que le binaire est un motif de retrait, et parce
qu'une revue humaine du magasin lit la fiche avant le code.

---

## 1. Fiche

**Nom** : SWARM — copilote X multi-agents

**Résumé court** (132 caractères max) :

> Un essaim d'agents repère les conversations qui valent une réponse et rédige dans votre
> voix. Vous validez. Rien ne sort de votre navigateur.

**Catégorie** : Productivité · **Langues** : français, anglais

### Description longue

> SWARM lit votre timeline X, note chaque conversation selon une valeur attendue explicite
> et réglable, rédige trois variantes de réponse dans votre voix, les fait relire par un
> agent critique qui a un droit de veto, puis **vous** propose de publier. Vous restez le
> doigt sur le bouton.
>
> **Ce que SWARM fait**
>
> - Repère les opportunités : pertinence pour votre niche, portée, fraîcheur, saturation de
>   la conversation, affinité avec l'auteur. Chaque score est décomposable d'un clic — vous
>   voyez pourquoi un post est remonté, et vous pouvez changer les poids.
> - Rédige dans votre voix, apprise de vos propres posts publics : longueur, ponctuation,
>   registre, emojis ou pas. Pas de « Great point! ».
> - Fait relire par un agent critique qui refuse ce qui sonne faux, ce qui répète une
>   réponse déjà faite, ce qui met votre réputation en jeu. Son veto est ferme.
> - Mesure ce que vos réponses rapportent à J+1 et J+7, et réinjecte ce qui marche dans les
>   prompts. La boucle est fermée : le produit apprend de vos résultats, pas d'une moyenne
>   générale.
> - Se souvient de qui vous êtes pour chacun : un CRM social local qui sait que vous avez
>   déjà parlé trois fois à ce compte, et qu'il ne vous a jamais répondu.
> - Rejoue vos réglages sur votre historique archivé avant de les appliquer.
>
> **Ce que SWARM ne fait pas, et ne fera pas**
>
> - Aucun envoi automatique de message privé. Les DM sont des brouillons ouverts dans X,
>   que vous envoyez à la main.
> - Aucune gestion de plusieurs comptes, aucun mode « ferme de comptes ».
> - Aucune réponse aux sujets sensibles — santé, deuil, politique, crise, conseil
>   financier. Ce filtre n'est pas désactivable.
> - Aucune télémétrie. Il n'y a pas de serveur SWARM : le code ne contient aucun point de
>   collecte.
> - Aucun achat d'engagement, aucun spam de mots-clés, aucun contournement de limite.
>
> **Plafonds, par défaut et modifiables vers le bas** : 25 réponses par jour, 3 posts,
> 0 follow, 0 DM. Cadence humaine, fenêtres actives, pauses de nuit, jours de repos
> aléatoires. Un interrupteur d'arrêt d'urgence, en un clic ou au clavier, vide la file.
>
> **Vous avez besoin de votre propre clé API** chez un fournisseur de modèle (OpenRouter,
> Anthropic, OpenAI, Google, xAI) — ou d'un serveur local (Ollama, LM Studio), auquel cas
> rien ne quitte votre machine. Comptez environ 1 €/jour d'usage soutenu ; le plafond de
> dépense est dans l'extension, en dur, et il coupe.
>
> **Limite à connaître avant d'installer** : l'automatisation de X est encadrée par les
> règles de X, et le mode automatique de SWARM (désactivé par défaut, et volontairement non
> implémenté dans cette version) peut faire suspendre un compte. Le mode par défaut vous
> demande de valider chaque action, ce qui est aussi le mode pour lequel le produit est
> conçu. Voir `docs/risks-and-limits.md`.

### Captures d'écran à produire

| # | Écran | Ce qu'elle doit prouver |
|---|---|---|
| 1 | Onglet Flux, file triée | Le score EV décomposé, visible |
| 2 | Trois variantes + verdict du CRITIC | La relecture existe et peut refuser |
| 3 | Onglet Swarm, cockpit | Kill switch, plafonds du jour, budget restant |
| 4 | Onglet Analytics | Une boucle d'apprentissage, pas un dashboard décoratif |
| 5 | Onglet Config, Voice Profile | La voix vient de vos posts, avec sa confiance affichée |

> **À faire avant soumission** : les captures doivent être prises sur un compte réel, donc
> après la première journée d'usage instrumentée (Phase 4). Aucune capture composée.

---

## 2. Divulgations du formulaire

**Objectif unique** — « Assister l'utilisateur d'un compte X dans la sélection et la
rédaction de ses réponses, sous validation humaine. » Toutes les permissions servent cet
objectif ; la justification par permission est dans
[architecture.md](./architecture.md#permissions).

**Usage des données** — le tableau de [PRIVACY.md](../PRIVACY.md#divulgations-chrome-web-store)
est la réponse au formulaire, mot pour mot. Trois catégories cochées, toutes locales.

**Les trois attestations d'utilisation limitée** sont cochables sans réserve : usage limité à
la fonction annoncée ; aucune vente ni transfert, faute de destinataire ; aucun usage lié à
la solvabilité.

**Code distant** : *non*. Aucun `eval`, aucun script chargé à distance. `wasm-unsafe-eval`
est déclaré dans la CSP pour un module WebAssembly **embarqué dans le paquet** — à déclarer
tel quel dans le formulaire, parce que la revue le voit et posera la question.

---

## 3. Revue de conformité

### Ce qui est traité

| Point de la politique | Statut | Comment c'est tenu |
|---|---|---|
| Objectif unique | ✅ | Une seule fonction, un seul domaine cible |
| Permissions minimales | ✅ | `<all_urls>`, `webRequest`, `cookies`, `history`, `identity`, `debugger`, `management` non demandées ; hôtes de fournisseurs en `optional_host_permissions`, demandés à l'usage |
| Divulgation de l'usage des données | ✅ | `PRIVACY.md`, publié et lié depuis la fiche |
| Pas de code distant | ✅ | Vérifié au build ; `wasm-unsafe-eval` déclaré et justifié |
| Pas de collecte cachée | ✅ | Aucun endpoint de collecte dans le code — un test échoue si un `fetch` apparaît hors de `src/llm/` |
| Fiche non trompeuse | ✅ | La fiche nomme les limites, y compris le risque de suspension |
| Pas de build de test empaqueté | ✅ | `scripts/build-zip.ts` refuse un bundle dont le content script cible autre chose que `x.com`/`twitter.com` |

### Ce qui demande un arbitrage humain avant soumission

**1. L'automatisation d'un service tiers.** Le magasin n'interdit pas d'automatiser X ; les
règles **de X**, elles, encadrent l'automatisation, et un examinateur peut lire « copilote
autonome » comme un outil de contournement. Deux conséquences pratiques, à assumer :

- la fiche dit le risque au lieu de le taire — c'est le paragraphe « Limite à connaître » ;
- le module d'autopilote **n'existe pas dans le binaire**. Ce n'est pas un réglage
  désactivé : le code de soumission automatique n'est pas écrit, et
  `AUTOPILOT_IMPLEMENTED === false` est asserté par un test. Une revue qui cherche la
  fonction ne la trouvera pas, parce qu'elle n'est pas là.

C'est la position de R-01, et elle est cohérente : le produit est fait pour être excellent
en Copilote.

**2. Le nom « SWARM » et le vocabulaire d'essaim.** « Swarm » évoque, dans le contexte des
réseaux sociaux, la coordination de comptes — exactement ce que le produit refuse de faire.
Le risque est un malentendu de revue, pas une non-conformité. À trancher par le
propriétaire : garder le nom et l'expliquer dès la première phrase de la fiche (position
actuelle), ou le changer avant soumission. La décision est commerciale.

**3. Marques déposées.** La fiche mentionne X, Twitter, OpenRouter, Anthropic, OpenAI,
Google, xAI, Ollama, LM Studio. Usage nominatif, descriptif, sans logo ni typographie
empruntée — admis, mais aucune icône ni élément graphique de X ne doit apparaître dans les
captures autrement que comme fond de la page réelle.

**4. Compte de démonstration pour la revue.** Le magasin peut demander des identifiants de
test. Il n'y en a pas : l'extension a besoin d'un compte X connecté et d'une clé API
personnelle. Réponse à préparer — proposer une vidéo de démonstration plutôt que des
identifiants, et ne jamais transmettre la clé.

### Avant de cliquer sur « soumettre »

- [ ] `npm run build` puis `npm run zip` (dans cet ordre — la garde anti-E2E refuse
      l'inverse)
- [ ] Icônes 16/32/48/128 définitives, pas les placeholders
- [ ] Cinq captures prises sur un compte réel
- [ ] `PRIVACY.md` publié à une URL stable, renseignée dans la fiche
- [ ] Décision prise sur le point 2 (le nom)
- [ ] Vidéo de démonstration enregistrée (point 4)
- [ ] Version du manifest incrémentée et taguée
