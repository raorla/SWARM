# ADR 0002 — Embeddings locaux, jamais par API

- **Statut** : accepté
- **Date** : 2026-08-25
- **Phase** : 0 (décidé) / 6 (implémenté)

## Contexte

La mémoire relationnelle et l'anti-répétition sémantique ont besoin d'embeddings sur :
les posts qualifiés, nos réponses passées, les sujets par compte. À 200 posts par jour,
le volume est significatif et permanent.

Le budget est de **1 €/jour, tout compris**.

## Décision

Les embeddings sont calculés **entièrement en local**, dans l'Offscreen Document, avec
un petit modèle ONNX embarqué (~30 Mo) via `transformers.js`. Aucun appel à une API
d'embedding, quel que soit le provider.

## Justification

Trois arguments indépendants qui pointent dans la même direction :

1. **Coût.** Une ligne de coût récurrente sur les embeddings est intenable à 1 €/jour,
   et elle croît avec l'usage — donc avec la valeur du produit.
2. **Confidentialité.** Envoyer chaque post lu à une API d'embedding ferait du vector
   store le plus gros canal d'egress du produit, en contradiction directe avec la
   promesse local-first qui est notre argument de confiance principal.
3. **Le plus important : la disponibilité.** Si le budget quotidien est épuisé, la
   mémoire relationnelle et l'anti-répétition doivent **continuer à fonctionner**. Un
   plafond atteint ne doit pas rendre le système amnésique — sinon la fin de journée
   produit systématiquement les réponses les plus répétitives.

## Conséquences

**Positives.** Coût nul et constant. Zéro egress pour la mémoire. Fonctionne hors
budget, et hors ligne. Qualité suffisante : on cherche une similarité approximative
entre textes courts, pas un classement de précision.

**Négatives.** ~30 Mo dans le bundle de l'extension, ce qui pèse sur le temps
d'installation. Charge CPU sur la machine de l'utilisateur — d'où l'Offscreen Document
et un batch throttlé. Qualité inférieure à un modèle d'embedding de pointe : acceptable
pour de la déduplication, à réévaluer si la Phase 6 montre trop de faux négatifs sur
l'anti-répétition.
