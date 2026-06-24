/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPTILER_KEY?: string
  readonly VITE_MAPTILER_STYLE?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
