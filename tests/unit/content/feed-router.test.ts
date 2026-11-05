import { describe, expect, it } from 'vitest'
import { detectSurface, eqHandle, isObservable } from '@/content/scout/feed-router'

const at = (path: string): URL => new URL(`https://x.com${path}`)

describe('detectSurface', () => {
  it('reconnaît la timeline', () => {
    expect(detectSurface(at('/')).surface).toBe('timeline')
    expect(detectSurface(at('/home')).surface).toBe('timeline')
  })

  it('reconnaît les notifications et les bookmarks', () => {
    expect(detectSurface(at('/notifications')).surface).toBe('notifications')
    expect(detectSurface(at('/notifications/mentions')).surface).toBe('notifications')
    expect(detectSurface(at('/i/bookmarks')).surface).toBe('bookmarks')
  })

  it('reconnaît la recherche et en extrait la requête', () => {
    const ctx = detectSurface(at('/search?q=memecoin&src=typed_query'))
    expect(ctx.surface).toBe('search')
    expect(ctx.searchQuery).toBe('memecoin')
  })

  it('classe un profil de la watchlist comme watchlist', () => {
    // La distinction compte pour le scoring : on a une affinité établie avec ce compte.
    expect(detectSurface(at('/aliceonchain'), ['aliceonchain']).surface).toBe('watchlist')
    expect(detectSurface(at('/aliceonchain'), []).surface).toBe('search')
  })

  it('tolère le @ et la casse dans la watchlist', () => {
    expect(detectSurface(at('/AliceOnChain'), ['@aliceonchain']).surface).toBe(
      'watchlist',
    )
  })

  it('reconnaît un fil de conversation', () => {
    const ctx = detectSurface(at('/bob/status/1789456123456789012'))
    expect(ctx.surface).toBe('timeline')
    expect(ctx.profileHandle).toBe('bob')
  })

  it('n’observe RIEN sur /messages — SPEC §2.2', () => {
    // Ne pas observer une page est plus fort que filtrer ce qu'on y a lu.
    expect(detectSurface(at('/messages')).surface).toBe('unsupported')
    expect(detectSurface(at('/messages/1234-5678')).surface).toBe('unsupported')
    expect(isObservable(detectSurface(at('/messages')))).toBe(false)
  })

  it('n’observe pas les pages de compte et de réglages', () => {
    for (const path of [
      '/settings/account',
      '/i/flow/login',
      '/login',
      '/i/premium',
      '/account',
    ]) {
      expect(detectSurface(at(path)).surface, path).toBe('unsupported')
    }
  })

  it('ne confond pas un chemin réservé avec un profil', () => {
    // `/explore` est une surface de recherche, pas le profil de @explore.
    expect(detectSurface(at('/explore')).surface).toBe('search')
    expect(detectSurface(at('/i')).surface).toBe('unsupported')
    expect(detectSurface(at('/compose')).surface).toBe('unsupported')
    expect(detectSurface(at('/lists')).surface).toBe('unsupported')
  })

  it('reconnaît les onglets de profil', () => {
    expect(detectSurface(at('/bob/with_replies')).surface).toBe('search')
    expect(detectSurface(at('/bob/media')).surface).toBe('search')
  })

  it('tolère un slash final', () => {
    expect(detectSurface(at('/home/')).surface).toBe('timeline')
  })

  it('renvoie unsupported sur un chemin inconnu', () => {
    expect(detectSurface(at('/some/deep/unknown/path')).surface).toBe('unsupported')
  })
})

describe('eqHandle', () => {
  it('compare sans tenir compte du @ ni de la casse', () => {
    expect(eqHandle('@Alice', 'alice')).toBe(true)
    expect(eqHandle('alice', 'ALICE')).toBe(true)
    expect(eqHandle('alice', 'bob')).toBe(false)
  })
})
