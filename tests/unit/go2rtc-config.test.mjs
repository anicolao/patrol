import assert from 'node:assert/strict';
import test from 'node:test';
import { renderConfig } from '../../scripts/write-go2rtc-config.mjs';

test('go2rtc config uses checkpoint stream names and the current camera address', () => {
  const config = renderConfig(
    [{
      id: 'camera-1',
      remoteAddress: '192.0.2.20',
      streams: { main: 'driveway_main', sub: 'driveway_sub' }
    }],
    new Map([['camera-1', {
      host: '192.0.2.10',
      username: 'camera user',
      password: 'camera password'
    }]])
  );

  assert.match(config, /driveway_main:/);
  assert.match(config, /192\.0\.2\.20:554\/Streaming\/Channels\/101/);
  assert.match(config, /driveway_sub:/);
  assert.doesNotMatch(config, /192\.0\.2\.10/);
});
