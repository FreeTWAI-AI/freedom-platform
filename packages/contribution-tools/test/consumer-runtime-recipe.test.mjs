import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSUMER_RUNTIME_RECIPE as pin, validateConsumerRuntimeImage } from '../consumer-runtime-recipe.mjs';

const inspection = () => ({ Id: pin.manifest, Os: 'linux', Architecture: 'amd64', RepoDigests: [pin.image],
  RootFS: { Type: 'layers', Layers: [pin.rootfs] },
  Config: { Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'], Cmd: ['bash'] } });
test('only the reviewed manifest or classic config identity is accepted for the pinned amd64 image', () => {
  for (const id of [pin.manifest, pin.config]) {
    const value = inspection(); value.Id = id;
    assert.equal(validateConsumerRuntimeImage(value).reference, pin.image);
    assert.equal(validateConsumerRuntimeImage(value).local_id, id);
  }
});
test('wrong architecture, mutable reference, changed image/config/rootfs and inherited credentials fail closed', () => {
  const mutations = [
    value => { value.Id = 'sha256:' + 'f'.repeat(64); },
    value => { value.RepoDigests = ['debian:bookworm-slim']; },
    value => { value.Architecture = 'arm64'; },
    value => { value.RootFS.Layers.push('sha256:' + 'e'.repeat(64)); },
    value => { value.Config.Env.push('TOKEN=untrusted'); },
    value => { value.Config.Entrypoint = ['/malicious']; },
    value => { value.Config.User = 'root'; },
    value => { value.Config.Volumes = { '/candidate': {} }; },
  ];
  for (const mutate of mutations) { const value = inspection(); mutate(value); assert.throws(() => validateConsumerRuntimeImage(value), /consumer_image_identity_mismatch/); }
});
