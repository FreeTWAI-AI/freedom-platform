import { defineConfig,devices } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:45000,retries:0,
  reporter:[['list']],
  use:{baseURL:'http://127.0.0.1:4311',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome'],launchOptions:process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:undefined}}],
  webServer:{command:'npx tsx scripts/e2e-server.ts',url:'http://127.0.0.1:4311/api/v1/health',reuseExistingServer:false,timeout:30000}
});
