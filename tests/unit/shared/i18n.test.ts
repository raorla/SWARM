import { describe, expect, it, afterEach } from 'vitest'
import {
  catalogKeys,
  DEFAULT_LOCALE,
  getLocale,
  LOCALES,
  setLocale,
  t,
} from '@/shared/i18n'

afterEach(() => setLocale(DEFAULT_LOCALE))

describe('i18n (MH-11)', () => {
  it('traduit dans la locale active', () => {
    setLocale('fr')
    expect(t('tab.flux')).toBe('Flux')
    setLocale('en')
    expect(t('tab.flux')).toBe('Feed')
  })

  it('interpole les parametres', () => {
    // Aucune cle du catalogue n'en a pour l'instant ; le mecanisme doit exister avant
    // d'en avoir besoin, sinon on le retrofite sur quatre onglets en Phase 8.
    expect(t('total {n} sur {max}', { n: 3, max: 12 })).toBe('total 3 sur 12')
  })

  it('laisse visible un parametre manquant', () => {
    // Preferable a une chaine vide : un trou visible se corrige, un trou invisible non.
    expect(t('bonjour {prenom}', {})).toBe('bonjour {prenom}')
  })

  it('retourne la cle si elle est absente', () => {
    // Une cle visible dans l'UI est un bug qu'on voit ; un texte vide est un bug qu'on
    // ne voit pas.
    expect(t('cle.qui.n.existe.pas')).toBe('cle.qui.n.existe.pas')
  })

  it('tous les catalogues ont exactement les memes cles', () => {
    // Sinon une locale afficherait des cles brutes en production.
    const keys = catalogKeys()
    const reference = [...keys[DEFAULT_LOCALE]].sort()
    for (const locale of LOCALES) {
      expect([...keys[locale]].sort(), `catalogue ${locale} divergent`).toEqual(reference)
    }
  })

  it('expose la locale courante', () => {
    setLocale('en')
    expect(getLocale()).toBe('en')
  })
})
