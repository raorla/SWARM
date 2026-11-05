# Politique de confidentialité — SWARM

*Version 1.0 · finalisée en Phase 8 pour la fiche Chrome Web Store. Ce texte est la
politique publiée ; toute modification est tracée dans `CHANGELOG.md`.*

**Dernière mise à jour : 25 août 2026.**

## Principe

SWARM est **local-first**. Il n'y a pas de serveur SWARM. Il n'y a pas de compte SWARM.
Vos données restent dans votre navigateur.

## Ce qui sort de votre navigateur

**Une seule destination : le fournisseur de modèle de langage que vous configurez
vous-même** (OpenRouter, Anthropic, OpenAI, Google, xAI, ou votre propre serveur local).

Ce qui lui est envoyé :

- le texte des posts publics de X que le swarm qualifie ou auxquels il rédige une réponse ;
- des extraits de votre propre historique de posts publics, pour construire votre Voice Profile ;
- les brouillons rédigés, pour relecture par l'agent CRITIC ;
- vos réglages de niche (mots-clés, sujets bloqués) en tant que contexte de prompt.

Si vous configurez un endpoint local (Ollama, LM Studio), **rien ne quitte votre
machine**.

## Ce qui ne sort jamais

- Votre clé API — stockée chiffrée localement, jamais transmise ailleurs qu'au
  fournisseur concerné, jamais placée dans une URL, jamais écrite dans un log.
- Votre passphrase de chiffrement — elle ne quitte pas la mémoire du processus.
- Vos messages privés (DM). SWARM ne lit pas et n'envoie pas de DM.
- Votre historique de navigation en dehors de `x.com`.
- Vos statistiques d'usage. **Il n'y a aucune télémétrie**, activée ou désactivée : le
  code ne contient aucun endpoint de collecte.

## Embeddings

La recherche de similarité (anti-répétition, mémoire relationnelle) tourne **entièrement
en local**. Aucun appel à une API d'embedding : le vector store serait sinon le plus gros
canal de fuite du produit — chaque post lu y passerait.

Précision technique, parce que « embeddings locaux » est souvent employé vaguement :
l'implémentation livrée est une projection de n-grammes de caractères sur un espace de
dimension fixe (*hashing trick*), calculée en JavaScript, sans modèle téléchargé et sans
dépendance. Elle détecte la reformulation, pas le synonyme. Un modèle de phrases local plus
capable est prévu ; le jour où il arrivera, il sera téléchargé une fois depuis une URL
affichée avant le téléchargement, et il tournera lui aussi entièrement sur votre machine.

## Stockage local

Tout est dans IndexedDB et `chrome.storage.local`, sur votre machine :
opportunités, brouillons, actions, mesures, mémoire relationnelle, Voice Profile,
patterns, journal d'audit, embeddings.

**Rétention** : le texte brut des posts non retenus est purgé après 30 jours
(configurable). Les opportunités rejetées conservent le motif de rejet, pas le contenu.
L'archive de backtest est un opt-in nommé, avec sa propre durée de vie.

**Sauvegarde** : « local-first » veut aussi dire « aucune sauvegarde automatique ».
L'onglet Config permet un export chiffré complet, et sa réimportation. Utilisez-le : un
profil Chrome corrompu efface tout.

**Suppression** : désinstaller l'extension détruit l'intégralité des données. Il n'y a
rien à demander à personne.

## Un seul compte

SWARM pilote **le compte X connecté dans votre navigateur, et lui seul**. Il n'existe aucune
fonction de gestion multi-comptes, aucun mode « ferme de comptes », aucune coordination entre
installations. Ce n'est pas une limite de la version actuelle : c'est une contrainte de
conception, et l'ajouter reviendrait à construire un autre produit.

## Divulgations Chrome Web Store

Renseignements exigés par la fiche du magasin, repris ici pour qu'ils soient vérifiables :

| Catégorie de données | Collectée | Détail |
|---|---|---|
| Informations personnelles identifiables | Non | — |
| Informations de santé | Non | — |
| Informations financières | Non | — |
| Informations d'authentification | **Oui, localement** | Votre clé API de fournisseur LLM, chiffrée au repos, jamais transmise à SWARM |
| Communications personnelles | Non | Les DM ne sont ni lus ni écrits |
| Localisation | Non | — |
| Historique de navigation | Non | — |
| Activité utilisateur | **Oui, localement** | Vos actions dans l'extension, pour le journal d'audit et les mesures de performance |
| Contenu de sites web | **Oui, localement** | Posts publics de `x.com`, pour qualification et rédaction |

Les trois lignes « oui » désignent des données qui **restent dans votre navigateur**. La seule
transmission sortante est l'appel au fournisseur LLM que vous configurez, décrit plus haut.

Les trois engagements d'utilisation limitée du magasin sont tenus, et le code le rend
vérifiable : l'usage des données se limite à la fonction annoncée ; il n'y a **aucune vente
ni transfert** à un tiers, faute de destinataire — il n'existe pas de serveur SWARM ; et
aucune donnée ne sert à établir la solvabilité ni à du prêt.

## Permissions demandées

Chaque permission est justifiée une par une dans
[docs/architecture.md](./docs/architecture.md#permissions).

Non demandées, et ce n'est pas un oubli : `<all_urls>`, `webRequest`,
`declarativeNetRequest`, `cookies`, `history`, `bookmarks`, `topSites`, `identity`,
`debugger`, `nativeMessaging`, `management`, `clipboardRead`.

## Limite honnête sur le chiffrement des clés

Votre clé API est chiffrée au repos (AES-GCM, clé dérivée par PBKDF2 de votre
passphrase). Cela protège contre le vol du fichier de profil.

Cela **ne protège pas** contre un attaquant qui contrôle déjà votre session de
navigateur : une clé API utilisable par une extension est, par construction,
récupérable par qui a la main sur la machine. Utilisez une clé dédiée, avec un plafond
de dépense côté fournisseur.
