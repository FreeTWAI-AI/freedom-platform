import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, relative, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = 'apps/portal-web/src/guild-blocks/registry.generated.ts';
const serverCatalog = 'packages/guild-presentation/catalog.generated.ts';
export function collectGuildBlocks(descriptors) {
  const entries = new Map();
  for (const descriptor of descriptors) for (const surface of descriptor.surfaces ?? []) {
    if (!surface.surface_id.startsWith('guild-block.')) continue;
    if (!/^guild-block\.[a-z][a-z0-9-]*\.v[1-9][0-9]*$/.test(surface.surface_id)
      || surface.kind !== 'page' || surface.auth_profile !== 'member-session'
      || !descriptor.public_exports.includes(surface.entry)
      || !descriptor.owned_paths.some(path => path === surface.entry || path.endsWith('/**') && surface.entry.startsWith(path.slice(0, -2)))
      || !/^modules\/[a-z0-9-]+\/[A-Za-z0-9/_-]+\.tsx$/.test(surface.entry)
      || surface.entry.split('/').includes('..') || !surface.operations?.length) throw new Error(`Invalid guild block: ${surface.surface_id}`);
    if (entries.has(surface.surface_id)) throw new Error(`Duplicate guild block: ${surface.surface_id}`);
    entries.set(surface.surface_id, {id: surface.surface_id, entry: surface.entry, module_id: descriptor.module_id});
  }
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function renderRegistry(entries) {
  const imports = entries.map(item => {
    const path = relative(dirname(generated), item.entry).replace(/\.tsx$/, '');
    return `  ${JSON.stringify(item.id)}: () => import(${JSON.stringify(path)}),`;
  });
  return `// Generated from existing freedom.module.json surfaces; do not edit.\nimport type {GuildBlockModule} from './runtime';\n\nexport const guildBlockLoaders: Readonly<Record<string, () => Promise<GuildBlockModule>>> = {\n${imports.join('\n')}\n};\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd: root, encoding: 'utf8'}).split('\0');
  const descriptors = [...new Set(files.filter(path => /(^|\/)freedom\.module\.json$/.test(path)))].map(path => JSON.parse(readFileSync(resolve(root, path), 'utf8')));
  const entries = collectGuildBlocks(descriptors);
  for (const item of entries) if (!existsSync(resolve(root, item.entry))) throw new Error(`Missing guild block entry: ${item.entry}`);
  const outputs = new Map([
    [generated, renderRegistry(entries)],
    [serverCatalog, `// Generated metadata from existing module surfaces. No component code runs on the server.\nexport const APPROVED_GUILD_BLOCK_IDS: ReadonlySet<string> = new Set(${JSON.stringify(entries.map(item => item.id), null, 2)});\n`],
  ]);
  for (const [path, result] of outputs) {
    const target = resolve(root, path);
    if (process.argv.includes('--check')) {
      if (!existsSync(target) || readFileSync(target, 'utf8') !== result) throw new Error('Guild block registry is stale; run node scripts/generate-guild-blocks.mjs');
    } else writeFileSync(target, result);
  }
  console.log(`${entries.length} guild blocks from existing module descriptors`);
}
