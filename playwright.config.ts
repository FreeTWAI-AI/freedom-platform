import { defineConfig,devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { e2eSchema } from './packages/testing/e2e-auth-isolation.js';
// Inherited by the server and worker processes; never used by the product server.
const schema=e2eSchema(process.env.FREEDOM_E2E_SCHEMA??`fp_e2e_${randomUUID().replaceAll('-','')}`);
process.env.FREEDOM_E2E_SCHEMA=schema;
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:45000,retries:0,
  reporter:[['list']],
  use:{baseURL:'http://127.0.0.1:4311',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome'],launchOptions:process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:undefined}}],
  webServer:{command:'npx tsx scripts/e2e-server.ts',env:{FREEDOM_E2E_GITHUB_FIXTURES:'1',FREEDOM_E2E_SCHEMA:schema},url:'http://127.0.0.1:4311/api/v1/health',reuseExistingServer:false,timeout:30000}
});
