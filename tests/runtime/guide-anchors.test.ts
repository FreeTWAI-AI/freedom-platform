import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DRAGON_GUIDES } from '../../apps/portal-web/src/modules/newcomer-guides/packs/dragon/guide-data.js';

const portal = path.resolve('apps/portal-web/src');
const moduleRoot = path.join(portal, 'modules');
const pages = ['home', 'guilds', 'skills', 'messages', 'events', 'tasks', 'members', 'friends', 'highlights', 'positioning', 'squads', 'cocreation', 'social', 'services', 'promotion', 'workbench', 'opensource', 'showcase', 'engagement', 'supplier', 'retail', 'marketing', 'guild-workspace', 'community', 'account', 'todos'];

// Read the actual JSX declarations, including role/data-conditional anchors.
// This catches selector drift without requiring a database or accepting a
// translated label, CSS class, or positional match as a substitute target.
function anchorDeclarations() {
  const declarations = new Map<string, string[]>();
  const files = [path.join(portal, 'App.tsx'), ...readdirSync(moduleRoot).filter(name => name.endsWith('.tsx')).map(name => path.join(moduleRoot, name))];
  for (const filename of files) {
    const source = readFileSync(filename, 'utf8');
    // Anchor values must be a literal or a simple conditional of literals;
    // runtime-computed selectors deliberately do not satisfy this contract.
    for (const match of source.matchAll(/\bdata-guide-anchor=(?:"([^"]+)"|'([^']+)'|\{([^{}]*)\})/g)) {
      const values = match[1] || match[2] ? [match[1] || match[2]]
        : [...match[3].matchAll(/['"]([a-z-]+:[a-z-]+)['"]/g)].map(value => value[1]);
      for (const value of values) {
        const locations = declarations.get(value) ?? [];
        locations.push(path.relative(portal, filename));
        declarations.set(value, locations);
      }
    }
  }
  return declarations;
}

test('dragon guides retain the 26 supported pages and exclude unsupported private AI', () => {
  assert.deepEqual(Object.keys(DRAGON_GUIDES).sort(), [...pages].sort());
  assert.equal(Object.hasOwn(DRAGON_GUIDES, 'private-ai'), false);
  assert.equal(Object.values(DRAGON_GUIDES).reduce((count, topics) => count + Object.keys(topics).length, 0), 45);
});

test('all 48 guide steps use a unique, declared anchor in their own page namespace', () => {
  const declarations = anchorDeclarations();
  const used = new Set<string>();
  let steps = 0;
  for (const [page, topics] of Object.entries(DRAGON_GUIDES)) {
    for (const [topic, guide] of Object.entries(topics)) {
      assert.ok(topic.startsWith(`${page}:`), topic);
      assert.ok(guide.label.trim(), topic);
      assert.ok(guide.steps.length, topic);
      for (const step of guide.steps) {
        const match = /^\[data-guide-anchor="([a-z-]+:[a-z-]+)"\]$/.exec(step.selector);
        assert.ok(match, `${topic}: ${step.selector}`);
        const anchor = match[1];
        assert.ok(anchor.startsWith(`${page}:`), anchor);
        assert.equal(used.has(anchor), false, `guide reuses ${anchor}`);
        assert.equal(declarations.get(anchor)?.length, 1, `${anchor}: ${JSON.stringify(declarations.get(anchor))}`);
        assert.ok(step.instruction.trim(), topic);
        used.add(anchor);
        steps += 1;
      }
    }
  }
  assert.equal(steps, 48);
});

test('friendship guidance points to the list rather than another member’s contextual action', () => {
  const invitation = DRAGON_GUIDES.members['members:topic-2'];
  assert.equal(invitation.steps[0].selector, '[data-guide-anchor="members:directory"]');
  assert.match(invitation.steps[0].instruction, /尚未成為好友且未送出邀請/);
  assert.match(invitation.steps[0].instruction, /由你決定是否發出/);
  assert.doesNotMatch(readFileSync(path.join(moduleRoot, 'Membership.tsx'), 'utf8'), /data-guide-anchor="members:(?:invite|request)"/);
});

test('permission and data dependent targets remain attached to the existing conditional UI', () => {
  const app = readFileSync(path.join(portal, 'App.tsx'), 'utf8');
  assert.match(app, /<section[^>]*data-guide-anchor=\{guideAnchor\}/);
  const workspace = readFileSync(path.join(moduleRoot, 'GuildWorkspace.tsx'), 'utf8');
  assert.match(workspace, /available\.length>0&&<nav[^>]*data-guide-anchor="guild-workspace:management"/);
  const positioning = readFileSync(path.join(moduleRoot, 'PositioningPanels.tsx'), 'utf8');
  assert.match(positioning, /!summaryLoading&&!summaryError&&assessment&&member&&<section/);
  assert.match(positioning, /<h2 id="positioning-result-title" data-guide-anchor="positioning:result"/);
  const events = readFileSync(path.join(moduleRoot, 'EventsPanel.tsx'), 'utf8');
  assert.match(events, /<button[^>]*data-guide-anchor="events:submit-event"[^\n]*>＋ 提交活動<\/button>/);
});
