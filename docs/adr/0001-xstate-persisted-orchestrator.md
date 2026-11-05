# ADR 0001 — Orchestrateur XState avec snapshot persisté

- **Statut** : accepté
- **Date** : 2026-08-25
- **Phase** : 0

## Contexte

Le swarm est un pipeline à neuf états avec des transitions conditionnelles (budget,
plafonds, fenêtres horaires, veto du CRITIC, validation humaine) et un kill switch qui
doit être traité même au milieu d'un appel LLM.

Le service worker MV3 qui héberge cet orchestrateur est tué sans préavis après ~30 s
d'inactivité.

## Options

1. **Chaîne de promesses avec un état en mémoire.** Simple à écrire. Perd tout au réveil,
   et rend le kill switch inopérant pendant un `await`.
2. **Machine à états maison, état en base.** Contrôle total, mais on réimplémente les
   gardes, les régions parallèles et les acteurs — mal.
3. **XState v5 avec `getPersistedSnapshot()` à chaque transition.** Retenu.

## Décision

XState v5. Deux régions parallèles : `governance` et `pipeline`. Le snapshot est
sérialisé en base à chaque transition et restauré au démarrage du service worker.

## Conséquences

**Positives.** Les invariants de sûreté deviennent structurels plutôt que
conventionnels : le kill switch vit dans une région parallèle donc il est traité quel
que soit l'état du pipeline ; `awaitingHuman` n'a aucune transition temporelle donc le
Copilote ne peut pas dériver vers la publication automatique ; le `always` de `queued`
retombe sur la validation humaine en dernier recours. La machine est de plus
inspectable, ce qui rend l'onglet Swarm quasi gratuit.

**Négatives.** Le contexte de la machine doit rester sérialisable — pas de fonction, pas
de classe, pas de référence DOM dedans. Coût d'écriture en base à chaque transition, à
surveiller si la fréquence monte. Et une dépendance de plus dans le bundle.

## Alternative écartée et pourquoi

L'option 1 a été écartée non pas pour l'élégance mais pour un cas précis : un kill
switch qui ne fonctionne pas pendant un appel LLM en cours est un kill switch qui ne
fonctionne pas au moment exact où on en a besoin.
