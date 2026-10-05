import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertMutationTarget, loadManifest, validateManifest } from '../lib/manifest.mjs';
import { purposeBuckets, checkPurposeBindings } from '../lib/r2-purposes.mjs';
import { parseJsonc, checkWranglerConfig } from '../lib/wrangler.mjs';
import { checkMediaWranglerConfig } from '../lib/media-wrangler.mjs';
const manifest = loadManifest();
const canonical = parseJsonc(readFileSync(new URL('../../../wrangler.jsonc', import.meta.url), 'utf8'));
function checked(change = () => {}) {
  const config = structuredClone(canonical), root = mkdtempSync(join(tmpdir(), 'fp-guide-purpose-'));
  try {
    for (const [environment, block] of Object.entries(config.env)) {
      const purposes = purposeBuckets(manifest.environments[environment]);
      block.r2_buckets = Object.values(purposes).map(item => ({ binding: item.binding, bucket_name: item.name }));
      block.vars.FREEDOM_PUBLIC_GUIDE_ENABLED = 'false';
    }
    change(config); const path = join(root, 'wrangler.json'); writeFileSync(path, JSON.stringify(config));
    return { platform: checkWranglerConfig(path, manifest), media: checkMediaWranglerConfig(path, manifest) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('purpose-aware canonical registry permits dedicated private-origin GUIDE_STATIC alongside private MEDIA', () => {
  assert.deepEqual(validateManifest(manifest).errors, []);
  for (const env of Object.values(manifest.environments)) {
    const purposes = purposeBuckets(env); assert.equal(purposes.MEDIA.purpose, 'member-private'); assert.equal(purposes.GUIDE_STATIC.purpose, 'platform-public');
    assert.equal(purposes.MEDIA.public, false); assert.equal(purposes.GUIDE_STATIC.public, false); assert.notEqual(purposes.MEDIA.name, purposes.GUIDE_STATIC.name);
  }
  const report = checked(); assert.equal(report.platform.structural, 'valid'); assert.equal(report.media.structural, true);
  assert.equal(report.media.deployment_ready, false); assert.equal(report.media.provider_mutations, 0);
  for (const [name, mapping] of Object.entries(report.media.mapping)) assert.equal(mapping.expected_bucket, purposeBuckets(manifest.environments[name]).MEDIA.name);
});
test('purpose checker rejects public origins, unknown purpose, crossed names and duplicate canonical mappings', () => {
  for (const change of [
    m => { m.environments.next.r2_buckets[1].public = true; },
    m => { m.environments.next.r2_buckets[1].binding = 'MEDIA'; },
    m => { m.environments.next.r2_buckets[1].purpose = 'member-private'; },
    m => { m.environments.next.r2_buckets[1].name = m.environments.next.r2_buckets[0].name; },
    m => { m.environments.next.r2_buckets[1].name = m.environments['staging-next'].r2_buckets[1].name; },
    m => { m.environments.next.r2_buckets.push({ ...m.environments.next.r2_buckets[1] }); },
  ]) { const modified = structuredClone(manifest); change(modified); assert.equal(validateManifest(modified).ok, false); }
});
test('generic checker retains exact per-purpose binding checks; media accepts second bucket without arbitrary exemption', () => {
  for (const change of [
    c => { c.env.next.r2_buckets[0].bucket_name = c.env.next.r2_buckets[1].bucket_name; },
    c => { c.env.next.r2_buckets[1].bucket_name = c.env.next.r2_buckets[0].bucket_name; },
    c => { c.env.next.r2_buckets[1].bucket_name = c.env['staging-next'].r2_buckets[1].bucket_name; },
    c => { c.env.next.r2_buckets[1].preview_bucket_name = 'private-other'; },
    c => { c.env.next.r2_buckets.push({ binding: 'OTHER', bucket_name: 'private-other' }); },
    c => { c.env.next.r2_buckets.push({ ...c.env.next.r2_buckets[1] }); },
    c => { c.env.next.vars.FREEDOM_PUBLIC_GUIDE_ENABLED = 'true'; c.env.next.r2_buckets.pop(); },
    c => { c.env.next.vars.FREEDOM_PUBLIC_GUIDE_ENABLED = 'yes'; },
  ]) { const report = checked(change); assert.equal(report.platform.structural, 'invalid'); assert.equal(report.media.structural, false); }
  assert.deepEqual(checkPurposeBindings({ r2_buckets: [] }, manifest.environments.next), { errors: [], blockers: [] });
});

test('reviewed existing public-purpose bucket can be referenced without new provisioning or mutation authority', () => {
  const modified = structuredClone(manifest);
  const guide = modified.environments.next.r2_buckets.find(item => item.binding === 'GUIDE_STATIC');
  guide.name = 'approved-existing-guide-origin'; guide.referenced_preexisting = true;
  assert.equal(validateManifest(modified).ok, true);
  assert.deepEqual(checkPurposeBindings({r2_buckets:[{binding:'GUIDE_STATIC',bucket_name:guide.name}]}, modified.environments.next), {errors:[],blockers:[]});
  assert.throws(() => assertMutationTarget(modified, 'next', 'r2_bucket', guide.name), /not owned/);
  assert(checkPurposeBindings({r2_buckets:[{binding:'GUIDE_STATIC',bucket_name:modified.environments.next.r2_buckets[0].name}]}, modified.environments.next).errors.includes('GUIDE_STATIC:bucket_crossed'));
  const staging = modified.environments['staging-next'].r2_buckets.find(item => item.binding === 'GUIDE_STATIC');
  staging.name = guide.name; staging.referenced_preexisting = true;
  assert.equal(validateManifest(modified).ok, false, 'existing buckets cannot cross environments');
});
