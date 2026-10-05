import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verificationEnvironment } from '../process-env.mjs';

const reader = fileURLToPath(new URL('../directory-build-archive.py', import.meta.url));
// Archives are created independently with Python's standard tar writer. The
// reader never extracts paths, links, special files or candidate code.
function archive(kind) {
  return execFileSync('/usr/bin/python3', ['-I', '-c', `
import io,tarfile,sys
b=io.BytesIO()
with tarfile.open(fileobj=b,mode='w',format=tarfile.USTAR_FORMAT) as t:
 d=tarfile.TarInfo('work'); d.type=tarfile.DIRTYPE; t.addfile(d)
 a=tarfile.TarInfo('work/value'); a.size=2; t.addfile(a,io.BytesIO(b'ok'))
 kind=sys.argv[1]
 if kind=='duplicate': t.addfile(a,io.BytesIO(b'ok'))
 if kind in ('symlink','hardlink','fifo','escape','absolute','oversize'):
  a=tarfile.TarInfo({'escape':'work/../outside','absolute':'/outside'}.get(kind,'work/unsafe'))
  if kind=='symlink': a.type=tarfile.SYMTYPE; a.linkname='/etc/passwd'
  if kind=='hardlink': a.type=tarfile.LNKTYPE; a.linkname='work/value'
  if kind=='fifo': a.type=tarfile.FIFOTYPE
  if kind=='oversize': a.size=2*1024*1024+1
  t.addfile(a,io.BytesIO(bytes(a.size)))
sys.stdout.buffer.write(b.getvalue())`, kind], { env: verificationEnvironment(), maxBuffer: 4 * 1024 * 1024 });
}
const read = bytes => execFileSync('/usr/bin/python3', ['-I', reader], { input: bytes, env: verificationEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
test('archive observation hashes regular bytes without extracting', () => {
  assert.deepEqual(JSON.parse(read(archive('valid'))), {
    directories: ['work'], files: [['work/value', '2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df']],
  });
});
test('links, duplicates, traversal, special files, oversized and malformed archives fail closed', () => {
  for (const kind of ['duplicate', 'symlink', 'hardlink', 'fifo', 'escape', 'absolute', 'oversize']) {
    assert.throws(() => read(archive(kind)), error => error.status === 1 && JSON.parse(error.stdout).error === 'directory_archive_invalid', kind);
  }
  for (const bytes of [Buffer.from('invalid'), Buffer.alloc(8 * 1024 * 1024 + 1)]) assert.throws(() => read(bytes));
});
