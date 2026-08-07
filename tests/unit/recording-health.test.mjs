import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceCameraDiscoveryEvents } from '../../src/lib/cameras/state-reducer.ts';

test('recording health is tracked independently for every configured stream', () => {
  const now = Date.now();
  const events = [
    cameraEvent('camera.discovery.completed', now - 10_000, {
      rawResult: {
        protocol: 'onvif-ws-discovery',
        startedAtMs: now - 10_100,
        durationMs: 100,
        responses: [{
          remoteAddress: '192.0.2.10',
          receivedAtMs: now - 10_000,
          body: '<Address>camera-1</Address><XAddrs>http://192.0.2.10/onvif</XAddrs><Scopes>onvif://www.onvif.org/name/Driveway</Scopes>'
        }],
        errors: []
      }
    }),
    cameraEvent('camera.credentials.saved', now - 9_000, {
      cameraId: 'camera-1',
      host: '192.0.2.10',
      secretIds: { username: 'user-secret', password: 'password-secret' },
      secretStoredAtMs: now - 9_000
    }),
    cameraEvent('recording.segment.observed', now - 2_000, {
      cameraId: 'camera-1',
      role: 'main',
      streamName: 'driveway_main',
      startMs: now - 18_000,
      durationMs: 16_000,
      sizeBytes: 1024,
      relativePath: 'driveway_main/2026/08/07/11/1786101617.m4v'
    }),
    cameraEvent('recording.stream.interrupted', now - 1_000, {
      cameraId: 'camera-1',
      role: 'main',
      streamName: 'driveway_main',
      interruptedAtMs: now - 1_000,
      exitCode: 1,
      signal: null,
      detail: 'upstream unavailable'
    })
  ];

  const interrupted = reduceCameraDiscoveryEvents(events);
  assert.equal(processHealth(interrupted, 'driveway_main'), 'error');
  assert.equal(processHealth(interrupted, 'driveway_sub'), 'missing');

  const recovered = reduceCameraDiscoveryEvents([
    ...events,
    cameraEvent('recording.stream.recovered', now, {
      cameraId: 'camera-1',
      role: 'main',
      streamName: 'driveway_main',
      recoveredAtMs: now
    })
  ]);
  assert.equal(processHealth(recovered, 'driveway_main'), 'ok');
});

function processHealth(state, streamName) {
  return state.processes.find((process) => process.id === `patrol-recorder-stream:${streamName}`)?.health;
}

function cameraEvent(type, ts_ms, payload) {
  return { id: `${type}-${ts_ms}`, schema: 1, type, ts_ms, source: 'test', payload };
}
