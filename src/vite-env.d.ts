/// <reference types="vite/client" />

/** Import de fichiers en texte brut — utilisé pour les prompts `.md` versionnés (MH-04). */
declare module '*.md?raw' {
  const content: string
  export default content
}
