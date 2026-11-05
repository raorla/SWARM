/**
 * Endpoint OpenAI-compatible — Ollama, LM Studio, vLLM, ou toute passerelle maison.
 *
 * Intérêt réel pour SWARM : c'est la seule configuration où **rien** ne quitte la
 * machine. Le triage de masse y est particulièrement adapté, puisqu'il n'a pas besoin
 * d'un modèle fort et représente le plus gros volume de tokens.
 */
import { LlmError, kindFromStatus } from '../errors'
import { ZERO_USAGE, type Provider, type TokenUsage } from '../types'

function readUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0
  return {
    inputTokens: num(u['prompt_tokens']),
    outputTokens: num(u['completion_tokens']),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
}

export const openAiCompatibleProvider: Provider = {
  id: 'openai-compatible',
  label: 'Endpoint local (Ollama / LM Studio)',
  // Les serveurs locaux n'implémentent pas le cache de prompt. Le déclarer faux évite
  // au routeur de compter sur une réduction de coût qui n'aura pas lieu.
  supportsPromptCache: false,

  originPattern: (creds) => {
    // On dérive le motif de permission de l'URL fournie : demander `http://localhost/*`
    // en dur ne couvrirait pas un serveur sur une autre machine du réseau local.
    try {
      const u = new URL(creds.baseUrl ?? 'http://localhost:11434')
      return `${u.protocol}//${u.host}/*`
    } catch {
      return 'http://localhost/*'
    }
  },

  async complete(req, creds, signal) {
    const base = (creds.baseUrl ?? 'http://localhost:11434/v1').replace(/\/+$/, '')

    let res: Response
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          // Beaucoup de serveurs locaux n'exigent pas de clé ; on n'envoie l'en-tête que
          // si l'utilisateur en a fourni une.
          ...(creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: req.maxOutputTokens,
          ...(req.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
        }),
      })
    } catch {
      if (signal.aborted) throw new LlmError('aborted', 'appel annulé')
      // Cause la plus fréquente : le serveur local n'est pas lancé. Le message le dit,
      // plutôt que de renvoyer un « failed to fetch » qui n'aide personne.
      throw new LlmError(
        'network',
        `endpoint local injoignable (${base}) — le serveur est-il démarré ?`,
        { provider: 'openai-compatible' },
      )
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new LlmError(
        kindFromStatus(res.status, text),
        text.slice(0, 500) || `HTTP ${res.status}`,
        {
          status: res.status,
          provider: 'openai-compatible',
          model: req.model,
        },
      )
    }

    const json = (await res.json()) as Record<string, unknown>
    const choices = json['choices'] as { message?: { content?: string } }[] | undefined
    const text = choices?.[0]?.message?.content ?? ''
    if (text === '') {
      throw new LlmError('invalid-json', 'réponse vide du modèle local', {
        provider: 'openai-compatible',
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
