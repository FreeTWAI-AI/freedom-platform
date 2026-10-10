import test from 'node:test';
import assert from 'node:assert/strict';
import {NOTIFICATION_KINDS, type NotificationKind} from '../../modules/member-communications/types.js';
import {PAGE_GITHUB_EVENT_KINDS} from '../../modules/development/page-github.js';
import {
  CONSOLE_EXCLUDED_FACTS, CONSOLE_MESSAGE_CHANNELS, GITHUB_CONSOLE_KINDS,
  bulletinConsoleChannel, consoleChannel, githubConsoleChannel, githubConsoleMessage, notificationConsoleChannel,
} from '../../apps/portal-web/src/game-console-routing.js';

const NOTIFICATION_CHANNELS: Record<NotificationKind, 'system'> = {
  friend_request: 'system', friend_accepted: 'system', friend_declined: 'system', squad_invitation: 'system',
  guild_application_approved: 'system', guild_application_rejected: 'system',
  guild_expert_appointed: 'system', guild_expert_revoked: 'system',
  guild_master_appointed: 'system', guild_master_revoked: 'system',
  guild_member_promoted: 'system', guild_member_demoted: 'system',
  event_submitted: 'system', event_review_needed: 'system', event_approved: 'system', event_rejected: 'system',
  squad_member_removed: 'system', social_post_commented: 'system', social_post_liked: 'system', squad_join_requested: 'system', squad_join_accepted: 'system',
};

test('every console source maps to the channel a member should read',()=>{
  assert.deepEqual(GITHUB_CONSOLE_KINDS, PAGE_GITHUB_EVENT_KINDS);
  assert.equal(consoleChannel('world_chat'), 'world_chat');
  assert.equal(consoleChannel('chat_sent_world'), 'world_chat');
  assert.equal(consoleChannel('guild_chat'), 'guild');
  assert.equal(consoleChannel('chat_sent_guild'), 'guild');
  assert.equal(consoleChannel('guild_announcement'), 'guild');
  assert.equal(consoleChannel('squad_chat'), 'squad');
  assert.equal(consoleChannel('chat_sent_squad'), 'squad');
  assert.equal(consoleChannel('direct_chat'), 'direct');
  assert.equal(consoleChannel('chat_sent_direct'), 'direct');
  for (const source of ['guide_navigation','guide_next_step','guide_keyboard','guide_popup_blocked','guide_ai_intro','guide_welcome'] as const) assert.equal(consoleChannel(source), 'guide');
  for (const source of ['system_connected','system_page_error','system_background_error','system_network','system_api_error','skill_published','project_published','accepted_work'] as const) assert.equal(consoleChannel(source), 'system');
  assert.equal(consoleChannel('ai_prompt'), 'ai');
  assert.equal(bulletinConsoleChannel('submitted'), 'system');
  assert.equal(bulletinConsoleChannel('approved'), 'system');
  assert.equal(bulletinConsoleChannel('rejected'), 'system');
  assert.equal(bulletinConsoleChannel(undefined), 'system');
  for (const kind of NOTIFICATION_KINDS) {
    assert.equal(notificationConsoleChannel(kind), NOTIFICATION_CHANNELS[kind]);
    assert.equal(CONSOLE_MESSAGE_CHANNELS[`notification_${kind}`], 'system');
  }
  assert.equal(notificationConsoleChannel(undefined), 'system');
  assert.equal(notificationConsoleChannel('not-a-kind'), 'system');
  for (const kind of PAGE_GITHUB_EVENT_KINDS) assert.equal(githubConsoleChannel(kind), 'system');
  assert.equal(githubConsoleChannel('page_opened'), 'system');
  assert.notEqual(githubConsoleChannel('page_opened'), 'world_chat');
  for (const fact of CONSOLE_EXCLUDED_FACTS) assert.equal(Object.hasOwn(CONSOLE_MESSAGE_CHANNELS, fact), false);
  assert.equal(githubConsoleMessage({actor:'contributor-demo',kind:'pr_opened',title:'改善手機導覽',number:13}), 'contributor-demo 提交 PR：改善手機導覽（#13）');
  assert.equal(githubConsoleMessage({actor:'member',kind:'pr_merged',title:'改善手機導覽',number:13}), 'member 合併 PR：改善手機導覽（#13）');
  assert.equal(githubConsoleMessage({actor:'member',kind:'pr_closed',title:'關閉說明',number:17}), 'member 關閉 PR：關閉說明（#17）');
  assert.equal(githubConsoleMessage({actor:'member',kind:'issue_closed',title:'Issue #4',number:4}), 'member 關閉 Issue（#4）');
  assert.equal(githubConsoleMessage({actor:'member',kind:'release_published',title:'v1.2.0',number:null}), 'member 發布版本：v1.2.0');
  assert.equal(githubConsoleMessage({actor:'member',kind:'issue_opened',title:'首頁',number:12}), 'member 提出 Issue：首頁（#12）');
});
