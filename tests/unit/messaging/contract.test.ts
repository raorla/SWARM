import { describe, expect, it } from 'vitest'
import {
  MessageSchema,
  MSG,
  PostSnapshotSchema,
  ResponseSchema,
} from '@/messaging/contract'
import { HandleSchema, XPostIdSchema } from '@/shared/zod-helpers'

const validPost = {
  postId: '1789456123456789012',
  authorHandle: 'someone',
  authorFollowers: 4200,
  text: 'un post',
  lang: 'fr',
  createdAtMs: 1_760_000_000_000,
  replyCount: 12,
  likeCount: 80,
  repostCount: 3,
  hasMedia: false,
  isReply: false,
  surface: 'timeline' as const,
  observedAtMs: 1_760_000_060_000,
}

describe('contrat de messagerie', () => {
  it('accepte un message conforme', () => {
    const r = MessageSchema.safeParse({
      type: MSG.POSTS_OBSERVED,
      payload: { posts: [validPost] },
    })
    expect(r.success).toBe(true)
  })

  it('rejette un type inconnu', () => {
    // Un message hors contrat doit etre rejete, pas ignore : un message perdu en silence
    // est un bug qu'on cherche pendant une heure.
    expect(MessageSchema.safeParse({ type: 'inventé', payload: {} }).success).toBe(false)
  })

  it('rejette une charge utile mal formee', () => {
    expect(
      MessageSchema.safeParse({
        type: MSG.POSTS_OBSERVED,
        payload: { posts: [{ ...validPost, replyCount: -1 }] },
      }).success,
    ).toBe(false)
  })

  it('borne la taille des lots de posts', () => {
    // Sans borne, un content script bugue pourrait saturer le service worker.
    const tooMany = Array.from({ length: 500 }, () => validPost)
    expect(
      MessageSchema.safeParse({ type: MSG.POSTS_OBSERVED, payload: { posts: tooMany } })
        .success,
    ).toBe(false)
  })

  it('exige un jeton de permis pour mettre un brouillon en scene', () => {
    // Le content script refuse d'agir sans jeton : c'est le miroir de l'invariant du
    // governor cote messagerie.
    expect(
      MessageSchema.safeParse({
        type: MSG.STAGE_DRAFT,
        payload: { idempotencyKey: 'k'.repeat(10), postId: validPost.postId, text: 'ok' },
      }).success,
    ).toBe(false)

    expect(
      MessageSchema.safeParse({
        type: MSG.STAGE_DRAFT,
        payload: {
          idempotencyKey: 'k'.repeat(10),
          postId: validPost.postId,
          text: 'ok',
          permitToken: 'a'.repeat(32),
        },
      }).success,
    ).toBe(true)
  })

  it('modelise la reponse comme un resultat, jamais une valeur nue', () => {
    expect(ResponseSchema.safeParse({ ok: true, data: { x: 1 } }).success).toBe(true)
    expect(
      ResponseSchema.safeParse({ ok: false, error: 'boum', code: 'X' }).success,
    ).toBe(true)
    expect(ResponseSchema.safeParse({ data: 'sans enveloppe' }).success).toBe(false)
  })
})

describe('helpers Zod de frontiere', () => {
  it('normalise un handle en retirant le @', () => {
    expect(HandleSchema.parse('@someone')).toBe('someone')
    expect(HandleSchema.parse('  someone  ')).toBe('someone')
  })

  it('rejette un handle invalide', () => {
    for (const bad of ['', 'a'.repeat(16), 'avec espace', 'accentué', '@@double']) {
      expect(HandleSchema.safeParse(bad).success, `« ${bad} » doit etre rejete`).toBe(
        false,
      )
    }
  })

  it('valide un identifiant de post X', () => {
    expect(XPostIdSchema.safeParse('1789456123456789012').success).toBe(true)
    for (const bad of ['abc', '12', '', '17894561234567890123456789012']) {
      expect(XPostIdSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('valide un instantane de post complet', () => {
    expect(PostSnapshotSchema.safeParse(validPost).success).toBe(true)
    expect(
      PostSnapshotSchema.safeParse({ ...validPost, surface: 'inconnu' }).success,
    ).toBe(false)
  })
})
