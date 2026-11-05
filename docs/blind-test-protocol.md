# Protocole du blind test — DoD de la Phase 2

**Statut : préenregistré le 2026-08-25, avant toute production de variante.**
Ce fichier est figé. Les résultats vont dans `docs/blind-test-<date>-results.md`.

## Pourquoi ce fichier existe

La spec dit « les réponses sont indiscernables de mon style sur un blind test de 10
exemples ». Ce n'est pas un critère mesurable : ni protocole, ni juges, ni seuil. Sans
préenregistrement, on ajuste la cible aux résultats obtenus et le DoD ne mesure plus rien —
il se contente de ratifier ce qu'on a produit.

## Matériel

10 paires. Chaque paire contient :

- **A** — un vrai post de @ACMECTO, choisi au hasard dans le corpus collecté, **hors**
  posts purement promotionnels (voir « Contrainte propre à ce compte » plus bas).
- **B** — une réponse produite par SWARM, sur le même sujet, dans le même format et la même
  longueur cible (± 20 %).

L'ordre A/B est tiré au sort par paire, avec une graine consignée dans le fichier de
résultats. Sans ça, un juge qui remarque que l'humain est toujours en premier ne juge plus
le style.

## Juges

3 personnes, qui :

- ne savent pas laquelle des deux est générée ;
- ne sont pas l'utilisateur — il reconnaîtra toujours ses propres posts, son jugement ne
  mesurerait rien ;
- n'ont pas participé à la rédaction des prompts.

## Tâche

Pour chaque paire : désigner celui qui a été écrit par un humain. Réponse forcée, pas de
« je ne sais pas » — une option d'abstention transformerait un échec en indécision.

## Seuil

**Succès si ≤ 60 % d'identifications correctes** sur les 30 jugements (3 juges × 10 paires).

- 50 % = hasard pur, donc indiscernabilité parfaite.
- 60 % laisse la marge d'un échantillon de 30, qui est petit.
- 100 % = échec total.

Le seuil est fixé maintenant et ne bouge pas. Si le résultat est à 63 %, la phase n'est pas
validée : on itère sur le WRITER et le Voice Profile, pas sur le protocole.

## Ce que ce test ne mesure pas

À dire clairement, parce qu'un test qui prétend mesurer plus qu'il ne mesure est pire qu'un
test absent :

- Il ne mesure pas si les réponses sont **bonnes**, seulement si elles sont **indiscernables**.
  Une imitation parfaite d'un style creux resterait creuse. La valeur ajoutée est le travail
  du CRITIC, mesuré autrement.
- Il ne mesure pas la performance réelle sur X. C'est la Phase 5.
- Avec 30 jugements, l'intervalle de confiance est large. C'est une porte, pas une preuve.

## Signal quotidien, distinct de la porte

Mobiliser 3 juges à chaque itération est impraticable. La métrique de distance de voix
(`memory/voice-distance.ts`) sert de signal continu entre deux portes : elle ne remplace pas
le blind test, elle évite d'itérer à l'aveugle.

---

## Contrainte propre à ce compte

Le compte pilote @ACMECTO est un **compte de projet** ($acme, Solana), pas un compte
personnel. Sa voix native est en grande partie promotionnelle : annonces de token,
formulations de type « maximum potential », « from microcap to legendary », adresses de
contrat.

Ces formulations sont bloquées par le noyau universel du topic-guard (FEEDBACK MH-02), et
c'est délibéré : ce sont elles qui font suspendre un compte crypto.

**Conséquence sur le blind test** : les paires excluent les posts purement promotionnels du
corpus. Les comparer serait absurde — on demanderait à des juges de distinguer un post que
SWARM a interdiction de produire d'une réponse que SWARM produit sous contrainte. Le test
porte sur les posts où le compte parle **culture, mécanique on-chain et communauté**, qui
est le registre que le produit sait et doit reproduire.

Si le corpus ne contient pas assez de posts non promotionnels pour constituer 10 paires,
c'est un résultat en soi et il doit être écrit : cela signifie que le Voice Profile n'a pas
de matière exploitable sous les garde-fous, et que la Phase 2 doit s'arrêter là pour ce
compte plutôt que de produire une imitation de ce qui est interdit. Voir FEEDBACK D-11.
