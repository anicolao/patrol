import assert from 'node:assert/strict';
import test from 'node:test';
import { recordingFfmpegArgs } from '../../scripts/lib/recorder-ffmpeg.mjs';

test('recorder writes plain finalized MP4 segments without fast-start rewrites', () => {
  const args = recordingFfmpegArgs({
    streamUrl: 'rtsp://127.0.0.1:8554/driveway_main',
    segmentSeconds: 60,
    outputPattern: '/recordings/.staging/driveway_main/%09d.m4v'
  });

  assert.equal(args.includes('-segment_format_options'), false);
  assert.equal(args.some((argument) => argument.includes('faststart')), false);
  assert.deepEqual(args.slice(-3), ['-reset_timestamps', '1', '/recordings/.staging/driveway_main/%09d.m4v']);
});
