import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rediscoverUnavailableCameras,
  unavailableGo2rtcStreams
} from '../../scripts/lib/camera-rediscovery.mjs';

test('camera rediscovery identifies configured streams without live producers', () => {
  assert.deepEqual(
    unavailableGo2rtcStreams({
      camera_b_sub: { producers: [{ url: 'rtsp://camera-b' }] },
      camera_a_main: { producers: [{ remote_addr: '192.0.2.10:554' }] },
      camera_b_main: { producers: [] }
    }),
    ['camera_b_main', 'camera_b_sub']
  );
});

test('camera rediscovery does not call discovery when every producer is live', async () => {
  const calls = [];
  const result = await rediscoverUnavailableCameras({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET' });
      return response({ camera_main: { producers: [{ remote_addr: '192.0.2.10:554' }] } });
    }
  });

  assert.deepEqual(result, { attempted: false, unavailableStreamNames: [] });
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:1984/api/streams', method: 'GET' }]);
});

test('camera rediscovery posts discovery when a producer is unavailable', async () => {
  const calls = [];
  const result = await rediscoverUnavailableCameras({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET' });
      return url.includes('/api/streams')
        ? response({ camera_main: { producers: [{ remote_addr: null }] } })
        : response({ state: { devices: [] } });
    }
  });

  assert.deepEqual(result, { attempted: true, unavailableStreamNames: ['camera_main'] });
  assert.deepEqual(calls, [
    { url: 'http://127.0.0.1:1984/api/streams', method: 'GET' },
    { url: 'http://127.0.0.1:5184/api/cameras/discover', method: 'POST' }
  ]);
});

test('camera rediscovery reports a failed discovery request', async () => {
  await assert.rejects(
    rediscoverUnavailableCameras({
      fetchImpl: async (url) => url.includes('/api/streams')
        ? response({ camera_main: { producers: [] } })
        : response({}, 503)
    }),
    /Camera discovery endpoint returned HTTP 503/
  );
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
