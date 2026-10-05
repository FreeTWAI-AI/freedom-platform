// Requires the explicit host-only parser install used by the directory profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { renderDirectory } from '../../packages/contribution-tools/directory-reference/index.mjs';
import { renderPrivacyPage } from '../../packages/contribution-tools/directory-reference/privacy.mjs';
import { directoryBuildCases, checkDirectoryBuildArchive } from '../../packages/contribution-tools/directory-build-fixture.mjs';
import { verifyDirectoryHtml } from '../../packages/contribution-tools/directory-html-profile.mjs';
import { directoryHtmlDependencyIdentity } from '../../packages/contribution-tools/directory-html-dependencies.mjs';
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';

const directory = { schema_version: 'freedom.source-directory/v1', organization: 'FreeTWAI-AI', projects: [
  { repository: 'one', name: 'First public project', description: 'First description <&>', scope: 'First public scope' },
  { repository: 'two', name: 'Second public project', description: 'Second description', scope: 'Second public scope' },
] };
const language = suffix => ({ title: 'Policy ' + suffix, eyebrow: 'Public ' + suffix, effective: 'Effective 2026 ' + suffix,
  sections: [{ h: 'Section ' + suffix, blocks: [{ p: 'Paragraph ' + suffix },
    { ul: ['Item ' + suffix, 'https://example.invalid/help', 'support@example.invalid'] }] }] });
const privacy = { schema_version: 'freetwai.privacy-page/v1', path: 'privacy/discord-bot/', effective_date: '2026-10-05',
  zh: language('中文'), en: language('English') };
const html = renderDirectory(directory), policy = renderPrivacyPage(privacy);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const accepts = (kind, value, input) => assert.equal(verifyDirectoryHtml(kind, value, input).status, 'passed');
const denies = (kind, value, input) => assert.throws(() => verifyDirectoryHtml(kind, value, input), /^Error: directory_/);

test('reviewed renderers, empty directory and independent random per-field challenges satisfy semantic profile', () => {
  for (const scenario of directoryBuildCases(JSON.stringify(directory), JSON.stringify(privacy)).filter(item => item.succeeds)) {
    for (const output of Object.values(scenario.outputs)) accepts(output.kind,
      output.kind === 'directory' ? renderDirectory(output.data) : renderPrivacyPage(output.data), output.data);
  }
});
test('legitimate CSS, wrappers, classes, accessibility and equivalent entity changes pass without reference bytes', () => {
  const changed = html.replace('color:#153c33', 'color:#223344').replace('max-width:1120px', 'max-width:960px')
    .replace('<main>', '<main id="content" role="main" tabindex="-1">')
    .replaceAll('<article>', '<div role="article" class="redesigned-card">').replaceAll('</article>', '</div>')
    .replace('<h1>', '<h1 id="heading">').replace('<header class="intro">', '<header class="intro" aria-labelledby="heading">')
    .replaceAll('&lt;', '&#60;').replaceAll('&gt;', '&#62;');
  assert.notEqual(changed, html); accepts('directory', changed, directory);
  const changedPolicy = policy.replace('padding:32px', 'padding:28px').replaceAll('<section ', '<div role="region" ')
    .replaceAll('</section>', '</div>').replace('<main>', '<main aria-label="Privacy policy">');
  assert.notEqual(changedPolicy, policy); accepts('privacy', changedPolicy, privacy);
  accepts('directory', html.replace('First public project', 'First<br>public project')
    .replace('Second public project', '<div>Second public</div><div>project</div>')
    .replaceAll('noopener noreferrer', 'NoOpener NoReferrer').replace('name="referrer"', 'name="Referrer"'), directory);
});
test('constant or missing/swapped public fields are rejected even with correct page shell and links', () => {
  denies('directory', '<!doctype html><html><head></head><body>passed</body></html>', directory);
  denies('directory', html.replace('First description &lt;&amp;&gt;', 'omitted'), directory);
  denies('directory', html.replace('First public scope', 'Second public scope').replace('<p class="scope">Second public scope</p></article>', '<p class="scope">First public scope</p></article>'), directory);
  denies('directory', html.replace('https://github.com/FreeTWAI-AI/one', 'https://github.com/FreeTWAI-AI/two'), directory);
  denies('privacy', policy.replace('Paragraph English', 'omitted'), privacy);
  denies('privacy', policy.replaceAll('lang="en"', 'lang="zh-Hant"'), privacy);
});
test('data cannot become executable HTML, foreign namespace or event handlers', () => {
  for (const injection of ['<script>alert(1)</script>', '<img src="https://evil.invalid/x">', '<svg onload="alert(1)"></svg>',
    '<iframe srcdoc="x"></iframe>', '<object data="https://evil.invalid"></object>', '<div onclick="alert(1)">x</div>']) {
    denies('directory', html.replace('</body>', injection + '</body>'), directory);
  }
  const input = structuredClone(directory); input.projects[0].name = '<script>alert(1)</script>';
  denies('directory', renderDirectory(input).replace('&lt;script&gt;alert(1)&lt;/script&gt;', input.projects[0].name), input);
});
test('encoded, hidden, unexpected and broken URLs cannot evade HTML5 tree validation', () => {
  for (const href of ['javascript:alert(1)', '&#106;avascript:alert(1)', 'java&#x09;script:alert(1)',
    'https://evil.invalid/public-data', '//evil.invalid/', 'data:text/html,evil']) {
    denies('directory', html.replace('</body>', '<a hidden href="' + href + '">link</a></body>'), directory);
  }
  denies('directory', html.replace('privacy/discord-bot/', 'privacy/wrong/'), directory);
  denies('directory', html.replace('</body>', '<a href="#missing">jump</a></body>'), directory);
  denies('privacy', policy.replace('https://example.invalid/help', 'https://evil.invalid/help'), privacy);
  denies('privacy', policy.replace('mailto:support@example.invalid', 'mailto:attacker@example.invalid'), privacy);
  denies('directory', html.replace('rel="noopener noreferrer"', 'target="_blank"'), directory);
  denies('directory', html.replace('<main>', '<main aria-labelledby="missing">'), directory);
  denies('directory', html.replace('<a href="privacy/discord-bot/">', '<a hidden href="privacy/discord-bot/">'), directory);
  const hiddenLink = policy.replaceAll('<a href="https://example.invalid/help" rel="noopener noreferrer">https://example.invalid/help</a>',
    '<a hidden href="https://example.invalid/help" rel="noopener noreferrer">hidden</a>https://example.invalid/help');
  denies('privacy', hiddenLink, privacy);
});
test('CSS freedom retains no-weaker CSP, early enforcement and private referrer policy', () => {
  const variants = [
    html.replace("default-src 'none'", "default-src *"),
    html.replace("style-src 'unsafe-inline'", "style-src 'unsafe-inline' https:"),
    html.replace("form-action 'none'", "form-action 'none'; img-src https:"),
    html.replace('Content-Security-Policy', 'refresh'),
    html.replace('<head>', '<head><style>@import "https://evil.invalid/style";</style>'),
    html.replace('</head>', '<meta name="referrer" content="unsafe-url"></head>'),
    html.replace('<meta charset="utf-8">', '<meta charset="utf-16">'),
  ];
  for (const value of variants) denies('directory', value, directory);
  accepts('directory', html.replace("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'; default-src 'none'; connect-src 'none'"), directory);
});
test('malformed, deep and oversized HTML fail closed instead of recovering into a passing profile', () => {
  denies('directory', html.replace('<main>', '<main id="a" id="b">'), directory);
  denies('directory', html.replace('<main>', '<main>' + '<div>'.repeat(130)).replace('</main>', '</div>'.repeat(130) + '</main>'), directory);
  denies('directory', html + ' '.repeat(2 * 1024 * 1024), directory);
});

const reader = fileURLToPath(new URL('../../packages/contribution-tools/directory-build-archive.py', import.meta.url));
function observe(files) {
  const tar = execFileSync('/usr/bin/python3', ['-I', '-c', `
import sys,json,io,tarfile
files=json.load(sys.stdin); out=io.BytesIO(); dirs={'work'}
for path in files:
 parts=('work/'+path).split('/')
 for n in range(1,len(parts)): dirs.add('/'.join(parts[:n]))
with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as archive:
 for path in sorted(dirs):
  item=tarfile.TarInfo(path); item.type=tarfile.DIRTYPE; archive.addfile(item)
 for path,value in sorted(files.items()):
  data=value.encode(); item=tarfile.TarInfo('work/'+path); item.size=len(data); archive.addfile(item,io.BytesIO(data))
sys.stdout.buffer.write(out.getvalue())`], { input: JSON.stringify(files), env: verificationEnvironment(), maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(execFileSync('/usr/bin/python3', ['-I', reader, '--html'], { input: tar, env: verificationEnvironment(), maxBuffer: 6 * 1024 * 1024 }));
}
test('trusted archive supplies bounded real bytes; semantic verdict binds to every input and output hash', () => {
  const scenario = directoryBuildCases(JSON.stringify(directory), JSON.stringify(privacy))[0];
  const source = { 'data/directory.json': JSON.stringify(directory), 'data/privacy-discord-bot.json': JSON.stringify(privacy) };
  const records = Object.entries(source).map(([path, value]) => [path, digest(value)]);
  const files = { ...source, 'dist/index.html': html.replace('color:#153c33', 'color:rebeccapurple'), 'dist/privacy/discord-bot/index.html': policy };
  const archive = observe(files);
  assert.equal(Object.keys(archive.html).length, 2);
  assert(checkDirectoryBuildArchive(archive, records, scenario, 0));
  const swapped = structuredClone(archive); swapped.html['work/dist/index.html'] = Buffer.from('passed').toString('base64');
  assert.equal(checkDirectoryBuildArchive(swapped, records, scenario, 0), false);
  assert.equal(checkDirectoryBuildArchive(observe({ ...files, 'extra.html': 'extra' }), records, scenario, 0), false);
  assert.equal(checkDirectoryBuildArchive(observe({ ...files, 'data/directory.json': '{}' }), records, scenario, 0), false);
  assert.equal(checkDirectoryBuildArchive(archive, records, scenario, 1), false);
  const invalid = directoryBuildCases(JSON.stringify(directory), JSON.stringify(privacy))[3];
  assert.equal(checkDirectoryBuildArchive(archive, records, invalid, 1), false);
});
test('host-only parser bytes are exact and prior tampering is rejected independently of a self-reported digest', async () => {
  assert.equal((await directoryHtmlDependencyIdentity()).sha256, '23432fe7cdf370e67a8289a1cce223d6c23cf2969550a7f9864c40b353caa9be');
  const path = new URL('../../packages/contribution-tools/directory-html-host/node_modules/parse5/dist/index.js', import.meta.url);
  const original = await readFile(path);
  try {
    await writeFile(path, Buffer.concat([original, Buffer.from('\n// altered before host observation\n')]));
    await assert.rejects(directoryHtmlDependencyIdentity(), /directory_parser_dependency_invalid/);
  } finally { await writeFile(path, original); }
  assert.equal((await directoryHtmlDependencyIdentity()).files, 91);
});
