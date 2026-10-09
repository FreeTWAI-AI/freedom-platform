import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Navigation, TAB_TITLES} from '../../apps/portal-web/src/Navigation.js';
import {interfaceText, LANGUAGES} from '../../apps/portal-web/src/language.js';

test('buyer order navigation uses the order-list label in every supported language', () => {
  assert.deepEqual(LANGUAGES.map(([language]) => interfaceText(language, 'nav.reservations')),
    ['我的訂單', 'My orders', '注文履歴', '내 주문', 'Mis pedidos']);
  assert.equal(interfaceText('zh-Hant', 'nav.reservations'), TAB_TITLES.reservations);
  const markup = renderToStaticMarkup(createElement(Navigation, {current: 'reservations', onSelect() {},
    canManageGuild: false, guildLaunchpadEnabled: false, communitySearchEnabled: false, mobileOpen: true}));
  assert.match(markup, /我的訂單/);
  assert.doesNotMatch(markup, /查詢我的預留/);
});
