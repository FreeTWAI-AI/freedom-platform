// Reviewed inputs only. Registry metadata is provenance, not operator approval.
import { execFileSync } from 'node:child_process';
import { readFile, realpath, lstat, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verificationEnvironment } from './process-env.mjs';

export const CONSUMER_RUNTIME_RECIPE = Object.freeze({
  format: 'freedom.consumer-runtime-recipe/v1', platform: 'linux/amd64',
  image: 'docker.io/library/debian@sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867',
  manifest: 'sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867',
  config: 'sha256:160466e67bb85a4099d9d9c2356b4a6a64747b281a22c142efbd4539db1b8525',
  rootfs: 'sha256:1d69a5fd31932841d7825ef4780c06f008eea65aaa9f3110fe09d5832ed5c7d8',
  upstream_commit: 'bae6d64d90b4068b09ff9d8b564c2773ef5d8d83',
  upstream: 'https://github.com/debuerreotype/docker-debian-artifacts/tree/bae6d64d90b4068b09ff9d8b564c2773ef5d8d83/bookworm/slim/oci',
  node_version: 'v24.21.0',
  node_download: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz',
  node_archive_sha256: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  node_binary_sha256: '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c',
});
const pin = CONSUMER_RUNTIME_RECIPE;
const fail = code => { throw Error(code); };

/** Classic Docker identifies an image by config digest; containerd storage may
 * identify it by manifest digest. Neither permits an arbitrary local image ID. */
export function validateConsumerRuntimeImage(value) {
  if (!value || ![pin.manifest, pin.config].includes(value.Id)
    || value.Os !== 'linux' || value.Architecture !== 'amd64'
    || !value.RepoDigests?.some(ref => ['debian@', 'library/debian@', 'docker.io/library/debian@'].some(prefix => ref === prefix + pin.manifest))
    || value.RootFS?.Type !== 'layers' || !isDeepStrictEqual(value.RootFS.Layers, [pin.rootfs])
    || !isDeepStrictEqual(value.Config?.Env, ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'])
    || !isDeepStrictEqual(value.Config?.Cmd, ['bash']) || (value.Config?.Entrypoint?.length ?? 0) !== 0
    || (value.Config?.User ?? '') !== '' || (value.Config?.WorkingDir ?? '') !== ''
    || Object.keys(value.Config?.Volumes ?? {}).length || Object.keys(value.Config?.Labels ?? {}).length) fail('consumer_image_identity_mismatch');
  return { reference: pin.image, local_id: value.Id, manifest: pin.manifest, config: pin.config,
    rootfs: pin.rootfs, platform: pin.platform };
}

export async function inspectConsumerRuntime({ hosted = false } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.version !== pin.node_version
    || process.getuid() === 0) fail('consumer_runtime_platform_mismatch');
  const path = await realpath(process.execPath), stat = await lstat(path);
  if (/[,\r\n]/.test(path) || !stat.isFile() || !(stat.mode & 0o111)
    || stat.size < 1 || stat.size > 128 * 1024 * 1024) fail('consumer_node_identity_mismatch');
  const nodeDigest = createHash('sha256').update(await readFile(path)).digest('hex');
  if (nodeDigest !== pin.node_binary_sha256) fail('consumer_node_identity_mismatch');
  if (hosted) {
    const os = await readFile('/etc/os-release', 'utf8');
    if (!/^ID=ubuntu$/m.test(os) || !/^VERSION_ID="24\.04"$/m.test(os)
      || process.env.GITHUB_ACTIONS !== 'true') fail('consumer_hosted_os_mismatch');
  }
  let inspection;
  try {
    inspection = JSON.parse(execFileSync('/usr/bin/docker', ['image', 'inspect', '--format', '{{json .}}', pin.image], {
      env: verificationEnvironment(), timeout: 15000, maxBuffer: 256000, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch { fail('consumer_image_unavailable'); }
  return { recipe: pin.format, image: validateConsumerRuntimeImage(inspection),
    node: { executable: path, version: process.version, sha256: nodeDigest },
    host: { platform: process.platform, architecture: process.arch,
      glibc: process.report.getReport().header.glibcVersionRuntime,
      runner_image_version: process.env.ImageVersion ?? null, hosted_os_checked: hosted },
    candidate_userspace: 'pinned-image-and-node-binary', host_os_approval: 'unverified', publisher_trust: 'unverified' };
}

/** Explicit setup operation only; the supervisor itself never pulls implicitly.
 * Empty Docker config avoids consulting registry credentials. */
export async function prepareConsumerRuntime() {
  const config = await mkdtemp(join(tmpdir(), 'fp-public-image-pull-'));
  try {
    execFileSync('/usr/bin/docker', ['--config', config, 'pull', '--platform', pin.platform, pin.image], {
      env: verificationEnvironment(), timeout: 120000, maxBuffer: 256000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally { await rm(config, { recursive: true, force: true }); }
  return inspectConsumerRuntime();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...extra] = process.argv.slice(2);
    if (extra.length || !['prepare', 'verify', 'verify-hosted'].includes(command)) fail('consumer_recipe_usage');
    console.log(JSON.stringify(command === 'prepare' ? await prepareConsumerRuntime()
      : await inspectConsumerRuntime({ hosted: command === 'verify-hosted' })));
  } catch (error) { console.log(JSON.stringify({ status: 'unavailable', reason: /^consumer_/.test(error.message) ? error.message : 'consumer_recipe_failed' })); process.exitCode = 1; }
}
