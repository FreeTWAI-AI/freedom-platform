import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';

export default defineConfig({
  testDir: '../../modules',
  testMatch: '**/guild-*/**/*.spec.ts',
  fullyParallel: false, workers: 1, retries: 0,
  outputDir: '../../test-results/guild-preview',
  reporter: 'list',
  use: {baseURL: 'http://127.0.0.1:4487', browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure'},
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --config apps/portal-web/guild-preview/vite.config.ts',
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    url: 'http://127.0.0.1:4487', reuseExistingServer: false,
  },
});
