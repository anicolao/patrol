import path from 'node:path';

export function patrolDataRoot() {
  return process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
}

export function patrolRecordingsDir(dataRoot = patrolDataRoot()) {
  return process.env.PATROL_RECORDINGS_DIR ?? path.join(dataRoot, 'recordings');
}
