import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import type { ArchiveStore } from './backup-archive.js';

/* Local filesystem ArchiveStore for an operator-controlled directory (for
 * example the host's copy of the off-site archive). No credentials, discovery,
 * overwrite or deletion. Create-only is enforced with an exclusive temp file
 * and link(2), which fails if the final name already exists. This is local
 * durability only; it is not off-host replication or immutability. */

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_KEY = 512;

export class FileArchiveStoreError extends Error {
  constructor(readonly code: 'invalid_root' | 'invalid_key' | 'archive_io' | 'list_overflow') {
    super(code); this.name = 'FileArchiveStoreError';
  }
}
function fail(code: FileArchiveStoreError['code']): never { throw new FileArchiveStoreError(code); }

function checkKey(key: string, prefix = false): string[] {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY) fail('invalid_key');
  const parts = (prefix && key.endsWith('/') ? key.slice(0, -1) : key).split('/');
  if (parts.some(p => !SEGMENT.test(p) || p.startsWith('.tmp-'))) fail('invalid_key');
  return parts;
}

export async function createFileArchiveStore(root: string): Promise<ArchiveStore> {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('invalid_root');
  let base: string;
  try {
    base = await realpath(root);
    const info = await lstat(base);
    if (!info.isDirectory()) fail('invalid_root');
  } catch (e) { if (e instanceof FileArchiveStoreError) throw e; fail('invalid_root'); }
  const resolved = (parts: string[]) => join(base!, ...parts);
  /** Refuse symlinked components so the archive cannot be redirected. */
  async function assertNoLinks(parts: string[]): Promise<void> {
    let current = base!;
    for (const part of parts) {
      current = join(current, part);
      let info;
      try { info = await lstat(current); } catch (e) { if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return; fail('archive_io'); }
      if (info!.isSymbolicLink()) fail('invalid_key');
    }
  }

  return Object.freeze({
    async putIfAbsent(key: string, body: ReadableStream<Uint8Array>): Promise<'created' | 'exists'> {
      const parts = checkKey(key);
      await assertNoLinks(parts);
      const finalPath = resolved(parts), directory = resolved(parts.slice(0, -1));
      try { await mkdir(directory, { recursive: true, mode: 0o700 }); } catch { fail('archive_io'); }
      await assertNoLinks(parts);
      try { await lstat(finalPath); try { await body.cancel(); } catch { /* unused */ } return 'exists'; }
      catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') fail('archive_io'); }
      const temp = join(directory, `.tmp-${randomUUID()}`);
      let handle;
      try { handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); } catch { fail('archive_io'); }
      try {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array)) fail('archive_io');
            let offset = 0;
            while (offset < value.byteLength) offset += (await handle!.write(value, offset, value.byteLength - offset)).bytesWritten;
          }
        } finally { reader.releaseLock(); }
        await handle!.sync();
        await handle!.close(); handle = undefined;
        try { await link(temp, finalPath); }
        catch (e) { if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return 'exists'; throw e; }
        const dir = await open(directory, constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
        return 'created';
      } catch (e) {
        if (e instanceof FileArchiveStoreError) throw e;
        return fail('archive_io');
      } finally {
        try { await handle?.close(); } catch { /* closing a failed temp */ }
        try { await unlink(temp); } catch { /* temp may already be gone */ }
      }
    },
    async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
      const parts = checkKey(key);
      await assertNoLinks(parts);
      // Regular files only: a FIFO/device would block or stream indefinitely.
      // This assumes a trusted operator directory; it is not tamper-proofing.
      try { if (!(await lstat(resolved(parts))).isFile()) fail('invalid_key'); }
      catch (e) { if (e instanceof FileArchiveStoreError) throw e; if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null; return fail('archive_io'); }
      let handle;
      try { handle = await open(resolved(parts), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null; return fail('archive_io'); }
      try { if (!(await handle.stat()).isFile()) fail('invalid_key'); }
      catch (e) { await handle.close(); if (e instanceof FileArchiveStoreError) throw e; return fail('archive_io'); }
      const stream = handle.createReadStream({ highWaterMark: 1024 * 1024 });
      return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
    },
    async list(prefix: string, limit: number): Promise<readonly string[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) fail('invalid_key');
      const parts = checkKey(prefix, true);
      await assertNoLinks(parts);
      const keys: string[] = [];
      async function walk(directory: string, relative: string[]): Promise<void> {
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (e) { if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return; return fail('archive_io'); }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          if (entry.name.startsWith('.tmp-')) continue;
          if (!SEGMENT.test(entry.name) || entry.isSymbolicLink()) fail('invalid_key');
          const next = [...relative, entry.name];
          if (entry.isDirectory()) await walk(join(directory, entry.name), next);
          else if (entry.isFile()) { keys.push(next.join('/')); if (keys.length > limit) fail('list_overflow'); }
          else fail('invalid_key');
        }
      }
      await walk(resolved(parts), parts);
      return Object.freeze(keys);
    },
  });
}
