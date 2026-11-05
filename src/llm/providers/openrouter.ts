/**
 * Provider OpenRouter — provider par défaut (décision D-04 / D-02).
 *
 * Un seul jeu de clés, arbitrage libre de modèle par agent, et un catalogue de prix
 * interrogeable — c'est ce qui rend `pricing.ts` synchronisable au lieu de codé en dur.
 *
 * Point à valider en Phase 0 (FEEDBACK R-03) : la propagation de `cache_control` vers
 * Anthropic. Tout le chiffrage à 1 €/jour en dépend. On envoie les marqueurs de cache et
 * on lit ce que le provider rapporte ; si `cacheReadTokens` reste à zéro sur des appels
 * répétés à préfixe identique, le cache ne passe pas et le routage doit basculer WRITER
 * et CRITIC sur Anthropic en direct.
 */
import { LlmError, kindFromStatus, retryAfterMs } from '../errors'
import { ZERO_USAGE, type LlmRequest, type Provider, type TokenUsage } from '../types'

const BASE_URL = 'https://openrouter.ai/api/v1'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content:
    string | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]
}

/** Traduit les messages internes vers le format OpenAI-chat, marqueurs de cache inclus. */
function toChatMessages(req: LlmRequest): ChatMessage[] {
  return req.messages.map((m) =>
    m.cacheable
      ? {
          role: m.role,
          content: [
            {
              type: 'text' as const,
              text: m.content,
              cache_control: { type: 'ephemeral' as const },
            },
          ],
        }
      : { role: m.role, content: m.content },
  )
}

/**
 * OpenRouter expose l'usage sous plusieurs formes selon le modèle amont. On lit
 * défensivement : un champ absent vaut zéro, jamais `NaN`, sinon le compteur de budget
 * propagerait un `NaN` et deviendrait inexploitable sans qu'on sache pourquoi.
 *
 * ## Le piège de comptabilité, et il coûtait dix fois le prix
 *
 * Les deux API ne comptent pas pareil, et la différence est invisible jusqu'à ce qu'on mesure :
 *
 *  - **Anthropic en direct** : `input_tokens` **exclut** les tokens lus depuis le cache, qui
 *    sont rapportés à part dans `cache_read_input_tokens`.
 *  - **OpenRouter** : `prompt_tokens` est le **total du prompt, tokens cachés inclus**, et
 *    `prompt_tokens_details.cached_tokens` en est un sous-ensemble.
 *
 * `computeCostEur` facture `inputTokens` au plein tarif et `cacheReadTokens` à 10 %. Avec la
 * convention d'OpenRouter prise au pied de la lettre, un appel dont 3 135 tokens sur 3 150 sont
 * cachés était facturé ~0,0096 € au lieu de ~0,0010 € : **le cache de prompt, qui est censé
 * diviser le coût par dix, faisait grimper la facture estimée d'un facteur dix.** Conséquence
 * réelle : le plafond quotidien coupait bien trop tôt — le produit s'arrêtait en croyant avoir
 * dépensé son euro.
 *
 * On soustrait donc les tokens cachés pour retrouver la convention d'Anthropic, qui est celle
 * que le calcul de coût attend. Mesuré le 2026-08-26 en confirmant R-03 ; c'est la mesure qui a
 * révélé le défaut, aucune relecture ne l'avait vu.
 */
function readUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0
  const details = (u['prompt_tokens_details'] ?? {}) as Record<string, unknown>
  const outDetails = (u['completion_tokens_details'] ?? {}) as Record<string, unknown>

  const promptTotal = num(u['prompt_tokens'])
  const cacheRead = num(details['cached_tokens']) || num(u['cache_read_input_tokens'])

  return {
    // `Math.max(0, …)` : si un modèle amont rapportait les deux selon la convention
    // d'Anthropic, la soustraction donnerait un négatif, et un token négatif ferait *baisser*
    // le compteur de budget — une fuite silencieuse du plafond, pire qu'une surestimation.
    inputTokens: Math.max(0, promptTotal - cacheRead),
    outputTokens: num(u['completion_tokens']),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: num(u['cache_creation_input_tokens']),
    reasoningTokens: num(outDetails['reasoning_tokens']),
  }
}

/**
 * Exporté pour le test : la comptabilité d'usage est la seule partie de ce module dont une
 * erreur est invisible — elle ne casse rien, elle fausse le budget.
 */
export const __readUsageForTest = readUsage

const EFFORT_MAP = { low: 'low', medium: 'medium', high: 'high' } as const

export const openRouterProvider: Provider = {
  id: 'openrouter',
  label: 'OpenRouter',
  supportsPromptCache: true, // à confirmer empiriquement — FEEDBACK R-03.
  originPattern: () => 'https://openrouter.ai/*',

  async complete(req, creds, signal) {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toChatMessages(req),
      max_tokens: req.maxOutputTokens,
      // Demande explicite de la comptabilité d'usage : sans ça, certains modèles amont
      // ne la renvoient pas, et le compteur de budget serait aveugle (SPEC §3.2 règle 2).
      usage: { include: true },
    }
    if (req.effort) body['reasoning'] = { effort: EFFORT_MAP[req.effort] }
    if (req.jsonSchema) body['response_format'] = { type: 'json_object' }

    let res: Response
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          // La clé va dans l'en-tête, jamais dans l'URL (SPEC §3.1).
          Authorization: `Bearer ${creds.apiKey}`,
          'Content-Type': 'application/json',
          // OpenRouter les utilise pour l'attribution ; aucune donnée utilisateur dedans.
          'HTTP-Referer': 'https://github.com/swarm-extension',
          'X-Title': 'SWARM',
        },
        body: JSON.stringify(body),
      })
    } catch (e) {
      if (signal.aborted) throw new LlmError('aborted', 'appel annulé')
      throw new LlmError('network', e instanceof Error ? e.message : String(e), {
        provider: 'openrouter',
      })
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const kind = kindFromStatus(res.status, text)
      const after = retryAfterMs(
        res.headers,
        Date.parse(res.headers.get('date') ?? '') || 0,
      )
      throw new LlmError(kind, text.slice(0, 500) || `HTTP ${res.status}`, {
        status: res.status,
        provider: 'openrouter',
        model: req.model,
        ...(after !== undefined ? { retryAfterMs: after } : {}),
      })
    }

    const json = (await res.json()) as Record<string, unknown>
    const choices = json['choices'] as
      | { message?: { content?: string }; finish_reason?: string }[]
      | undefined
    const text = choices?.[0]?.message?.content ?? ''
    const finishReason = choices?.[0]?.finish_reason

    // Coupé par `max_tokens` : le JSON s'arrête au milieu d'un objet. Sans ce contrôle,
    // l'erreur remontait en « réponse illisible malgré réparation », ce qui envoie chercher le
    // bug dans le parseur au lieu du plafond de sortie (voir `errors.ts`, kind `truncated`).
    if (finishReason === 'length') {
      throw new LlmError(
        'truncated',
        `réponse coupée à ${req.maxOutputTokens} tokens de sortie — relève le plafond du rôle ` +
          `« ${req.role} » ou réduis la taille du lot`,
        { provider: 'openrouter', model: req.model },
      )
    }

    if (text === '') {
      // Une réponse vide sur un HTTP 200 est le cas le plus insidieux : le pipeline
      // continuerait avec une chaîne vide et le CRITIC rejetterait sans qu'on comprenne.
      throw new LlmError('invalid-json', 'réponse vide du modèle', {
        provider: 'openrouter',
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
