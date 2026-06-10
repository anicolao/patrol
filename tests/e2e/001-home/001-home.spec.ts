import { expect, test } from '@playwright/test';
import { TestStepHelper } from '../helpers/test-step-helper';

test('frontend serves Patrol home page', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata('Patrol Home', 'The SvelteKit frontend serves the Patrol home page.');

  await page.goto('/');

  await tester.step('home-page', {
    description: 'Patrol home page is visible',
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
      }
    ]
  });

  tester.generateDocs();
});
