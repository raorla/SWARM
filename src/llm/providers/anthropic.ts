/**
 * Provider Anthropic en direct.
 *
 * Présent dès la Phase 0 comme voie de repli du prompt caching (FEEDBACK R-03) : si
 * OpenRouter ne propage pas `cache_control`, WRITER et CRITIC basculent ici et
 * OpenRouter garde le triage. Cette bifurcation est prévue par l'architecture, elle ne
 * demandera pas de réécriture.
 */
import { LlmError, kindFromStatus, retryAfterMs } from '../errors'
import { ZERO_USAGE, type LlmRequest, type Provider, type TokenUsage } from '../types'

const BASE_URL = 'https://api.anthropic.com/v1'
const API_VERSION = '2023-06-01'

function splitSystem(req: LlmRequest): {
  system: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]
  messages: { role: 'user' | 'assistant'; content: string }[]
} {
  const system: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] =
    []
  const messages: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of req.messages) {
    if (m.role === 'system') {
      system.push(
        m.cacheable
          ? { type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }
          : { type: 'text', text: m.content },
      )
    } else {
      messages.push({ role: m.role, content: m.content })
    }
  }
  return { system, messages }
}

function readUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0
  return {
    inputTokens: num(u['input_tokens']),
    outputTokens: num(u['output_tokens']),
    cacheReadTokens: num(u['cache_read_input_tokens']),
    cacheWriteTokens: num(u['cache_creation_input_tokens']),
    reasoningTokens: 0,
  }
}

export const anthropicProvider: Provider = {
  id: 'anthropic',
  label: 'Anthropic',
  supportsPromptCache: true,
  originPattern: () => 'https://api.anthropic.com/*',

  async complete(req, creds, signal) {
    const { system, messages } = splitSystem(req)
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      messages,
    }
    if (system.length > 0) body['system'] = system
    // `effort` vit dans `output_config`, pas au niveau racine.
    if (req.effort) body['output_config'] = { effort: req.effort }

    let res: Response
    try {
      res = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        signal,
        headers: {
          'x-api-key': creds.apiKey,
          'anthropic-version': API_VERSION,
          // Requis pour appeler l'API depuis un contexte navigateur. Le nom est un
          // avertissement légitime : voir la limite énoncée dans keystore.ts.
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (e) {
      if (signal.aborted) throw new LlmError('aborted', 'appel annulé')
      throw new LlmError('network', e instanceof Error ? e.message : String(e), {
        provider: 'anthropic',
      })
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const after = retryAfterMs(
        res.headers,
        Date.parse(res.headers.get('date') ?? '') || 0,
      )
      throw new LlmError(
        kindFromStatus(res.status, text),
        text.slice(0, 500) || `HTTP ${res.status}`,
        {
          status: res.status,
          provider: 'anthropic',
          model: req.model,
          ...(after !== undefined ? { retryAfterMs: after } : {}),
        },
      )
    }

    const json = (await res.json()) as Record<string, unknown>

    // `stop_reason: "refusal"` arrive en HTTP 200 : on doit le vérifier avant de lire le
    // contenu, sinon on traite un refus comme une réponse vide et on le réessaie en vain.
    if (json['stop_reason'] === 'refusal') {
      throw new LlmError('content-filter', 'le modèle a refusé de répondre', {
        provider: 'anthropic',
        model: req.model,
      })
    }

    // Même défaut, autre nom : Anthropic dit `max_tokens` là où OpenRouter dit `length`. Une
    // réponse coupée est un JSON illisible, et les confondre fait chercher le bug dans le
    // parseur au lieu du plafond de sortie (voir `errors.ts`, kind `truncated`).
    if (json['stop_reason'] === 'max_tokens') {
      throw new LlmError(
        'truncated',
        `réponse coupée à ${req.maxOutputTokens} tokens de sortie — relève le plafond du rôle ` +
          `« ${req.role} » ou réduis la taille du lot`,
        { provider: 'anthropic', model: req.model },
      )
    }

    const blocks = (json['content'] ?? []) as { type?: string; text?: string }[]
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')

    if (text === '') {
      throw new LlmError('invalid-json', 'réponse sans bloc de texte', {
        provider: 'anthropic',
        model: req.model,
      })
    }

    return {
      text,
      usage: { ...ZERO_USAGE, ...readUsage(json['usage']) },
      model: (json['model'] as string | undefined) ?? req.model,
    }
  },
}
