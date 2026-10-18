import { defineConfig, devices } from '@playwright/test';

// Tests run against the production build (`npm run build` first), served by server.mjs through
// scripts/test-server.mjs on dedicated ports with DISPOSABLE storage folders (wiped each run).
// Never reuse an already-running server: it could be `npm run dev` pointed at real data.
//
//   :4397  default server — enquiries CLOSED, exactly as shipped (test-storage/)
//   :4395  "open" server  — enquiries enabled; rate limit / minimum fill time relaxed so UI tests
//          aren't blocked (test-storage-open/). The strict defaults are tested by smoke:admin.
const PORT = 4397;
export const OPEN_PORT = 4395;

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
  webServer: [
    {
      command: 'node scripts/test-server.mjs',
      url: `http://127.0.0.1:${PORT}/robots.txt`,
      env: { PORT: String(PORT), STORAGE_DIR: 'test-storage' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'node scripts/test-server.mjs',
      url: `http://127.0.0.1:${OPEN_PORT}/robots.txt`,
      env: {
        PORT: String(OPEN_PORT),
        STORAGE_DIR: 'test-storage-open',
        ENQUIRIES_ENABLED: 'true',
        TEST_ACCEPT_ENQUIRIES: 'true',
        ENQUIRY_MIN_FILL_MS: '0',
        ENQUIRY_RATE_LIMIT_PER_IP: '100000',
        ENQUIRY_RATE_LIMIT_GLOBAL: '100000',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
