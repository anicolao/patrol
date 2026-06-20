import { execFileSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const patrolGitRevision = resolvePatrolGitRevision();

export default defineConfig({
  define: {
    'import.meta.env.VITE_PATROL_GIT_REVISION': JSON.stringify(patrolGitRevision)
  },
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

function resolvePatrolGitRevision() {
  if (process.env.VITE_PATROL_GIT_REVISION) {
    return process.env.VITE_PATROL_GIT_REVISION;
  }

  if (process.env.PATROL_GIT_REVISION) {
    return process.env.PATROL_GIT_REVISION;
  }

  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return 'unknown';
  }
}
