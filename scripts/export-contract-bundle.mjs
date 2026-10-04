// Explicit local export only. Every exported source file must already be committed.
import { exportPreviewBundle } from '../packages/contribution-tools/export.mjs';
import { safeFailure } from '../packages/contribution-tools/errors.mjs';
try {
  console.log(JSON.stringify(await exportPreviewBundle(process.argv.slice(2))));
} catch (error) {
  console.log(JSON.stringify(safeFailure(error)));
  process.exitCode = 1;
}
