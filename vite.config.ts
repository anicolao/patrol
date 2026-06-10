import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    allowedHosts: [
      'emriss-mac-mini.amberwood',
      'Emriss-mac-mini.amberwood',
      'Emriss-Mac-mini.amberwood',
      '10.20.240.94'
    ]
  }
});
