import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  resolveThumbnailPath,
  thumbnailAbsolutePath,
  thumbnailRelativePath
} from '../../src/lib/server/recording-thumbnails.ts';

test('thumbnail paths are deterministic and sharded by segment start hour', () => {
  assert.equal(
    thumbnailRelativePath('driveway_main/1781099196.mp4'),
    path.join('driveway_main', '2026', '06', '10', '13', '1781099196.jpg')
  );
  assert.equal(
    thumbnailAbsolutePath('/var/tmp/patrol-thumbnails', 'driveway_main/1781099196.mp4'),
    path.join('/var/tmp/patrol-thumbnails', 'driveway_main', '2026', '06', '10', '13', '1781099196.jpg')
  );
  assert.equal(
    thumbnailRelativePath('driveway_main/2026/06/10/13/1781099196000.m4v'),
    path.join('driveway_main', '2026', '06', '10', '13', '1781099196000.jpg')
  );
});

test('thumbnail paths reject arbitrary files and directory traversal', () => {
  assert.throws(() => thumbnailRelativePath('../secrets/1781099196.mp4'), /Invalid recording segment path/);
  assert.throws(() => thumbnailRelativePath('driveway_main/latest.mp4'), /Invalid recording segment path/);
  assert.throws(
    () => thumbnailRelativePath('driveway_main/2026/06/10/12/1781099196.m4v'),
    /does not match its timestamp/
  );
  assert.throws(
    () => resolveThumbnailPath('/var/tmp/patrol-thumbnails', '../outside.jpg'),
    /escapes the thumbnail directory/
  );
});
