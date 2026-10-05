// Fixed host inputs and oracle. No candidate modules, test declarations or reports.
import { randomUUID, createHash } from 'node:crypto';
import { renderDirectory } from './directory-reference/index.mjs';
import { renderPrivacyPage } from './directory-reference/privacy.mjs';

export const DIRECTORY_REPOSITORY = 'FreeTWAI-AI/FreeTWAI-AI.github.io';
export const DIRECTORY_BUILD_CASES = Object.freeze(['candidate-data', 'escaped-challenge', 'empty-directory',
  'duplicate-repository', 'invalid-directory-schema', 'invalid-privacy-section',
  'traversal-path', 'absolute-path', 'encoded-path', 'malformed-privacy-json']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value) + '\n';
export function directoryBuildCases(directoryText, privacyText) {
  const directory = JSON.parse(directoryText), privacy = JSON.parse(privacyText);
  // Current deployment has a fixed directory footer link to this route.
  if (privacy.path !== 'privacy/discord-bot/') throw Error('directory_data_invalid');
  const current = { directory, privacy };
  const marker = randomUUID();
  const hostile = `${marker} <script>alert("&'")</script>`;
  const language = suffix => ({ title: hostile + suffix, effective: '2026-10-05', eyebrow: hostile,
    sections: [{ h: hostile, blocks: [{ p: hostile }, { ul: [hostile, 'https://example.invalid/help', 'support@example.invalid'] }] }] });
  const challenge = { directory: { schema_version: 'freedom.source-directory/v1', organization: 'FreeTWAI-AI', projects: [
    { repository: 'probe-' + marker, name: hostile, description: hostile, scope: hostile },
    { repository: '.github', name: '組織', description: '說明', scope: '範圍' },
  ] }, privacy: { schema_version: 'freetwai.privacy-page/v1', path: 'privacy/discord-bot/', effective_date: '2026-10-05',
    zh: language(' 中文'), en: language(' English') } };
  return DIRECTORY_BUILD_CASES.map((id, index) => {
    const data = structuredClone(index === 0 ? current : challenge);
    if (id === 'empty-directory') data.directory.projects = [];
    if (id === 'duplicate-repository') data.directory.projects.push({ ...data.directory.projects[0], repository: data.directory.projects[0].repository.toUpperCase() });
    if (id === 'invalid-directory-schema') data.directory.schema_version = 'unapproved';
    if (id === 'invalid-privacy-section') data.privacy.en.sections = [];
    if (id === 'traversal-path') data.privacy.path = '../escaped/';
    if (id === 'absolute-path') data.privacy.path = '/escaped/';
    if (id === 'encoded-path') data.privacy.path = '%2e%2e/escaped/';
    const succeeds = index < 3;
    const outputs = succeeds ? { 'dist/index.html': digest(renderDirectory(data.directory)),
      'dist/privacy/discord-bot/index.html': digest(renderPrivacyPage(data.privacy)) } : {};
    return { id, succeeds, overrides: index === 0 ? {} : {
      'data/directory.json': json(data.directory),
      'data/privacy-discord-bot.json': id === 'malformed-privacy-json' ? '{"broken":' : json(data.privacy),
    }, outputs };
  });
}

/** Compare daemon-captured filesystem hashes, never candidate stdout assertions. */
export function checkDirectoryBuildArchive(archive, sourceRecords, scenario, exitCode) {
  const files = Object.fromEntries(sourceRecords);
  for (const [path, bytes] of Object.entries(scenario.overrides)) files[path] = digest(bytes);
  Object.assign(files, scenario.outputs);
  const directories = new Set(['work']);
  for (const path of Object.keys(files)) {
    const parts = ('work/' + path).split('/');
    for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join('/'));
  }
  const expected = Object.entries(files).map(([path, sha256]) => ['work/' + path, sha256]).sort();
  return Number.isInteger(exitCode) && (scenario.succeeds ? exitCode === 0 : exitCode === 1)
    && JSON.stringify(archive.files) === JSON.stringify(expected)
    && JSON.stringify(archive.directories) === JSON.stringify([...directories].sort());
}
