import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync } from 'node:fs';
import { chmod, mkdtemp, open, rm, unlink, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterFault, type CliArtifact, type CliObservation } from './common.js';
const MAX_BINARY = 512 * 1024 * 1024, COPY_MS = 5000;
const fail = (code: 'invalid_input'|'artifact_mismatch'|'probe_unavailable'|'response_limit'): never => { throw new AdapterFault(code); };
export function nativeArtifactSnapshot(raw: unknown): CliArtifact {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype
    || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !['executable', 'sha256', 'version'].includes(key))) return fail('invalid_input');
  const values = Object.getOwnPropertyDescriptors(raw);
  if (Object.keys(values).length !== 3 || Object.values(values).some(value => !value.enumerable || !('value' in value))) return fail('invalid_input');
  const { executable, sha256, version } = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.value]));
  if (typeof executable !== 'string' || executable.length > 4096 || !isAbsolute(executable) || normalize(executable) !== executable
    || /[\\\u0000-\u001F\u007F]/.test(executable) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$(?![\s\S])/.test(sha256)
    || typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$(?![\s\S])/.test(version) || version.length > 64) return fail('invalid_input');
  return Object.freeze({ executable, sha256, version });
}

/** Only native Linux x86-64 executables can enter the host diagnostic sandbox.
 * Scripts, arbitrary interpreters and unbounded ELF program tables fail closed. */
function nativeHeader(bytes: Buffer, size: number): void {
  if (bytes.length < 64 || !bytes.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))
    || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== 62 || bytes.readUInt32LE(20) !== 1
    || bytes.readUInt16LE(52) !== 64 || bytes.readUInt16LE(54) !== 56) return fail('artifact_mismatch');
  const offset = bytes.readBigUInt64LE(32), count = bytes.readUInt16LE(56);
  if (offset < 64n || count < 1 || count > 128 || offset + BigInt(count * 56) > BigInt(size)
    || offset + BigInt(count * 56) > BigInt(bytes.length)) return fail('artifact_mismatch');
  let executableLoad = false;
  for (let n = 0; n < count; n++) {
    const start = Number(offset) + n * 56, type = bytes.readUInt32LE(start), flags = bytes.readUInt32LE(start + 4);
    const fileOffset = bytes.readBigUInt64LE(start + 8), fileSize = bytes.readBigUInt64LE(start + 32);
    if (fileOffset + fileSize > BigInt(size)) return fail('artifact_mismatch');
    if (type === 1 && flags & 1) executableLoad = true;
    if (type === 3) {
      if (fileSize < 2n || fileSize > 256n || fileOffset + fileSize > BigInt(bytes.length)) return fail('artifact_mismatch');
      const interpreter = bytes.subarray(Number(fileOffset), Number(fileOffset + fileSize));
      if (!interpreter.equals(Buffer.from('/lib64/ld-linux-x86-64.so.2\0'))) return fail('artifact_mismatch');
    }
  }
  if (!executableLoad) return fail('artifact_mismatch');
}

/** Copy and verify a bounded native binary before opening an unlinked read-only
 * snapshot. Hashing the copy, then binding its inherited FD, prevents pathname
 * replacement and mutation of the original inode from changing the executed bytes. */
export async function pinNativeExecutable(artifact: CliArtifact): Promise<FileHandle> {
  let source: FileHandle | undefined, writer: FileHandle | undefined, snapshot: FileHandle | undefined, directory: string | undefined;
  const deadline = Date.now() + COPY_MS;
  try {
    source = await open(artifact.executable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await source.stat();
    if (!info.isFile() || info.size < 64 || info.size > MAX_BINARY || !(info.mode & 0o111)) return fail('artifact_mismatch');
    directory = await mkdtemp(join(tmpdir(), 'fp-cli-probe-'));
    await chmod(directory, 0o700);
    const path = join(directory, 'executable');
    writer = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < info.size) {
      if (Date.now() >= deadline) return fail('probe_unavailable');
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
      if (!bytesRead) return fail('artifact_mismatch');
      const chunk = buffer.subarray(0, bytesRead);
      if (offset === 0) nativeHeader(chunk, info.size);
      hash.update(chunk);
      for (let written = 0; written < bytesRead;) {
        const result = await writer.write(chunk, written, bytesRead - written);
        if (!result.bytesWritten) return fail('probe_unavailable');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    if (hash.digest('hex') !== artifact.sha256 || (await source.stat()).size !== info.size) return fail('artifact_mismatch');
    await writer.close(); writer = undefined;
    await chmod(path, 0o500);
    snapshot = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    await unlink(path);
    const result = snapshot; snapshot = undefined;
    return result;
  } catch (error) {
    if (error instanceof AdapterFault) throw error;
    return fail('artifact_mismatch');
  } finally {
    await Promise.allSettled([source?.close(), writer?.close(), snapshot?.close()].filter(value => value !== undefined));
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}

export function runPinnedNative(snapshot: FileHandle, args: readonly string[], options: {
  timeoutMs: number; combinedBytes: number; stdoutBytes?: number; stderrBytes?: number;
  input?: Uint8Array; signal?: AbortSignal;
}): Promise<CliObservation> {
  return new Promise((resolve, reject) => {
    // Never inherit tokens, proxy variables, preload settings or the repo cwd.
    if (options.signal?.aborted) { reject(new AdapterFault('outcome_unknown')); return; }
    // --ro-bind-data consumes an FD offset. Each launch needs its own open
    // description of the same unlinked immutable snapshot, including a second
    // launch after the controls probe. The fixed /proc/self/fd path is host-only.
    const child = (() => {
      const fd = openSync(`/proc/self/fd/${snapshot.fd}`, constants.O_RDONLY);
      try { return spawn('/usr/bin/bwrap', args, { env: {}, cwd: '/', detached: true,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', fd] }); }
      finally { closeSync(fd); }
    })();
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, chunks = 0, settled = false, stdoutSize = 0, stderrSize = 0;
    const killGroup = () => {
      if (typeof child.pid === 'number' && child.pid > 0) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Group already reaped. */ }
      }
    };
    const stop = (code: 'probe_unavailable'|'response_limit'|'outcome_unknown') => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); killGroup(); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      reject(new AdapterFault(code));
    };
    const abort = () => stop('outcome_unknown');
    const timer = setTimeout(() => stop('probe_unavailable'), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      if (sink === stdout) stdoutSize += chunk.byteLength; else stderrSize += chunk.byteLength;
      if (++chunks > 256 || chunk.byteLength > options.combinedBytes - size
        || stdoutSize > (options.stdoutBytes ?? options.combinedBytes) || stderrSize > (options.stderrBytes ?? options.combinedBytes)) { stop('response_limit'); return; }
      size += chunk.byteLength; sink.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', collect(stdout)); child.stderr?.on('data', collect(stderr));
    child.once('error', () => stop('probe_unavailable'));
    child.stdin?.once('error', () => stop('probe_unavailable'));
    if (options.input !== undefined) child.stdin?.end(options.input);
    if (options.signal?.aborted) abort();
    // A forked descendant may hold output pipes after the immediate child exits.
    // Kill the group on exit as well as timeout; never wait indefinitely for close.
    child.once('exit', killGroup);
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); killGroup();
      if (exitCode === null || signal !== null) { reject(new AdapterFault('probe_unavailable')); return; }
      resolve(Object.freeze({ exitCode, signal: null, stdout: Uint8Array.from(Buffer.concat(stdout)), stderr: Uint8Array.from(Buffer.concat(stderr)) }));
    });
  });
}

const BWRAP = '/usr/bin/bwrap';
const libraries = Object.freeze([
  '/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
  '/lib/x86_64-linux-gnu/libc.so.6', '/lib/x86_64-linux-gnu/libm.so.6',
  '/lib/x86_64-linux-gnu/libdl.so.2', '/lib/x86_64-linux-gnu/libpthread.so.0',
  '/lib/x86_64-linux-gnu/librt.so.1', '/lib/x86_64-linux-gnu/libgcc_s.so.1',
  '/lib/x86_64-linux-gnu/libstdc++.so.6',
]);
export async function isolatedNativeArguments(argv: readonly string[]): Promise<string[]> {
  const installed = await stat(BWRAP).catch(() => undefined);
  if (!installed?.isFile() || !(installed.mode & 0o111) || installed.uid !== 0 || installed.mode & 0o022) return fail('probe_unavailable');
  const args = ['--unshare-all', '--die-with-parent', '--hostname', 'fp-model-probe', '--cap-drop', 'ALL', '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev',
    '--dir', '/tmp', '--dir', '/home', '--dir', '/home/probe', '--dir', '/home/probe/.codex', '--dir', '/home/probe/.claude',
    '--dir', '/workspace', '--dir', '/lib', '--dir', '/lib/x86_64-linux-gnu', '--dir', '/lib64'];
  for (const path of libraries) {
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() && info.uid === 0 && !(info.mode & 0o022)) args.push('--ro-bind', path, path);
  }
  // --ro-bind-fd canonicalizes /proc/self/fd and fails for an unlinked inode.
  // --ro-bind-data consumes the inherited verified snapshot directly, creates
  // its own executable inode and mounts that inode read-only.
  args.push('--perms', '0500', '--ro-bind-data', '3', '/cli', '--clearenv', '--setenv', 'HOME', '/home/probe',
    '--setenv', 'CODEX_HOME', '/home/probe/.codex', '--setenv', 'CLAUDE_CONFIG_DIR', '/home/probe/.claude',
    '--setenv', 'PATH', '/bin:/usr/bin', '--setenv', 'TMPDIR', '/tmp', '--chdir', '/workspace', '/cli');
  args.push(...argv);
  return args;
}
