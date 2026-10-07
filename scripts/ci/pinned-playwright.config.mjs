import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Trusted config for run-pinned-e2e.mjs, so a candidate config cannot filter out reviewed tests.
// The candidate config is still imported: it sets the private e2e schema and owns the web server.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const root = process.env.FREEDOM_PINNED_E2E_ROOT;
if (typeof root !== 'string' || !isAbsolute(root) || !statSync(join(root, 'playwright.config.ts')).isFile()) {
  throw Error('invalid_pinned_e2e_root');
}
const candidate = (await import(pathToFileURL(join(root, 'playwright.config.ts')).href)).default;
if (!object(candidate)) throw Error('invalid_pinned_e2e_config');
const chromium = Array.isArray(candidate.projects) ? candidate.projects.filter(project => project?.name === 'chromium') : [];
if (chromium.length !== 1) throw Error('invalid_pinned_e2e_chromium');
const servers = candidate.webServer === undefined ? undefined : Array.isArray(candidate.webServer) ? candidate.webServer : [candidate.webServer];
const webServer = servers?.map(server => {
  if (!object(server)) throw Error('invalid_pinned_e2e_web_server');
  return { ...server, cwd: server.cwd === undefined ? root : resolve(root, server.cwd), reuseExistingServer: false };
});

// Only use, positive safe-integer timeout, webServer and chromium.use come from the candidate; everything else is trusted.
export default {
  use: candidate.use,
  ...(Number.isSafeInteger(candidate.timeout) && candidate.timeout > 0 ? { timeout: candidate.timeout } : {}),
  webServer,
  testDir: join(root, 'tests/e2e'), testMatch: '**/*.@(spec|test).?(c|m)[jt]s?(x)',
  testIgnore: [], grep: /.*/, grepInvert: [], forbidOnly: true, shard: null,
  fullyParallel: false, workers: 1, retries: 0, repeatEach: 1,
  ignoreSnapshots: false, updateSnapshots: 'none', respectGitIgnore: false,
  // Under GitHub Actions Playwright would otherwise run git here and fetch the PR base commit (3 s per pass).
  captureGitInfo: { commit: false, diff: false },
  projects: [{ name: 'chromium', use: chromium[0].use }]
};
