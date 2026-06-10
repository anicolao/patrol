import { expect, test } from '@playwright/test';
import { TestStepHelper } from '../helpers/test-step-helper';

test('frontend serves Patrol camera discovery', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(
    page,
    testInfo
  );
  tester.setMetadata('Patrol Camera Discovery', 'The SvelteKit frontend serves camera discovery.');

  await page.route('**/api/cameras/discover', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        protocol: 'onvif-ws-discovery',
        startedAtMs: 1781099112345,
        durationMs: 42,
        errors: [],
        devices: [
          {
            id: 'uuid:driveway-camera',
            endpoint: 'uuid:driveway-camera',
            remoteAddress: '10.20.240.193',
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
            vendorHint: 'annke'
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
        cameraId: 'uuid:driveway-camera',
        host: '10.20.240.193',
        storedAtMs: 1781099112445,
        secretIds: {
          username: 'camera.uuid:driveway-camera.username',
          password: 'camera.uuid:driveway-camera.password'
        }
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
          await expect(page.getByText('Credentials saved to the local secrets log.')).toBeVisible();
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

  tester.generateDocs();
});
