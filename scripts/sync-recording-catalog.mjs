import path from 'node:path';
import { openRecordingCatalog, syncRecordingCatalogFromEvents } from '../src/lib/server/recording-catalog.ts';
import { patrolDataRoot } from './lib/patrol-paths.mjs';

const dataRoot = patrolDataRoot();
const catalog = await openRecordingCatalog(dataRoot);
try {
  const result = await syncRecordingCatalogFromEvents(catalog, path.join(dataRoot, 'events'));
  console.log(
    JSON.stringify({
      ...result,
      ...catalog.summary(),
      catalog: path.join(dataRoot, 'cache', 'recording-catalog.sqlite')
    })
  );
} finally {
  catalog.close();
}
