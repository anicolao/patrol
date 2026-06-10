# E2E Testing Guide

This project uses [Playwright](https://playwright.dev/) for End-to-End testing.
E2E tests are the primary source of truth for frontend behavior.

## 1. The Philosophy: Zero-Pixel Tolerance

Patrol inherits the E2E testing pattern from `antigravity/food`: visual state is
part of correctness, so committed screenshots should be deterministic and should
not drift casually.

- **Software rendering**: browsers launch with flags that reduce machine-specific
  rendering differences.
- **Determinism**: tests should not depend on random data, wall-clock sleeps, or
  external services.
- **Strict screenshots**: `toHaveScreenshot` uses `maxDiffPixels: 0`.

## 2. Test Structure

All E2E tests live in `tests/e2e/`. Scenario tests may use their own directory
so generated documentation and screenshots stay next to the test.

```text
tests/e2e/
├── helpers/
│   └── test-step-helper.ts
└── 001-home/
    ├── 001-home.spec.ts
    ├── README.md
    └── screenshots/
        └── 000-home-page.png
```

## 3. The Unified Step Pattern

Use `TestStepHelper` to combine verification, screenshots, and generated
scenario documentation in one operation.

```typescript
import { expect, test } from '@playwright/test';
import { TestStepHelper } from '../helpers/test-step-helper';

test('frontend serves Patrol home page', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);

  await page.goto('/');
  await tester.step('home-page', {
    description: 'Patrol home page is visible',
    networkStatus: 'skip',
    verifications: [
      { spec: 'Document title is Patrol', check: async () => await expect(page).toHaveTitle('Patrol') }
    ]
  });

  tester.generateDocs();
});
```

This automatically:

1. Runs the verification checks.
2. Captures a numbered screenshot.
3. Validates the screenshot against the committed baseline.
4. Generates a Markdown scenario file for the test.

## 4. Running Tests

```bash
npm install
npm run test:e2e
```

When the UI intentionally changes, update screenshots with:

```bash
npm run test:e2e:update-snapshots
```

Do not use arbitrary sleeps. Wait for real UI states with Playwright assertions
such as `expect(locator).toBeVisible()`.

Playwright starts Patrol's dev server on port `5184` and does not reuse existing
servers, so a passing E2E run proves the Patrol frontend itself is serving.
