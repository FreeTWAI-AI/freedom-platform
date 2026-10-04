#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './lib/manifest.mjs';
import { checkMediaWranglerConfig } from './lib/media-wrangler.mjs';

// Fixed canonical environment manifest. An explicit local overlay may be read;
// no provider credentials, environment file, flags, SQL or execution arguments.
const root = fileURLToPath(new URL('../../', import.meta.url));
try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--config' && args[1] && !args[1].startsWith('--'))) throw Error('arguments');
  const report = checkMediaWranglerConfig(args.length ? resolve(args[1]) : resolve(root, 'wrangler.jsonc'), loadManifest());
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.structural ? (report.status === 'unavailable' ? 2 : 0) : 1;
} catch {
  process.stderr.write('Media configuration preflight failed; no runtime or remote checks were performed.\n');
  process.exitCode = 1;
}
