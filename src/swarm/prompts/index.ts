/**
 * Registre des prompts, avec hachage de version — FEEDBACK MH-04.
 *
 * Les prompts vivent dans des `.md` versionnés en Git, pas dans des littéraux TypeScript
 * (SPEC §8). Deux raisons pratiques : ils se relisent et se diffusent comme du texte, et un
 * changement de prompt apparaît dans l'historique comme le changement de comportement
 * produit qu'il est.
 *
 * Le hash est ce qui rend la boucle d'apprentissage honnête. Sans lui, une performance
 * mesurée à J+7 serait attribuée au prompt actuel, pas à celui qui l'a produite — et le
 * système conclurait avec assurance des choses fausses. C'est le seul champ de tout le
 * modèle de données dont l'absence rendrait le différenciateur n°2 mensonger.
 */
import guardrailsRaw from './_shared/guardrails.md?raw'
import quickReplyRaw from './quick-reply.md?raw'
import writerRaw from './writer.md?raw'
import criticRaw from './critic.md?raw'
import qualifierRaw from './qualifier.md?raw'
import type { AgentRole } from '@/llm/types'

/** Rôles ayant un prompt. `selftest` n'en a pas : il n'a rien à apprendre. */
export type PromptId =
  'quick-reply' | 'qualifier' | 'strategist' | 'writer' | 'critic' | 'analyst'

export interface PromptTemplate {
  id: PromptId
  /** Contenu assemblé : fragments partagés + corps propre à l'agent. */
  content: string
  /** SHA-256 du contenu assemblé, tronqué à 16 caractères hexadécimaux. */
  hash: string
}

/** Fragments inclus dans tous les prompts de rédaction. */
export const SHARED_GUARDRAILS = guardrailsRaw

const SOURCES: Partial<Record<PromptId, { body: string; withGuardrails: boolean }>> = {
  'quick-reply': { body: quickReplyRaw, withGuardrails: true },
  writer: { body: writerRaw, withGuardrails: true },
  // Le CRITIC reçoit les garde-fous parce qu'il doit reconnaître ce qu'ils interdisent :
  // c'est lui qui rattrape une variante qui les frôle sans les nommer.
  critic: { body: criticRaw, withGuardrails: true },
  // Le QUALIFIER reçoit les garde-fous parce qu'il doit reconnaître les sujets interdits
  // pour les noter à zéro — c'est le premier filtre, avant toute dépense de rédaction.
  qualifier: { body: qualifierRaw, withGuardrails: true },
}

async function sha256Short(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Assemblage puis hachage.
 *
 * Le hash porte sur le contenu **assemblé**, pas sur le seul corps de l'agent : modifier
 * les garde-fous partagés change le comportement de tous les agents, et le tracer sur
 * chacun est exactement le but.
 */
function assemble(id: PromptId): string {
  const source = SOURCES[id]
  if (!source) {
    throw new Error(
      `Prompt « ${id} » non enregistré. Ajoute son .md et son entrée dans SOURCES — ` +
        'un prompt manquant ne doit pas se dégrader en chaîne vide.',
    )
  }
  return source.withGuardrails
    ? `${source.body}\n\n---\n\n${SHARED_GUARDRAILS}`
    : source.body
}

const cache = new Map<PromptId, PromptTemplate>()

/** Charge un prompt et calcule son hash. Résultat mémorisé : le contenu est immuable. */
export async function loadPrompt(id: PromptId): Promise<PromptTemplate> {
  const cached = cache.get(id)
  if (cached) return cached
  const content = assemble(id)
  const template: PromptTemplate = { id, content, hash: await sha256Short(content) }
  cache.set(id, template)
  return template
}

/** Prompts effectivement disponibles. Les autres arrivent avec leur phase. */
export function availablePrompts(): readonly PromptId[] {
  return Object.keys(SOURCES) as PromptId[]
}

/**
 * Hash combiné d'une chaîne d'agents, tel que stocké dans `actions.promptVersionHash`.
 * Trié pour être stable : l'ordre d'appel des agents ne doit pas changer l'identité de la
 * combinaison, sinon deux actions identiques paraîtraient produites différemment.
 */
export async function combinedHash(
  parts: readonly { role: AgentRole; hash: string }[],
): Promise<string> {
  const joined = [...parts]
    .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0))
    .map((p) => `${p.role}:${p.hash}`)
    .join('|')
  return sha256Short(joined)
}

/** Vidage du cache — tests uniquement. */
export function resetPromptCache(): void {
  cache.clear()
}
