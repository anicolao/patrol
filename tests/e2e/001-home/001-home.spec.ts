import { expect, test } from '@playwright/test';
import type { CameraDiscoveryState, DiscoveredCamera } from '../../../src/lib/cameras/discovery';
import { TestStepHelper } from '../helpers/test-step-helper';

test('frontend serves Patrol camera discovery', async ({ page }, testInfo) => {
  const fixedNowMs = 1781099200000;
  const emptyDiscoveryState: CameraDiscoveryState = {
    staleAfterMs: 60 * 60 * 1000,
    devices: [],
    errors: [],
    lastDiscovery: null
  };
  const discoveredCameraState = ({
    credentials,
    go2rtc
  }: {
    credentials: DiscoveredCamera['credentials'];
    go2rtc?: DiscoveredCamera['go2rtc'];
  }): CameraDiscoveryState => ({
    staleAfterMs: 60 * 60 * 1000,
    errors: [],
    lastDiscovery: {
      runId: 'discovery-run-1',
      protocol: 'onvif-ws-discovery',
      startedAtMs: fixedNowMs - 120042,
      durationMs: 42,
      completedAtMs: fixedNowMs - 120000
    },
    devices: [
      {
        id: 'uuid:driveway-camera',
        endpoint: 'uuid:driveway-camera',
        remoteAddress: '10.20.240.193',
        lastSeenAtMs: fixedNowMs - 90000,
        xaddrs: ['http://10.20.240.193/onvif/device_service'],
        setupUrl: 'http://10.20.240.193',
        scopes: [
          'onvif://www.onvif.org/name/driveway',
          'onvif://www.onvif.org/hardware/Annke%20C800'
        ],
        types: ['dn:NetworkVideoTransmitter'],
        name: 'driveway',
        hardware: 'Annke C800',
        location: null,
        vendorHint: 'annke',
        streams: {
          main: 'driveway_main',
          sub: 'driveway_sub'
        },
        credentials,
        go2rtc: go2rtc ?? null
      }
    ]
  });
  let discoveryState = emptyDiscoveryState;
  const tester = new TestStepHelper(
    page,
    testInfo
  );
  tester.setMetadata('Patrol Camera Discovery', 'The SvelteKit frontend serves camera discovery.');

  await page.clock.install({ time: fixedNowMs });

  await page.route('**/api/cameras/discover', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(discoveryState)
      });
      return;
    }

    discoveryState = discoveredCameraState({ credentials: null });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(discoveryState)
    });
  });
  let credentialRequest: unknown = null;
  await page.route('**/api/cameras/credentials', async (route) => {
    credentialRequest = route.request().postDataJSON();
    discoveryState = discoveredCameraState({
      credentials: {
        savedAtMs: fixedNowMs - 30000,
        usernameSecretId: 'camera.uuid:driveway-camera.username',
        passwordSecretId: 'camera.uuid:driveway-camera.password'
      },
      go2rtc: configuredGo2rtc(fixedNowMs - 20000)
    });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(discoveryState)
    });
  });
  await page.route('**/api/go2rtc/observe', async (route) => {
    discoveryState = discoveredCameraState({
      credentials: {
        savedAtMs: fixedNowMs - 30000,
        usernameSecretId: 'camera.uuid:driveway-camera.username',
        passwordSecretId: 'camera.uuid:driveway-camera.password'
      },
      go2rtc: observedGo2rtc(fixedNowMs - 5000)
    });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(discoveryState)
    });
  });
  await page.route('http://localhost:1984/stream.html**', async (route) => {
    const url = new URL(route.request().url());
    const streamName = url.searchParams.get('src') ?? 'unknown';
    await route.fulfill({
      contentType: 'text/html',
      body: go2rtcViewer(streamName)
    });
  });

  await page.goto('/');

  await tester.step('home-page', {
    description: 'Patrol camera discovery panel is visible',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Document title is Patrol',
        check: async () => {
          await expect(page).toHaveTitle('Patrol');
        }
      },
      {
        spec: 'Patrol heading is visible',
        check: async () => {
          await expect(page.getByRole('heading', { name: 'Patrol' })).toBeVisible();
        }
      },
      {
        spec: 'Discovery button is visible',
        check: async () => {
          await expect(page.getByTestId('discover-cameras')).toBeVisible();
          await expect(page.getByTestId('discover-cameras')).toBeEnabled();
        }
      },
      {
        spec: 'go2rtc observation button is available',
        check: async () => {
          await expect(page.getByTestId('observe-go2rtc')).toBeVisible();
          await expect(page.getByTestId('observe-go2rtc')).toBeEnabled();
        }
      },
      {
        spec: 'Discovery event log path is shown',
        check: async () => {
          await expect(page.getByText('.patrol/events/cameras-YYYY-MM-DD.jsonl')).toBeVisible();
        }
      }
    ]
  });

  await page.getByTestId('discover-cameras').click();

  await tester.step('discovered-camera', {
    description: 'Discovered camera is rendered',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Camera count is shown',
        check: async () => {
          await expect(page.getByText('1 camera found')).toBeVisible();
        }
      },
      {
        spec: 'Driveway camera name is shown',
        check: async () => {
          await expect(page.getByRole('heading', { name: 'driveway' })).toBeVisible();
        }
      },
      {
        spec: 'Camera address is shown',
        check: async () => {
          await expect(page.getByText('10.20.240.193', { exact: true })).toBeVisible();
        }
      },
      {
        spec: 'Discovery age is shown',
        check: async () => {
          await expect(page.getByText('Last discovery 2 minutes ago')).toBeVisible();
          await expect(page.getByText('Discovered 1 minute ago')).toBeVisible();
        }
      },
      {
        spec: 'First-time setup link opens camera web UI',
        check: async () => {
          await expect(page.getByRole('link', { name: 'Open camera setup' })).toHaveAttribute(
            'href',
            'http://10.20.240.193'
          );
        }
      }
    ]
  });

  await page.getByLabel('Username for driveway').fill('admin');
  await page.getByLabel('Password for driveway').fill('camera-password');
  await page.getByRole('button', { name: 'Save credentials' }).click();

  await tester.step('credentials-saved', {
    description: 'Camera credentials are accepted',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Credentials save status is shown',
        check: async () => {
          await expect(page.getByText('Credentials saved to event logs.')).toBeVisible();
          await expect(page.getByText('Credentials saved 30 seconds ago.')).toBeVisible();
        }
      },
      {
        spec: 'Credentialed camera preview is shown through go2rtc',
        check: async () => {
          await expect(page.getByTestId('camera-preview-link')).toHaveAttribute(
            'href',
            '/cameras/uuid%3Adriveway-camera'
          );
          await expect(page.getByTestId('camera-preview-frame')).toHaveAttribute(
            'src',
            /http:\/\/localhost:1984\/stream\.html\?.*src=driveway_sub/
          );
        }
      },
      {
        spec: 'go2rtc configuration is replayed from events',
        check: async () => {
          await expect(page.getByText('go2rtc configured')).toBeVisible();
          await expect(page.getByText('Main configured: 0 producers, 0 consumers')).toBeVisible();
          await expect(page.getByText('Sub configured: 0 producers, 0 consumers')).toBeVisible();
        }
      },
      {
        spec: 'Credential request includes camera identity and credentials',
        check: async () => {
          expect(credentialRequest).toMatchObject({
            cameraId: 'uuid:driveway-camera',
            host: '10.20.240.193',
            username: 'admin',
            password: 'camera-password'
          });
        }
      }
    ]
  });

  await page.getByTestId('observe-go2rtc').click();
  await tester.step('go2rtc-observed', {
    description: 'go2rtc stream status is reduced from observed events',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Camera streaming health is shown',
        check: async () => {
          await expect(page.getByText('go2rtc streaming · observed 5 seconds ago')).toBeVisible();
        }
      },
      {
        spec: 'Per-stream producer and consumer counts are shown',
        check: async () => {
          await expect(page.getByText('Main ready: 1 producer, 0 consumers')).toBeVisible();
          await expect(page.getByText('Sub streaming: 1 producer, 1 consumer')).toBeVisible();
        }
      }
    ]
  });

  await page.getByTestId('camera-preview-link').click();
  await tester.step('live-view', {
    description: 'High-resolution live camera view is shown',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Live camera route opens from the preview card',
        check: async () => {
          await expect(page).toHaveURL(/\/cameras\/uuid%3Adriveway-camera$/);
          await expect(page.getByRole('heading', { name: 'driveway' })).toBeVisible();
        }
      },
      {
        spec: 'Live stream iframe uses the high-resolution go2rtc stream',
        check: async () => {
          await expect(page.getByTestId('live-camera-stream')).toHaveAttribute(
            'src',
            /http:\/\/localhost:1984\/stream\.html\?.*src=driveway_main/
          );
        }
      }
    ]
  });

  await page.clock.fastForward(60 * 1000);
  await page.getByRole('link', { name: 'Back to cameras' }).click();
  await tester.step('refreshed-times', {
    description: 'Timestamp labels refresh without reload',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Last discovery age advances after one minute',
        check: async () => {
          await expect(page.getByText('Last discovery 3 minutes ago')).toBeVisible();
        }
      },
      {
        spec: 'Camera discovery age advances after one minute',
        check: async () => {
          await expect(page.getByText('Discovered 2 minutes ago')).toBeVisible();
        }
      },
      {
        spec: 'go2rtc observed age advances after one minute',
        check: async () => {
          await expect(page.getByText('go2rtc streaming · observed 1 minute ago')).toBeVisible();
        }
      },
      {
        spec: 'Credential saved age advances after one minute',
        check: async () => {
          await expect(page.getByText('Credentials saved 1 minute ago.')).toBeVisible();
        }
      }
    ]
  });

  tester.generateDocs();
});

function go2rtcViewer(streamName: string) {
  return `
    <!doctype html>
    <html>
      <body style="margin:0;background:#111827;color:#f8fafc;font-family:Arial,sans-serif;display:grid;place-items:center;height:100vh;">
        <main style="text-align:center;border:4px solid #93c5fd;width:calc(100% - 56px);height:calc(100% - 56px);display:grid;place-items:center;">
          <div>
            <div style="font-size:34px;">go2rtc</div>
            <div style="font-size:18px;color:#bfdbfe;">${streamName}</div>
          </div>
        </main>
      </body>
    </html>
  `;
}

function configuredGo2rtc(configuredAtMs: number): DiscoveredCamera['go2rtc'] {
  return {
    configuredAtMs,
    observedAtMs: null,
    apiReachable: null,
    apiBaseUrl: 'http://127.0.0.1:1984',
    health: 'configured',
    streams: {
      main: {
        streamName: 'driveway_main',
        configured: true,
        observed: false,
        producerCount: 0,
        consumerCount: 0,
        health: 'configured'
      },
      sub: {
        streamName: 'driveway_sub',
        configured: true,
        observed: false,
        producerCount: 0,
        consumerCount: 0,
        health: 'configured'
      }
    }
  };
}

function observedGo2rtc(observedAtMs: number): DiscoveredCamera['go2rtc'] {
  return {
    configuredAtMs: observedAtMs - 15000,
    observedAtMs,
    apiReachable: true,
    apiBaseUrl: 'http://127.0.0.1:1984',
    health: 'streaming',
    streams: {
      main: {
        streamName: 'driveway_main',
        configured: true,
        observed: true,
        producerCount: 1,
        consumerCount: 0,
        health: 'ready'
      },
      sub: {
        streamName: 'driveway_sub',
        configured: true,
        observed: true,
        producerCount: 1,
        consumerCount: 1,
        health: 'streaming'
      }
    }
  };
}
