import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  finalizeStagedRecording,
  migrateLegacyRecording,
  parseFfmpegCompletedSegment,
  parseRecordingRelativePath,
  probeRecordingFile,
  recordingRelativePath,
  walkRecordingFiles
} from '../../scripts/lib/recording-files.mjs';

test('recording paths are sharded by UTC hour and parse legacy paths', () => {
  assert.equal(
    recordingRelativePath('driveway_main', 1_781_099_196_000),
    path.join('driveway_main', '2026', '06', '10', '13', '1781099196000.m4v')
  );
  assert.deepEqual(parseRecordingRelativePath('driveway_main/1781099196.mp4'), {
    streamName: 'driveway_main',
    startMs: 1_781_099_196_000,
    extension: 'mp4',
    legacy: true,
    relativePath: 'driveway_main/1781099196.mp4'
  });
  assert.deepEqual(
    parseRecordingRelativePath('driveway_main/2026/06/10/13/1781099196000.m4v'),
    {
      streamName: 'driveway_main',
      startMs: 1_781_099_196_000,
      extension: 'm4v',
      legacy: false,
      relativePath: 'driveway_main/2026/06/10/13/1781099196000.m4v'
    }
  );
  assert.equal(
    parseRecordingRelativePath('driveway_main/2026/06/10/12/1781099196.m4v'),
    null
  );
});

test('FFmpeg completion rows identify finalized segment timestamps', () => {
  assert.deepEqual(parseFfmpegCompletedSegment('123-000000001.m4v,12.500000,29.750000'), {
    fileName: '123-000000001.m4v',
    mediaDurationMs: 17_250
  });
  assert.deepEqual(
    parseFfmpegCompletedSegment('"/recordings/.staging/driveway_main/123-000000002.m4v",0.0,15.0'),
    { fileName: '123-000000002.m4v', mediaDurationMs: 15_000 }
  );
  assert.equal(parseFfmpegCompletedSegment('not-a-segment'), null);
});

test('recording probes report missing ffprobe without crashing the worker', async () => {
  await assert.rejects(
    probeRecordingFile('/tmp/missing-recording.m4v', { ffprobePath: '/definitely/missing/ffprobe' }),
    /Could not start ffprobe/
  );
});

test('legacy recordings migrate without overwriting and remain discoverable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'patrol-recordings-'));
  const legacy = path.join(root, 'driveway_main', '1781099196.mp4');
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, 'video');

  try {
    const migrated = await migrateLegacyRecording(root, 'driveway_main/1781099196.mp4');
    assert.equal(migrated, path.join('driveway_main', '2026', '06', '10', '13', '1781099196000.m4v'));
    assert.equal(await readFile(path.join(root, migrated), 'utf8'), 'video');
    const files = [];
    for await (const file of walkRecordingFiles(root, ['driveway_main'])) {
      files.push(file.relativePath);
    }
    assert.deepEqual(files, [migrated]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('staged recordings receive collision-free millisecond timestamps', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'patrol-recording-finalize-'));
  const stagingDir = path.join(root, '.staging', 'driveway_main');
  await mkdir(stagingDir, { recursive: true });
  const firstStaging = path.join(stagingDir, 'launch-000000000.m4v');
  const secondStaging = path.join(stagingDir, 'launch-000000001.m4v');
  await writeFile(firstStaging, 'first');
  await writeFile(secondStaging, 'second');

  try {
    const first = await finalizeStagedRecording(root, 'driveway_main', firstStaging, 1_781_099_196_123);
    const second = await finalizeStagedRecording(root, 'driveway_main', secondStaging, 1_781_099_196_123);
    assert.equal(first.relativePath, path.join('driveway_main', '2026', '06', '10', '13', '1781099196123.m4v'));
    assert.equal(second.relativePath, path.join('driveway_main', '2026', '06', '10', '13', '1781099196124.m4v'));
    assert.equal(await readFile(path.join(root, first.relativePath), 'utf8'), 'first');
    assert.equal(await readFile(path.join(root, second.relativePath), 'utf8'), 'second');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
