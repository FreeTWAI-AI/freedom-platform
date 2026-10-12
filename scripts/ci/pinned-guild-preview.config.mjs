import {statSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';

const root = process.env.FREEDOM_PINNED_E2E_ROOT;
if (typeof root !== 'string' || !isAbsolute(root) || !statSync(join(root, 'apps/portal-web/guild-preview/dist/index.html')).isFile()) {
  throw Error('guild_preview_build_required');
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export default {
  testDir: join(root, 'modules'), testMatch: '**/*.spec.ts', testIgnore: [],
  grep: /.*/, grepInvert: [], forbidOnly: true, shard: null,
  fullyParallel: false, workers: 1, retries: 0, repeatEach: 1,
  timeout: 30_000, ignoreSnapshots: false, updateSnapshots: 'none', respectGitIgnore: false,
  captureGitInfo: {commit: false, diff: false},
  use: {baseURL: 'http://127.0.0.1:4487', trace: 'retain-on-failure', screenshot: 'only-on-failure'},
  projects: [{name: 'chromium', use: {browserName: 'chromium'}}],
  webServer: {
    command: [process.execPath, join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--config', 'apps/portal-web/guild-preview/vite.config.ts'].map(quote).join(' '),
    cwd: root, url: 'http://127.0.0.1:4487', reuseExistingServer: false,
  },
};
