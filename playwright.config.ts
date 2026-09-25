import { defineConfig,devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { e2eSchema } from './packages/testing/e2e-auth-isolation.js';
import { e2eOrigin } from './packages/testing/e2e-origin.js';
// Inherited by the server and worker processes; never used by the product server.
const schema=e2eSchema(process.env.FREEDOM_E2E_SCHEMA??`fp_e2e_${randomUUID().replaceAll('-','')}`);
process.env.FREEDOM_E2E_SCHEMA=schema;
const origin=e2eOrigin();
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:45000,retries:0,
  reporter:[['list']],
  use:{baseURL:origin,trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome'],launchOptions:process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:undefined}}],
  // Without gracefulShutdown, Playwright 1.63 SIGKILLs the webServer process group
  // (runner/index.js attemptToGracefullyClose → processLauncher kill -pid SIGKILL)
  // and scripts/e2e-server.ts never runs its SIGTERM DROP SCHEMA. The budget has
  // to cover npx → tsx → node: the group signal reaches the child that owns the
  // pool, and close waits until that child exits.
  webServer:{command:'npx tsx scripts/e2e-server.ts',env:{FREEDOM_E2E_GITHUB_FIXTURES:'1',FREEDOM_E2E_SCHEMA:schema},url:`${origin}/api/v1/health`,reuseExistingServer:false,timeout:30000,gracefulShutdown:{signal:'SIGTERM',timeout:15000}}
});
