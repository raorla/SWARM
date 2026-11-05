# Fixtures DOM de X

## Ce que sont ces fichiers

Des fragments HTML **synthétisés** à partir des `data-testid` documentés de X, pas des
captures réelles. Ils reproduisent la structure que `src/content/dom/x-selectors.ts` visé,
avec les attributs qui portent cette structure et rien d'autre.

## Pourquoi c'est explicitement dit

Un test qui passe sur une fixture synthétisée prouve que **le parseur fait ce qu'on croit**,
pas que **X ressemble à ça**. Confondre les deux donnerait une fausse confiance : la suite
serait verte le jour où X change son DOM.

La vérification contre le vrai DOM se fait autrement, et c'est prévu :

- `snapshot-on-break.ts` (MH-14) capture un fragment **anonymisé** à la première rupture
  réelle. Ce fragment devient une fixture, nommée `*.captured.html`.
- Ces captures sont exclues du dépôt par `.gitignore` jusqu'à relecture : une capture
  contient la structure du DOM de quelqu'un, et on la relit avant de la versionner.

## Convention de nommage

| Fichier | Ce qu'il couvre |
|---|---|
| `timeline-post.html` | Post standard du fil : texte, auteur, horodatage, métriques |
| `post-with-media.html` | Post avec image — le sélecteur média doit matcher |
| `reply-in-thread.html` | Réponse dans un fil — `isReply` doit être vrai |
| `promoted-post.html` | Post sponsorisé — doit être **écarté**, pas parsé |
| `post-no-metrics.html` | Post sans compteur affiché — zéro, pas « inconnu » |
| `broken-post.html` | Structure dégradée — l'extraction doit échouer proprement |
| `composer-open.html` | Composeur ouvert — cible de l'actuator |

## Quand X casse le parsing

1. L'utilisateur reçoit l'alerte ; le fragment anonymisé est dans
   `chrome.storage.local` sous `swarm:selector-health`.
2. On le relit, on le dépose ici en `*.captured.html`.
3. On ajoute le nouveau sélecteur **en tête** de la cascade concernée dans
   `x-selectors.ts` — sans retirer l'ancien : X déploie progressivement, les deux
   coexistent pendant des jours.
4. Le test correspondant passe sur les deux fixtures.
