/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://x.com/ACMECTO" }
 *
 * Détection du handle et garde de profil.
 *
 * Le second bloc est un test de sûreté, pas de fonctionnalité : `isOwnProfilePage` est ce qui
 * empêche le collecteur de parcourir le profil de quelqu'un d'autre. Un faux positif ici
 * transformerait un outil d'onboarding en collecteur de profils tiers.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectOwnHandle, isOwnProfilePage } from '@/content/scout/own-identity'

const FIXTURES = join(process.cwd(), 'tests/fixtures/x-dom')

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('detectOwnHandle', () => {
  it('lit le handle depuis le href du lien de profil', () => {
    document.body.innerHTML = readFileSync(join(FIXTURES, 'sidenav-account.html'), 'utf8')
    const detected = detectOwnHandle()
    expect(detected?.handle).toBe('ACMECTO')
    // Le href est un identifiant, pas un libellé traduisible : c'est la source préférée.
    expect(detected?.source).toBe('profile-link')
  })

  it('retombe sur le texte du bouton de compte', () => {
    document.body.innerHTML = `
      <nav role="navigation">
        <button data-testid="SideNav_AccountSwitcher_Button" aria-label="Account menu">
          <span>ACME</span><span>@ACMECTO</span>
        </button>
      </nav>`
    const detected = detectOwnHandle()
    expect(detected?.handle).toBe('ACMECTO')
    expect(detected?.source).toBe('account-button')
  })

  it('renvoie null quand rien n’est trouvable', () => {
    // Mieux qu'un handle deviné : un handle faux ferait collecter le corpus d'un autre.
    document.body.innerHTML = '<div>page sans barre latérale</div>'
    expect(detectOwnHandle()).toBeNull()
  })

  it('ne confond pas un chemin réservé avec un handle', () => {
    document.body.innerHTML = `
      <nav><a href="/home" role="link" data-testid="AppTabBar_Profile_Link">Home</a></nav>`
    expect(detectOwnHandle()).toBeNull()
  })

  it('ignore un href qui n’est pas un profil', () => {
    document.body.innerHTML = `
      <nav><a href="/i/bookmarks" role="link" data-testid="AppTabBar_Profile_Link">x</a></nav>`
    expect(detectOwnHandle()).toBeNull()
  })
})

describe('isOwnProfilePage — garde du collecteur', () => {
  const at = (path: string): URL => new URL(`https://x.com${path}`)

  it('reconnaît le profil et ses onglets', () => {
    for (const path of [
      '/ACMECTO',
      '/ACMECTO/',
      '/ACMECTO/with_replies',
      '/ACMECTO/media',
      '/ACMECTO/highlights',
    ]) {
      expect(isOwnProfilePage(at(path), 'ACMECTO'), path).toBe(true)
    }
  })

  it('tolère le @ et la casse', () => {
    expect(isOwnProfilePage(at('/ACMECTO'), '@acmecto')).toBe(true)
    expect(isOwnProfilePage(at('/acmecto'), 'ACMECTO')).toBe(true)
  })

  it('REFUSE tout autre profil', () => {
    // Le test qui compte : c'est ce refus qui empêche l'outil de devenir un collecteur de
    // profils tiers.
    for (const path of ['/someoneelse', '/aliceonchain/with_replies', '/ACMECTO2']) {
      expect(isOwnProfilePage(at(path), 'ACMECTO'), path).toBe(false)
    }
  })

  it('refuse une page qui n’est pas un profil', () => {
    for (const path of [
      '/home',
      '/ACMECTO/status/1789456123456789012',
      '/search?q=test',
      '/messages',
      '/',
    ]) {
      expect(isOwnProfilePage(at(path), 'ACMECTO'), path).toBe(false)
    }
  })

  it('refuse un préfixe partiel', () => {
    // « ACME » est un préfixe de « ACMECTO » : un match laxiste laisserait passer.
    expect(isOwnProfilePage(at('/ACME'), 'ACMECTO')).toBe(false)
  })
})
