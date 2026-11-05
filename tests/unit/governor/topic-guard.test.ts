import { describe, expect, it } from 'vitest'
import {
  classifyTopic,
  normalizeForMatching,
  UNIVERSAL_BLOCKED,
} from '@/governor/topic-guard'

describe('topic-guard — noyau universel', () => {
  it('écarte les sujets de santé', () => {
    const v = classifyTopic('mon père vient d’avoir un diagnostic de cancer')
    expect(v.blocked).toBe(true)
    expect(v.categories).toContain('health')
  })

  it('écarte le deuil, en français et en anglais', () => {
    expect(classifyTopic('my father passed away last night').categories).toContain(
      'grief',
    )
    expect(classifyTopic('je viens de perdre mon frère').categories).toContain('grief')
    expect(classifyTopic('RIP legend').categories).toContain('grief')
  })

  it('écarte la politique', () => {
    expect(classifyTopic('this election will decide everything').categories).toContain(
      'politics',
    )
    expect(classifyTopic('les législatives changent tout').categories).toContain(
      'politics',
    )
  })

  it('écarte les crises en cours', () => {
    expect(classifyTopic('BREAKING: 12 dead in the attack').categories).toContain(
      'crisis',
    )
    expect(classifyTopic('un séisme vient de frapper la région').categories).toContain(
      'crisis',
    )
  })

  it('écarte le conseil financier — y compris dans la niche memecoin (MH-02)', () => {
    // Le cœur du garde-fou ajouté en Phase 0 : ce sont les formulations qui font
    // suspendre un compte crypto, et elles ne doivent jamais sortir du produit.
    const cases = [
      'this is going 100x easily',
      'to the moon 🚀',
      'my price target is $4',
      'not financial advice but buy now',
      'guaranteed returns in 3 weeks',
      'aping in full port',
      'presale whitelist spot available',
    ]
    for (const text of cases) {
      const v = classifyTopic(text)
      expect(v.categories, `« ${text} » doit être écarté`).toContain('financial-advice')
    }
  })

  it('laisse passer la culture memecoin qui ne parle pas de prix', () => {
    // Sinon le garde-fou rendrait la niche pilote inexploitable — ce serait un
    // faux positif qui coûte le produit.
    const ok = [
      'the bonding curve mechanics here are genuinely interesting',
      'low float plus a real community is a rare combination',
      'the meme is the product, the ticker is the receipt',
      'liquidity got locked, dev wallet is public',
    ]
    for (const text of ok) {
      expect(classifyTopic(text).blocked, `« ${text} » ne doit pas être écarté`).toBe(
        false,
      )
    }
  })

  it('écarte les accusations non établies', () => {
    expect(classifyTopic('this guy is a scammer, proven').categories).toContain(
      'legal-accusation',
    )
  })

  it('résiste au contournement par diacritiques et caractères décoratifs', () => {
    // Fréquent sur X : l'emphase unicode contournerait une comparaison naïve.
    expect(classifyTopic('dècès de mon oncle').blocked).toBe(true)
    expect(normalizeForMatching('𝗱écès')).toContain('deces'.slice(0, 1))
  })

  it('applique la couche pack en plus du noyau', () => {
    const v = classifyTopic(
      'discussion sur le doxxing du développeur anonyme du projet',
      ['doxxing ou identification d’un développeur anonyme'],
    )
    expect(v.blocked).toBe(true)
    expect(v.packTopics.length).toBe(1)
  })

  it('n’autorise pas un pack à débloquer le noyau', () => {
    // Invariant de sûreté du format : la couche pack est purement additive. Il n'existe
    // aucune API pour retirer une catégorie universelle, et ce test le fige.
    const v = classifyTopic('going to 100x from here', [])
    expect(v.blocked).toBe(true)
    // Le seul point d'extension est `packBlockedTopics`, qui ne peut qu'ajouter.
    const withPack = classifyTopic('going to 100x from here', ['un sujet quelconque'])
    expect(withPack.blocked).toBe(true)
  })

  it('couvre le français et l’anglais dans chaque catégorie', () => {
    // Ajouter une langue à la config sans étendre les motifs serait un trou de sécurité.
    for (const rule of UNIVERSAL_BLOCKED) {
      expect(rule.patterns.length, `${rule.category} sans motif`).toBeGreaterThan(0)
      expect(rule.why.length).toBeGreaterThan(10)
    }
  })

  it('ne bloque pas un texte anodin', () => {
    const v = classifyTopic(
      'bon point, j’ajouterais que la rétention compte plus que le CAC',
    )
    expect(v.blocked).toBe(false)
    expect(v.categories).toHaveLength(0)
  })
})

describe('topic-guard — heuristique de sujet de pack, cas limites', () => {
  it('ignore un sujet trop court pour être discriminant', () => {
    // Un « sujet » de deux caractères matcherait partout : on refuse plutôt que de
    // laisser un pack mal rempli bloquer toute la file.
    expect(classifyTopic('un texte quelconque sur le sujet', ['ab']).blocked).toBe(false)
  })

  it('accepte un sujet d’un seul mot significatif', () => {
    expect(classifyTopic('discussion autour du tokenomics', ['tokenomics']).blocked).toBe(
      true,
    )
  })

  it('cherche la chaîne entière quand aucun mot ne dépasse 3 lettres', () => {
    // Cas dégénéré : « bot net » n'a que des mots courts, on retombe sur l'inclusion.
    expect(classifyTopic('parler de bot net ici', ['bot net']).blocked).toBe(true)
    expect(classifyTopic('parler de robots ici', ['bot net']).blocked).toBe(false)
  })

  it('reconnaît une reformulation qui réutilise la moitié des termes', () => {
    // Raison d'être du seuil à la moitié : l'auteur ne reprend jamais la formulation
    // exacte du pack.
    const topic = 'doxxing ou identification d’un développeur anonyme'
    expect(
      classifyTopic('le doxxing du développeur, sérieusement ?', [topic]).blocked,
    ).toBe(true)
  })

  it('LIMITE CONNUE : la variation morphologique n’est pas détectée', () => {
    // « doxxent » n'est pas reconnu comme une forme de « doxxing ». Un classifieur
    // lexical ne fait pas de morphologie, et le prétendre par un préfixe de 4 lettres
    // créerait des faux positifs ailleurs (« deve » matcherait « devenir »).
    //
    // C'est assumé, pas ignoré : ce garde-fou doit rester gratuit, déterministe et
    // indépendant du réseau — c'est sa valeur. Le classifieur LLM de la Phase 3 traitera
    // les cas limites EN PLUS de celui-ci, jamais à sa place. Ce test existe pour que la
    // limite soit visible dans la suite plutôt que découverte en production.
    const topic = 'doxxing ou identification d’un développeur anonyme'
    expect(classifyTopic('ils doxxent le dev du projet', [topic]).blocked).toBe(false)
  })

  it('ne déclenche pas sur un seul mot fréquent d’un sujet long', () => {
    const topic = 'accusations de fraude non établies contre une personne nommée'
    // « personne » seul ne doit pas suffire : c'est le faux positif qu'on évite.
    expect(classifyTopic('personne ne sait vraiment', [topic]).blocked).toBe(false)
  })

  it('gère une liste de sujets vide', () => {
    expect(classifyTopic('texte anodin', []).blocked).toBe(false)
    expect(classifyTopic('texte anodin').blocked).toBe(false)
  })
})
