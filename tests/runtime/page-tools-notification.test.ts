import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const tools=readFileSync('apps/portal-web/src/PageTools.tsx','utf8');
const toolCss=readFileSync('apps/portal-web/src/PageTools.css','utf8');
const bell=readFileSync('apps/portal-web/src/modules/NotificationBell.tsx','utf8');
const bellCss=readFileSync('apps/portal-web/src/modules/NotificationBell.css','utf8');
const shell=readFileSync('apps/portal-web/src/LayoutDesign.css','utf8');
const rpg=readFileSync('apps/portal-web/src/rpg-theme.css','utf8');

test('the idea page tool shows 提出想法 inside the same accessible name',()=>{
  assert.match(tools,/idea:'提出想法'/);
  assert.match(tools,/page-tool-button--\$\{item\}/);
  assert.match(tools,/aria-label=\{names\[item\]\}/);
  assert.match(tools,/className="page-tool-label">提出想法</);
  assert.doesNotMatch(toolCss,/drop-shadow|rgba\(196,\s*255,\s*32/);
  assert.match(toolCss,/html \.page-tool-button--idea\{[^}]*background:var\(--green\)/);
  assert.match(toolCss,/\.page-tool-button--idea\{[^}]*min-width:44px/);
  assert.match(toolCss,/\.page-tool-button\{[^}]*height:44px/);
});

test('top-bar icon buttons share one 44px box and the profile avatar stays 36px',()=>{
  assert.match(bell,/width="20" height="20"/);
  assert.match(bellCss,/\.notification-bell-trigger\{[^}]*height:44px/);
  assert.match(bellCss,/\.notification-bell-trigger svg\{width:20px;height:20px/);
  assert.match(shell,/\.topbar-actions \.btn \{[^}]*height: 44px/);
  assert.match(rpg,/\.topbar-actions \.btn\{[^}]*height:44px/);
  assert.match(rpg,/\.topbar \.member-avatar\.topbar-avatar\{width:36px;height:36px/);
});
