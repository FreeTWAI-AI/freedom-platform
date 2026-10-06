// Temporary trust-pin probe P (2026-10-06). It only targets a disposable branch and is never merged to main.
// A deliberate failure in the selected deploy-preflight job must keep the pinned verify aggregate non-success.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('trust-pin probe P fails only the selected deploy preflight job', () => {
  assert.fail('trust_pin_probe_p_expected_failure');
});
