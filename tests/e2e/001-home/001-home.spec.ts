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
      }
    ]
  });

  tester.generateDocs();
});
