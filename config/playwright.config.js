import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Отдельный порт и изолированные data/logs: браузерные тесты не открывают
// рабочее хранилище и не цепляются к запущенному dev-серверу на 8765.
const PORT = 8799;
const TMP = path.join(os.tmpdir(), `ai-panel-playwright-${process.pid}`);

export default defineConfig({
  testDir: '../tests/playwright',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node server.js',
    cwd: '..',
    port: PORT,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      AIPANEL_ENV_FILE: 'none',
      AIPANEL_DATA_DIR: path.join(TMP, 'data'),
      AIPANEL_LOG_DIR: path.join(TMP, 'logs'),
    },
  },
});
