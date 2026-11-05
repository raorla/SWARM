<!-- Généré par `npm run calibrate:critic`. Ne pas éditer : relancer. -->

Jeu : 18 réponses étiquetées — 6 à publier, 12 à rejeter · apport-reel: 6 · accord-reformule: 3 · registre-assistant: 3 · signal-de-prix: 3 · affirmation-non-sourcee: 2 · redondance: 1
Notés : 18 / 18 · coût 0.09256 €
# Calibration du seuil de veto du CRITIC

Échantillon : 18 réponses étiquetées (6 à publier, 12 à rejeter).

**Diagnostic de notation** : notation discriminante : étendue 0.65, séparation 0.41

**Seuil recommandé** : seuil 0.55 · rejet 72 % · précision 100 % · rappel 83 % · ⚠ échantillon de 18 : indicatif seulement, viser 40+

> **Note ajoutée à la main après ce run** — le code applique **0,45**, pas 0,55. Les deux ont
> exactement le même résultat mesuré (voir le plateau 0,30–0,55 dans le tableau), mais 0,55 est
> collé à la falaise : au seuil suivant, 0,60, le rappel tombe à 17 %. `calibrate()` a été
> corrigé après ce run pour recommander le **milieu** du plateau plutôt que son bord ; un
> prochain run affichera donc directement une valeur centrale. Voir FEEDBACK D-20.

| seuil | rejet | précision | rappel | faux + | faux − | score |
|---|---|---|---|---|---|---|
| 0.30 | 72 % | 100 % | 83 % | 0 | 1 | 0.931 |
| 0.35 | 72 % | 100 % | 83 % | 0 | 1 | 0.931 |
| 0.40 | 72 % | 100 % | 83 % | 0 | 1 | 0.931 |
| 0.45 | 72 % | 100 % | 83 % | 0 | 1 | 0.931 |
| 0.50 | 72 % | 100 % | 83 % | 0 | 1 | 0.931 |
| 0.55 | 72 % | 100 % | 83 % | 0 | 1 | 0.931 |
| 0.60 | 94 % | 100 % | 17 % | 0 | 5 | 0.653 |
| 0.65 | 94 % | 100 % | 17 % | 0 | 5 | 0.653 |
| 0.70 | 100 % | 100 % | 0 % | 0 | 6 | 0.583 |
| 0.75 | 100 % | 100 % | 0 % | 0 | 6 | 0.583 |
| 0.80 | 100 % | 100 % | 0 % | 0 | 6 | 0.583 |
| 0.85 | 100 % | 100 % | 0 % | 0 | 6 | 0.583 |
| 0.90 | 100 % | 100 % | 0 % | 0 | 6 | 0.583 |

Faux positifs pondérés ×3 : publier une mauvaise réponse coûte de
la crédibilité et c’est irréversible ; en rater une bonne coûte une occasion, et il y en
aura d’autres demain.
