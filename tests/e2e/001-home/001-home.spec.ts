import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { CameraDiscoveryState, DiscoveredCamera } from '../../../src/lib/cameras/discovery';
import { TestStepHelper } from '../helpers/test-step-helper';

test('frontend serves Patrol camera discovery', async ({ page }, testInfo) => {
  const fixedNowMs = 1781099200000;
  const emptyDiscoveryState: CameraDiscoveryState = {
    staleAfterMs: 60 * 60 * 1000,
    processes: systemProcesses(fixedNowMs - 15000),
    devices: [],
    recordings: emptyRecordings(),
    errors: [],
    lastDiscovery: null
  };
  const discoveredCameraState = ({
    credentials,
    go2rtc,
    annke
  }: {
    credentials: DiscoveredCamera['credentials'];
    go2rtc?: DiscoveredCamera['go2rtc'];
    annke?: DiscoveredCamera['annke'];
  }): CameraDiscoveryState => ({
    staleAfterMs: 60 * 60 * 1000,
    processes: systemProcesses(fixedNowMs - 15000),
    recordings: annke ? recordingState(fixedNowMs - 4000) : emptyRecordings(),
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
        go2rtc: go2rtc ?? null,
        annke: annke ?? null
      }
    ]
  });
  let discoveryState = emptyDiscoveryState;
  const tester = new TestStepHelper(
    page,
    testInfo
  );
  tester.setMetadata('Patrol Camera View', 'The SvelteKit frontend serves tabbed camera operations.');

  await page.clock.install({ time: fixedNowMs });
  await page.addInitScript((eventTsMs) => {
    class PatrolWebSocketMock extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readonly url: string;
      readyState = PatrolWebSocketMock.CONNECTING;

      constructor(url: string) {
        super();
        this.url = url;
        window.setTimeout(() => {
          this.readyState = PatrolWebSocketMock.OPEN;
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'patrol.event_stream.connected',
                ts_ms: eventTsMs,
                streams: ['cameras']
              })
            })
          );
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'patrol.event.appended',
                stream: 'cameras',
                file: 'cameras-2026-06-10.jsonl',
                event: {
                  id: 'live-event-1',
                  ts_ms: eventTsMs,
                  schema: 1,
                  type: 'annke.alert_stream.message_received',
                  source: 'patrol-annke-events',
                  payload: {
                    cameraId: 'uuid:driveway-camera',
                    rawXml:
                      '<EventNotificationAlert><eventType>VMD</eventType><eventState>active</eventState><targetType>vehicle</targetType></EventNotificationAlert>'
                  }
                }
              })
            })
          );
        }, 0);
      }

      send() {}

      close() {
        this.readyState = PatrolWebSocketMock.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      value: PatrolWebSocketMock
    });
  }, fixedNowMs);

  await page.route('**/api/state', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(discoveryState)
    });
  });
  await page.route('**/api/cameras/discover', async (route) => {
    discoveryState = discoveredCameraState({ credentials: null });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(discoveryState)
    });
  });
  await page.route('**/api/system/heartbeat**', async (route) => {
    discoveryState = {
      ...discoveryState,
      processes: systemProcesses(fixedNowMs - 5000)
    };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        stream: 'system',
        event: {
          id: 'heartbeat-1',
          ts_ms: fixedNowMs - 5000,
          schema: 1,
          type: 'system.process.heartbeat',
          source: 'patrol-web',
          payload: {
            processId: 'patrol-web',
            label: 'Patrol web/API server',
            kind: 'server',
            pid: 123,
            host: null,
            detail: 'SvelteKit API heartbeat route responded'
          }
        }
      })
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
  await page.route('**/api/annke/observe', async (route) => {
    discoveryState = discoveredCameraState({
      credentials: {
        savedAtMs: fixedNowMs - 30000,
        usernameSecretId: 'camera.uuid:driveway-camera.username',
        passwordSecretId: 'camera.uuid:driveway-camera.password'
      },
      go2rtc: observedGo2rtc(fixedNowMs - 5000),
      annke: observedAnnkeAi(fixedNowMs - 4000)
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
    description: 'Patrol camera view is visible',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Document title is Patrol',
        check: async () => {
          await expect(page).toHaveTitle('Patrol');
        }
      },
      {
        spec: 'Cameras heading is visible',
        check: async () => {
          await expect(page.getByRole('heading', { name: 'Cameras', exact: true })).toBeVisible();
        }
      },
      {
        spec: 'Empty camera state points to settings',
        check: async () => {
          await expect(page.getByText('No configured cameras')).toBeVisible();
          await expect(page.getByRole('button', { name: 'Open Settings' })).toBeVisible();
          await expect(page.getByRole('button', { name: 'Open Settings' })).toBeEnabled();
        }
      },
      {
        spec: 'Bottom tab buttons are available',
        check: async () => {
          await expect(page.getByTestId('tab-cameras')).toHaveAttribute('aria-current', 'page');
          await expect(page.getByTestId('tab-settings')).toBeVisible();
          await expect(page.getByTestId('tab-settings')).toBeEnabled();
          await expect(page.getByTestId('tab-history')).toBeVisible();
          await expect(page.getByTestId('tab-history')).toBeEnabled();
          await expect(page.getByTestId('tab-health')).toBeVisible();
          await expect(page.getByTestId('tab-health')).toBeEnabled();
        }
      }
    ]
  });

  await page.getByTestId('tab-settings').click();
  await tester.step('settings-tab', {
    description: 'Discovery and configuration controls are in settings',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Settings tab is selected',
        check: async () => {
          await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
          await expect(page.getByTestId('tab-settings')).toHaveAttribute('aria-current', 'page');
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

  await page.getByTestId('tab-cameras').click();
  await tester.step('camera-grid', {
    description: 'Configured cameras show substream previews',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Cameras tab is selected',
        check: async () => {
          await expect(page.getByRole('heading', { name: 'Cameras', exact: true })).toBeVisible();
          await expect(page.getByTestId('tab-cameras')).toHaveAttribute('aria-current', 'page');
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
      }
    ]
  });

  await page.getByTestId('tab-health').click();
  await tester.step('health-tab-configured', {
    description: 'go2rtc configuration status is in system health',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Health tab is selected',
        check: async () => {
          await expect(page.getByRole('heading', { name: 'System Health' })).toBeVisible();
          await expect(page.getByTestId('tab-health')).toHaveAttribute('aria-current', 'page');
        }
      },
      {
        spec: 'Server task dashboard is green',
        check: async () => {
          await expect(page.getByTestId('process-dashboard')).toBeVisible();
          await expect(page.getByTestId('process-score')).toHaveText('6/6 green');
          await expect(page.getByText('All server tasks are green.')).toBeVisible();
        }
      },
      {
        spec: 'All server tasks show last alive times',
        check: async () => {
          await expect(page.getByText('Patrol web/API server')).toBeVisible();
          await expect(page.getByText('Event WebSocket server')).toBeVisible();
          await expect(page.getByText('go2rtc stream server')).toBeVisible();
          await expect(page.getByText('Annke alert worker')).toBeVisible();
          await expect(page.getByText('Watchdog cron')).toBeVisible();
          await expect(page.getByText('Recording worker')).toBeVisible();
          await expect(page.getByTestId('process-row')).toHaveCount(6);
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
        spec: 'Annke AI observation button is available',
        check: async () => {
          await expect(page.getByTestId('observe-annke-ai')).toBeVisible();
          await expect(page.getByTestId('observe-annke-ai')).toBeEnabled();
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
        spec: 'Live event websocket is connected',
        check: async () => {
          await expect(page.getByTestId('live-event-status')).toHaveText('connected');
        }
      },
      {
        spec: 'Live pushed event is shown in the debug panel',
        check: async () => {
          await expect(page.getByText('annke.alert_stream.message_received')).toBeVisible();
          await expect(page.getByText('cameras · patrol-annke-events · VMD vehicle active')).toBeVisible();
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

  await page.getByTestId('observe-annke-ai').click();
  await tester.step('annke-ai-observed', {
    description: 'Annke camera-side AI status is reduced from observed events',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'Camera-side AI health is shown',
        check: async () => {
          await expect(page.getByText('Annke AI alert active · observed 4 seconds ago')).toBeVisible();
        }
      },
      {
        spec: 'Motion target types are shown',
        check: async () => {
          await expect(page.getByText('Motion detection: enabled')).toBeVisible();
          await expect(page.getByText('Targets: human, vehicle')).toBeVisible();
        }
      },
      {
        spec: 'Last Annke alert is shown',
        check: async () => {
          await expect(page.getByText('Last alert: vehicle active 4 seconds ago')).toBeVisible();
        }
      }
    ]
  });

  await page.getByTestId('tab-history').click();
  await tester.step('recording-history', {
    description: 'Observed events are linked to retained recordings',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'History tab is selected',
        check: async () => {
          await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
          await expect(page.getByTestId('tab-history')).toHaveAttribute('aria-current', 'page');
        }
      },
      {
        spec: 'Storage estimate is shown',
        check: async () => {
          await expect(page.getByTestId('recording-storage')).toContainText('Estimated total');
          await expect(page.getByTestId('recording-storage')).toContainText('Observed on disk');
        }
      },
      {
        spec: 'Vehicle event is shown in history',
        check: async () => {
          await expect(page.getByTestId('history-event-row')).toHaveCount(1);
          await expect(page.getByRole('button', { name: /Vehicle/ })).toBeVisible();
          await expect(page.getByTestId('history-event-row').getByText('full quality')).toBeVisible();
        }
      },
      {
        spec: 'Recording player jumps to the event segment',
        check: async () => {
          await page.getByRole('button', { name: /Vehicle/ }).click();
          await expect(page.getByTestId('recording-player')).toBeVisible();
          await expect(page.getByTestId('recording-video')).toHaveAttribute(
            'src',
            /\/api\/recordings\/file\?path=driveway_main%2F1781099196\.mp4#t=0/
          );
        }
      }
    ]
  });

  await page.getByTestId('tab-cameras').click();
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
  await page.getByTestId('tab-settings').click();
  await tester.step('refreshed-times', {
    description: 'Settings timestamp labels refresh without reload',
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
        spec: 'Credential saved age advances after one minute',
        check: async () => {
          await expect(page.getByText('Credentials saved 1 minute ago.')).toBeVisible();
        }
      }
    ]
  });

  await page.getByTestId('tab-health').click();
  await tester.step('health-refreshed-times', {
    description: 'Health timestamp labels refresh without reload',
    networkStatus: 'skip',
    verifications: [
      {
        spec: 'go2rtc observed age advances after one minute',
        check: async () => {
          await expect(page.getByText(/go2rtc streaming · observed (0 seconds|1 minute) ago/)).toBeVisible();
        }
      },
      {
        spec: 'Annke AI observed age advances after one minute',
        check: async () => {
          await expect(page.getByText(/Annke AI alert active · observed (0 seconds|1 minute) ago/)).toBeVisible();
          await expect(page.getByText('Last alert: vehicle active', { exact: false })).toBeVisible();
        }
      }
    ]
  });

  tester.generateDocs();
});

test('cached snapshot boots quickly and reconciles server state', async ({ page }) => {
  const fixedNowMs = 1781099200000;
  const cachedSnapshot = {
    state: {
      staleAfterMs: 60 * 60 * 1000,
      processes: systemProcesses(fixedNowMs - 15000),
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
          credentials: {
            savedAtMs: fixedNowMs - 30000,
            usernameSecretId: 'camera.uuid:driveway-camera.username',
            passwordSecretId: 'camera.uuid:driveway-camera.password'
          },
          go2rtc: configuredGo2rtc(fixedNowMs - 20000),
          annke: null
        }
      ],
      recordings: emptyRecordings(),
      errors: [],
      lastDiscovery: {
        runId: 'cached-discovery',
        protocol: 'onvif-ws-discovery',
        startedAtMs: fixedNowMs - 120042,
        durationMs: 42,
        completedAtMs: fixedNowMs - 120000
      }
    },
    cursor: {
      ts_ms: fixedNowMs - 100,
      id: 'cached-cursor'
    },
    cachedAtMs: fixedNowMs - 50
  };
  const freshSnapshot = structuredClone(cachedSnapshot);
  freshSnapshot.state.devices = [
    ...freshSnapshot.state.devices,
    {
      id: 'uuid:garage-camera',
      endpoint: 'uuid:garage-camera',
      remoteAddress: '10.20.240.199',
      lastSeenAtMs: fixedNowMs - 80000,
      xaddrs: ['http://10.20.240.199/onvif/device_service'],
      setupUrl: 'http://10.20.240.199',
      scopes: ['onvif://www.onvif.org/name/garage', 'onvif://www.onvif.org/hardware/Annke%20C800'],
      types: ['dn:NetworkVideoTransmitter'],
      name: 'garage',
      hardware: 'Annke C800',
      location: null,
      vendorHint: 'annke',
      streams: {
        main: 'garage_main',
        sub: 'garage_sub'
      },
      credentials: {
        savedAtMs: fixedNowMs - 25000,
        usernameSecretId: 'camera.uuid:garage-camera.username',
        passwordSecretId: 'camera.uuid:garage-camera.password'
      },
      go2rtc: configuredGo2rtc(fixedNowMs - 15000),
      annke: null
    }
  ];
  freshSnapshot.cursor = {
    ts_ms: fixedNowMs,
    id: 'fresh-cursor'
  };
  freshSnapshot.cachedAtMs = fixedNowMs;
  let stateRequests = 0;

  await page.clock.install({ time: fixedNowMs });
  await seedCachedCameraState(page, cachedSnapshot, fixedNowMs - 50);
  await page.addInitScript((eventTsMs) => {
    class PatrolWebSocketMock extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readonly url: string;
      readyState = PatrolWebSocketMock.CONNECTING;

      constructor(url: string) {
        super();
        this.url = url;
        (window as unknown as { __patrolWsUrl?: string }).__patrolWsUrl = url;
        window.setTimeout(() => {
          this.readyState = PatrolWebSocketMock.OPEN;
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'patrol.event_stream.connected',
                ts_ms: eventTsMs,
                streams: ['cameras', 'system']
              })
            })
          );
        }, 0);
      }

      send() {}

      close() {
        this.readyState = PatrolWebSocketMock.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      value: PatrolWebSocketMock
    });
  }, fixedNowMs);

  await page.route('**/api/state**', async (route) => {
    stateRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(freshSnapshot)
    });
  });
  await page.route('**/api/system/heartbeat**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        stream: 'system',
        event: {
          id: 'heartbeat-1',
          ts_ms: fixedNowMs,
          schema: 1,
          type: 'system.process.heartbeat',
          source: 'patrol-web',
          payload: {
            processId: 'patrol-web',
            label: 'Patrol web/API server',
            kind: 'server',
            pid: 123,
            host: null,
            detail: 'SvelteKit API heartbeat route responded'
          }
        }
      })
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

  await expect(page.getByRole('heading', { name: 'driveway' })).toBeVisible();
  await expect(page.getByText('No configured cameras')).toBeHidden();
  await expect.poll(() => stateRequests).toBe(1);
  await expect(page.getByRole('heading', { name: 'garage' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __patrolWsUrl?: string }).__patrolWsUrl ?? ''))
    .toContain('after_ts_ms=');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __patrolWsUrl?: string }).__patrolWsUrl ?? ''))
    .toContain('after_id=');
});

async function seedCachedCameraState(page: Page, snapshot: unknown, updatedAtMs: number) {
  await page.route('**/cache-seed', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>cache seed</title>'
    });
  });
  await page.goto('/cache-seed');
  await page.evaluate(
    async ({ snapshot: seededSnapshot, updatedAtMs: seededUpdatedAtMs }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('patrol-client-state', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('projections')) {
            db.createObjectStore('projections', { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Unable to seed client cache.'));
      });

      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('projections', 'readwrite');
        transaction.objectStore('projections').put({
          key: 'camera-state',
          projection: 'camera-state',
          projectionVersion: 1,
          snapshot: seededSnapshot,
          updatedAtMs: seededUpdatedAtMs
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Unable to write client cache.'));
      });
      db.close();
    },
    { snapshot, updatedAtMs }
  );
}

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

function observedAnnkeAi(observedAtMs: number): DiscoveredCamera['annke'] {
  return {
    observedAtMs,
    health: 'alert_active',
    motionDetection: {
      observedAtMs: observedAtMs - 1000,
      ok: true,
      enabled: true,
      targetTypes: ['human', 'vehicle'],
      sensitivityLevel: 60
    },
    smartCapabilities: {
      observedAtMs: observedAtMs - 1000,
      ok: true,
      faceDetect: false,
      audioDetection: false,
      sceneChangeDetection: false
    },
    lastAlert: {
      receivedAtMs: observedAtMs,
      eventType: 'VMD',
      eventState: 'active',
      eventDescription: 'Motion alarm',
      targetType: 'vehicle',
      channelName: 'driveway',
      cameraDateTime: '2026-06-10T12:30:55-04:00'
    }
  };
}

function emptyRecordings(): CameraDiscoveryState['recordings'] {
  return {
    segments: [],
    events: [],
    storage: {
      cameraCount: 0,
      mainRetentionDays: 7,
      subRetentionDays: 30,
      mainEstimatedBytes: 0,
      subEstimatedBytes: 0,
      totalEstimatedBytes: 0,
      observedBytes: 0
    }
  };
}

function recordingState(eventAtMs: number): CameraDiscoveryState['recordings'] {
  const segment = {
    cameraId: 'uuid:driveway-camera',
    role: 'main' as const,
    streamName: 'driveway_main',
    startMs: 1781099196000,
    endMs: 1781099256000,
    durationMs: 60000,
    sizeBytes: 32000000,
    relativePath: 'driveway_main/1781099196.mp4',
    observedAtMs: eventAtMs + 1000
  };

  return {
    segments: [segment],
    events: [
      {
        id: 'annke-alert-vehicle-1',
        cameraId: 'uuid:driveway-camera',
        occurredAtMs: eventAtMs,
        eventType: 'VMD',
        eventState: 'active',
        targetType: 'vehicle',
        label: 'Vehicle',
        sourceEventId: 'annke-alert-vehicle-1',
        preferredSegment: segment
      }
    ],
    storage: {
      cameraCount: 1,
      mainRetentionDays: 7,
      subRetentionDays: 30,
      mainEstimatedBytes: 642600000000,
      subEstimatedBytes: 226800000000,
      totalEstimatedBytes: 869400000000,
      observedBytes: segment.sizeBytes
    }
  };
}

function systemProcesses(lastAliveAtMs: number): CameraDiscoveryState['processes'] {
  return [
    {
      id: 'patrol-web',
      label: 'Patrol web/API server',
      kind: 'server',
      expectedEveryMs: 90000,
      lastAliveAtMs,
      lastEventType: 'system.process.heartbeat',
      health: 'ok',
      detail: 'SvelteKit API heartbeat route responded'
    },
    {
      id: 'patrol-events-ws',
      label: 'Event WebSocket server',
      kind: 'server',
      expectedEveryMs: 90000,
      lastAliveAtMs,
      lastEventType: 'system.process.heartbeat',
      health: 'ok',
      detail: 'Streams event log appends to browser clients'
    },
    {
      id: 'patrol-go2rtc',
      label: 'go2rtc stream server',
      kind: 'server',
      expectedEveryMs: 90000,
      lastAliveAtMs,
      lastEventType: 'system.process.heartbeat',
      health: 'ok',
      detail: 'Fans out camera RTSP streams for preview and live view'
    },
    {
      id: 'patrol-annke-events',
      label: 'Annke alert worker',
      kind: 'worker',
      expectedEveryMs: 90000,
      lastAliveAtMs,
      lastEventType: 'system.process.heartbeat',
      health: 'ok',
      detail: 'Maintains camera ISAPI alert streams'
    },
    {
      id: 'patrol-watchdog',
      label: 'Watchdog cron',
      kind: 'worker',
      expectedEveryMs: 90000,
      lastAliveAtMs,
      lastEventType: 'system.process.heartbeat',
      health: 'ok',
      detail: 'Verifies server task health and sends failure notifications'
    },
    {
      id: 'patrol-recorder',
      label: 'Recording worker',
      kind: 'worker',
      expectedEveryMs: 90000,
      lastAliveAtMs,
      lastEventType: 'system.process.heartbeat',
      health: 'ok',
      detail: 'Records main and sub streams into retained video segments'
    }
  ];
}
