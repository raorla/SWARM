# Risques et limites

Ce document n'est pas une décharge de responsabilité. C'est ce qu'il faut savoir avant
de connecter un compte auquel on tient.

## 1. Le risque principal : les règles de X

X interdit l'automatisation de l'engagement. Publier des réponses par automatisation du
DOM, à quelque cadence que ce soit, contrevient à ses règles d'automatisation. Aucune
quantité de délais log-normaux ne rend cela conforme — le hasard rend un pattern plus
difficile à détecter, pas plus légitime.

**C'est pourquoi le mode Copilote est le mode par défaut, et le seul livré jusqu'à la
Phase 8.** En Copilote, SWARM pré-remplit le composeur de X et s'arrête. C'est vous qui
cliquez « Publier ». Vous restez l'auteur et le décideur de chaque action ; l'outil
accélère votre jugement, il ne le remplace pas.

L'Autopilote (Phase 8) existe parce que le cahier des charges le demande. Il est
derrière un opt-in explicite, un écran d'avertissement, et des plafonds plus bas. Notre
recommandation, y compris commerciale, reste le Copilote.

## 2. Le risque spécifique au contenu financier

Si votre niche touche aux cryptomonnaies, aux memecoins ou aux marchés, sachez que les
règles de X sur le **spam financier** sont appliquées plus durement que ses règles
d'automatisation. Le pattern « reply guy crypto » est l'un des plus signalés de la
plateforme.

SWARM interdit par construction, dans une couche non désactivable : la prédiction de
prix, le conseil d'investissement, la promotion de ticker non sollicitée.

Ce n'est pas une restriction de la niche. Un pack `memecoin` parle culture, mèmes,
mécanique on-chain, dynamique communautaire — et pas « ça va faire ×10 ». C'est aussi la
frontière entre une réponse qui gagne des abonnés et une réponse qui se fait mute.

## 3. Ce qui peut mal se passer

| Risque | Probabilité | Mitigation dans le produit |
|---|---|---|
| X change son DOM, le parsing casse | **Élevée**, plusieurs fois par an | Sélecteurs centralisés, fallbacks, détection de rupture avec alerte, capture de fixture |
| Le compte est signalé pour spam | Faible en Copilote, réelle en Autopilote | Plafonds durs, cadence, topic-guard, veto du CRITIC, Copilote par défaut |
| Dépassement de budget LLM | Faible | Plafond dur lisant l'`usage` réel, réserve segmentée, blocage à l'épuisement |
| Perte de données locales | **Réelle** — profil corrompu, désinstallation | Export chiffré complet dès la Phase 0. À utiliser. |
| Réponses génériques qui nuisent à la réputation | Moyenne | Veto du CRITIC, Voice Profile, anti-répétition sémantique |
| Fuite de la clé API | Faible | Chiffrement au repos, jamais dans les logs ni les URL — mais voir §5 |
| Indisponibilité du provider | Moyenne | Chaîne de repli, backoff, dégradation explicite plutôt que silencieuse |

## 4. Limites connues, assumées

- **Un seul compte.** Par conception, définitivement. Pas de « ferme de comptes ».
- **Aucun DM automatique.** Le code d'envoi n'existe pas.
- **Le Voice Profile a besoin de matière.** Sous ~50 posts publics, l'imitation de style
  est faible et le CRITIC rejettera beaucoup. C'est le comportement correct.
- **La mesure d'impressions dépend de ce que X affiche.** Si X masque une métrique,
  l'attribution se dégrade — l'onglet Analytics le signalera plutôt que d'interpoler.
- **L'attribution des followers est corrélationnelle**, pas causale : proximité
  temporelle plus visite de profil. Elle est utile comme signal comparatif entre
  patterns, pas comme vérité.
- **Le backtest ne rejoue que ce qui a été archivé.** Il ne simule pas la réaction du
  public : il compare le comportement du swarm sous deux configurations, pas les
  résultats réels qu'elles auraient produits.

## 5. Limite honnête sur le chiffrement des clés

Le chiffrement AES-GCM au repos protège du vol du fichier de profil. Il ne protège pas
d'un attaquant qui contrôle déjà votre session : une clé utilisable par une extension
est récupérable par qui a la main sur la machine.

Utilisez une clé API dédiée, avec un plafond de dépense configuré chez le fournisseur.

## 6. Ce que le produit ne prétend pas être

SWARM n'est pas un générateur de croissance garantie. Il fait trois choses : il vous
évite de lire 200 posts pour en trouver 12 qui valent une réponse, il vous propose des
réponses dans votre voix, et il **mesure ce qui a marché** pour que la proposition
suivante soit meilleure.

Si vos réponses n'apportent rien, SWARM les rédigera plus vite. La boucle
d'apprentissage optimise ce que vous lui laissez publier — pas la qualité de votre
jugement.
