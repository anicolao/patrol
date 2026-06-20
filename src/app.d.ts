// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {}

  interface ImportMetaEnv {
    readonly VITE_PATROL_GIT_REVISION?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
