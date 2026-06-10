import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5184',
    trace: 'on-first-retry',
    contextOptions: { reducedMotion: 'reduce' },
    serviceWorkers: 'block',
    launchOptions: {
      args: [
        '--font-render-hinting=none',
        '--disable-font-subpixel-positioning',
        '--disable-lcd-text',
        '--disable-skia-runtime-opts',
        '--disable-system-font-check',
        '--disable-features=FontAccess,WebRtcHideLocalIpsWithMdns',
        '--force-device-scale-factor=1',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--use-gl=swiftshader',
        '--disable-smooth-scrolling',
        '--disable-partial-raster'
      ]
    },
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 1,
    timezoneId: 'America/Toronto',
    locale: 'en-CA'
  },
  snapshotPathTemplate: '{testDir}/{testFileDir}/screenshots/{arg}.png',
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium'
      }
    }
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5184',
    reuseExistingServer: false
  },
  timeout: 60000,
  expect: {
    timeout: 5000,
    toHaveScreenshot: { maxDiffPixels: 0 }
  }
});
