import { expect, test } from '@playwright/test';
import { TestStepHelper } from '../helpers/test-step-helper';

test('frontend serves Patrol camera discovery', async ({ page }, testInfo) => {
  const fixedNowMs = 1781099200000;
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
        body: JSON.stringify({
          staleAfterMs: 60 * 60 * 1000,
          devices: [],
          errors: [],
          lastDiscovery: null
        })
      });
      return;
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
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
            credentials: null
          }
        ]
      })
    });
  });
  let credentialRequest: unknown = null;
  await page.route('**/api/cameras/credentials', async (route) => {
    credentialRequest = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
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
            credentials: {
              savedAtMs: fixedNowMs - 30000,
              usernameSecretId: 'camera.uuid:driveway-camera.username',
              passwordSecretId: 'camera.uuid:driveway-camera.password'
            }
          }
        ]
      })
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

  await page.clock.fastForward(60 * 1000);
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
        spec: 'Credential saved age advances after one minute',
        check: async () => {
          await expect(page.getByText('Credentials saved 1 minute ago.')).toBeVisible();
        }
      }
    ]
  });

  tester.generateDocs();
});
