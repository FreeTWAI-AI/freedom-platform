// Fixed host-only parser installation. Candidate modules never participate.
import { readdir, lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

export const DIRECTORY_HTML_DEPENDENCIES = Object.freeze({
  parse5: '8.0.1', entities: '8.0.0', files: 91, bytes: 573101,
  sha256: '23432fe7cdf370e67a8289a1cce223d6c23cf2969550a7f9864c40b353caa9be',
});
const root = fileURLToPath(new URL('./directory-html-host/node_modules/', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function directoryHtmlDependencyIdentity() {
  const records = []; let bytes = 0;
  async function walk(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || await realpath(path) !== path) throw Error('directory_parser_dependency_invalid');
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    } else {
      if (!stat.isFile() || stat.nlink !== 1 || records.length >= 128 || (bytes += stat.size) > 1024 * 1024)
        throw Error('directory_parser_dependency_invalid');
      records.push([relative(root, path), digest(await readFile(path))]);
    }
  }
  try {
    for (const name of ['entities', 'parse5']) await walk(join(root, name));
    records.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    if (records.length !== DIRECTORY_HTML_DEPENDENCIES.files || bytes !== DIRECTORY_HTML_DEPENDENCIES.bytes
      || digest(JSON.stringify(records)) !== DIRECTORY_HTML_DEPENDENCIES.sha256) throw Error('directory_parser_dependency_invalid');
    return DIRECTORY_HTML_DEPENDENCIES;
  } catch { throw Error('directory_parser_dependency_invalid'); }
}
