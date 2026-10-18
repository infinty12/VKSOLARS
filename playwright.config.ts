import { defineConfig, devices } from '@playwright/test';

// Tests run against the production build (`npm run build` first), served by server.mjs through
// scripts/test-server.mjs on a dedicated port with a DISPOSABLE storage folder (wiped each run).
// Never reuse an already-running server: it could be `npm run dev` pointed at real data.
const PORT = 4397;
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // Optional cap on parallel browsers for low-memory machines, e.g. PW_WORKERS=2 npm run verify.
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  ],
  webServer: {
    command: 'node scripts/test-server.mjs',
    url: `http://127.0.0.1:${PORT}/robots.txt`,
    env: { PORT: String(PORT), STORAGE_DIR: 'test-storage' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
