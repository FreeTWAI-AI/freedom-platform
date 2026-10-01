import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';
import { E2E_AUTHOR_CLAIM_ADMIN_EMAIL, E2E_AUTHOR_CLAIM_ADMIN_TOKEN } from '../../packages/testing/e2e-admin.js';

const REPO = '05800000-0000-4000-8000-000000000001';
const PULL_LOW = '05800000-0000-4000-8000-000000000011';
const PULL_HIGH = '05800000-0000-4000-8000-000000000012';
const PULL_AUTHOR = '05800000-0000-4000-8000-000000000013';
const PULL_CI = '05800000-0000-4000-8000-000000000014';
const PULL_READY = '05800000-0000-4000-8000-000000000015';
const USER_SELF = '05800000-0000-4000-8000-000000000031';
const USER_OTHER = '05800000-0000-4000-8000-000000000032';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OTHER_EMAIL = 'e2e-maintainer-other@example.invalid';
const GUILD = 'guild_ai_vibe';

async function wipe(pool: { query: (text: string, values?: unknown[]) => Promise<unknown> }) {
  await pool.query(`DELETE FROM platform_admin_audit WHERE target_ref IN (
    SELECT pull_id::text FROM maintainer_pull_requests WHERE repository_id=$1
    UNION SELECT claim_id::text FROM maintainer_review_claims c
      JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id WHERE p.repository_id=$1
    UNION SELECT $1::text)`, [REPO]);
  await pool.query(`DELETE FROM platform_admin_receipts WHERE operation LIKE '%/review-center/%' AND admin_id IN (
    SELECT admin_id FROM platform_admins WHERE email=$1)`, [E2E_AUTHOR_CLAIM_ADMIN_EMAIL]);
  await pool.query('DELETE FROM maintainer_jobs WHERE repository_id=$1', [REPO]);
  await pool.query(`DELETE FROM maintainer_review_claims WHERE pull_id IN (
    SELECT pull_id FROM maintainer_pull_requests WHERE repository_id=$1)`, [REPO]);
  await pool.query('DELETE FROM maintainer_ownership_changes WHERE repository_id=$1', [REPO]);
  await pool.query('DELETE FROM maintainer_handoffs WHERE repository_id=$1', [REPO]);
  await pool.query('DELETE FROM maintainer_pull_requests WHERE repository_id=$1', [REPO]);
  await pool.query('DELETE FROM maintainer_repositories WHERE repository_id=$1', [REPO]);
  await pool.query('DELETE FROM github_social_connections WHERE user_id=ANY($1::uuid[]) OR github_user_id=ANY($2::text[])', [[USER_SELF, USER_OTHER], ['77010001', '77010002']]);
  await pool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[]) OR email=ANY($2::text[])', [[USER_SELF, USER_OTHER], [E2E_AUTHOR_CLAIM_ADMIN_EMAIL, OTHER_EMAIL]]);
}

function countOf(page: Page, label: string) {
  return page.locator('.review-counts > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');
}

async function tokenBackground(page: Page, token: string) {
  return page.evaluate(name => {
    const host = document.querySelector('.review-center');
    if (!host) throw new Error('找不到審核中心');
    const probe = document.createElement('span');
    probe.style.background = `var(${name})`;
    host.appendChild(probe);
    try {
      return getComputedStyle(probe).backgroundColor;
    } finally {
      probe.remove();
    }
  }, token);
}

async function paint(locator: { evaluate: (fn: (element: Element) => string) => Promise<string> }) {
  return locator.evaluate(element => getComputedStyle(element).backgroundColor);
}

async function expectReviewBadgeColours(page: Page, theme: string) {
  const waiting = page.locator(`[data-pull-id="${PULL_LOW}"] span.badge`, { hasText: '待審' });
  const open = page.locator(`[data-pull-id="${PULL_LOW}"] span.badge-open`, { hasText: '開放認領' });
  await expect(waiting).toBeVisible();
  await expect(open).toBeVisible();
  const info = await tokenBackground(page, '--info-bg');
  const danger = await tokenBackground(page, '--danger-bg');
  const blue = await tokenBackground(page, '--module-blue-tint');
  const waitingBg = await paint(waiting);
  const openBg = await paint(open);
  expect(waitingBg).not.toBe(openBg);
  expect(waitingBg).not.toBe(danger);
  expect(openBg).not.toBe(danger);
  if (theme !== 'dark') {
    expect(waitingBg).toBe(info);
    expect(openBg).toBe(blue);
  }
  const low = page.locator(`[data-pull-id="${PULL_LOW}"]`);
  const detailButton = low.getByRole('button', { name: '詳情', exact: true });
  if (await detailButton.count()) await detailButton.click();
  const invalid = low.locator('span.badge-alert', { hasText: '不算有效核准' });
  await expect(invalid).toBeVisible();
  const invalidBg = await paint(invalid);
  const invalidInk = await invalid.evaluate(element => getComputedStyle(element).color);
  expect(invalidBg).toBe(danger);
  expect(invalidInk).not.toBe(invalidBg);
  expect(invalidBg).not.toBe(waitingBg);
  expect(invalidBg).not.toBe(openBg);
  await low.getByRole('button', { name: '收合', exact: true }).click();
}

test('an admin claims, assigns, pauses and reads the review center on desktop and phone', async ({ page, e2eAuthPool }) => {
  test.setTimeout(120_000);
  await wipe(e2eAuthPool);
  const previousOfficer = (await e2eAuthPool.query(
    'SELECT user_id FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2',
    [DEMO_COMMUNITY, GUILD],
  )).rows[0] as { user_id: string } | undefined;
  await e2eAuthPool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)
    ON CONFLICT(email) DO UPDATE SET active=true, community_id=EXCLUDED.community_id, display_name=EXCLUDED.display_name`,
  ['05800000-0000-4000-8000-000000000041', DEMO_COMMUNITY, E2E_AUTHOR_CLAIM_ADMIN_EMAIL, '認領審核員']);
  await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,email_verified_at)
    SELECT $1, community_id, $2, $3, password_hash, $4, now() FROM users WHERE user_id=$5`,
  [USER_SELF, E2E_AUTHOR_CLAIM_ADMIN_EMAIL, '維護審查者', '05800000-0000-4000-8000-000000000051', DEMO_USERS[0].user_id]);
  await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,email_verified_at)
    SELECT $1, community_id, $2, $3, password_hash, $4, now() FROM users WHERE user_id=$5`,
  [USER_OTHER, OTHER_EMAIL, '另一位審查者', '05800000-0000-4000-8000-000000000052', DEMO_USERS[0].user_id]);
  await e2eAuthPool.query(`INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens)
    VALUES ($1,$2,'77010001','e2e-reviewer','e2e-placeholder-not-a-token'), ($3,$2,'77010002','e2e-reviewer-two','e2e-placeholder-not-a-token')`,
  [USER_SELF, DEMO_COMMUNITY, USER_OTHER]);
  await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state)
    VALUES ($1,$2,$3,$4,'active')`, [randomUUID(), DEMO_COMMUNITY, USER_OTHER, GUILD]);
  await e2eAuthPool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)
    ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=EXCLUDED.user_id`, [DEMO_COMMUNITY, GUILD, USER_OTHER]);
  await e2eAuthPool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, settings, open_to_guilds, next_sweep_at)
    VALUES ($1,$2,'910058','770058','FreeTWAI-AI/freedom-platform','main','active','observe','{"claim_hours":24}'::jsonb,true,'2099-01-01T00:00:00Z')`,
  [REPO, DEMO_COMMUNITY]);
  const pulls = [
    { id: PULL_LOW, number: 11, title: '文件修正', author: '88000011', login: 'docs-author', association: 'CONTRIBUTOR', type: 'User', fork: false, file: 'docs/guide.md', base: 'main', attention: [], queue: 'awaiting_review', queueCode: 'awaiting_review', queueMessage: '檢查已過，等公會長或管理員核准。', check: 'completed', conclusion: 'success', migration: [] },
    { id: PULL_HIGH, number: 12, title: '非預設分支的工作流程', author: '88000012', login: 'workflow-author', association: 'MEMBER', type: 'User', fork: false, file: '.github/workflows/verify.yml', base: 'release', attention: [{ code: 'sensitive', message: '改到 .github、授權或品牌等敏感檔案，合併前請親自看過。', paths: ['.github/workflows/verify.yml'] }], queue: 'needs_decision', queueCode: 'non_default_base', queueMessage: '這個 PR 不是要合併到預設分支，請公會長或管理員決定怎麼處理。', check: 'completed', conclusion: 'success', migration: [] },
    { id: PULL_AUTHOR, number: 13, title: '遷移編號衝突', author: '88000013', login: 'dependabot[bot]', association: 'NONE', type: 'Bot', fork: true, file: 'docs/note.md', base: 'main', attention: [], queue: 'needs_author', queueCode: 'migration_number_collision', queueMessage: '編號 001 已存在於 main。請改用下一個編號。', check: 'completed', conclusion: 'success', migration: [{ code: 'migration_number_collision', message: '編號 001 已存在於 main。請改用下一個編號。' }] },
    { id: PULL_CI, number: 14, title: '檢查還在跑', author: '88000014', login: 'ci-author', association: 'FIRST_TIME_CONTRIBUTOR', type: 'User', fork: false, file: 'docs/waiting.md', base: 'main', attention: [], queue: 'waiting_ci', queueCode: 'ci_running', queueMessage: '必要檢查還在跑，稍後會再看一次。', check: 'in_progress', conclusion: null, migration: [] },
  ];
  for (const pull of pulls) {
    await e2eAuthPool.query(`INSERT INTO maintainer_pull_requests (
      pull_id, repository_id, number, github_pull_id, title, html_url, state, is_draft, author_github_id, author_login, author_type,
      author_association, is_fork, head_sha, base_ref, base_sha, labels, additions, deletions, changed_files, github_created_at,
      github_updated_at, head_observed_at, attention_reasons, queue_state, queue_reasons, migration_reasons, policy_version, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,'open',false,$7,$8,$9,$10,$11,$12,$13,$14,'{}',1,0,1,now(),now(),now(),$15::jsonb,$16,$17::jsonb,$18::jsonb,'2026-10-01.1',now())`,
    [pull.id, REPO, pull.number, String(910000 + pull.number), pull.title, `https://github.com/FreeTWAI-AI/freedom-platform/pull/${pull.number}`,
      pull.author, pull.login, pull.type, pull.association, pull.fork, HEAD, pull.base, OLD,
      JSON.stringify(pull.attention), pull.queue,
      JSON.stringify([{ code: pull.queueCode, message: pull.queueMessage }]), JSON.stringify(pull.migration)]);
    await e2eAuthPool.query(`INSERT INTO maintainer_pull_files(pull_id, path, status, additions, deletions) VALUES ($1,$2,'modified',1,0)`, [pull.id, pull.file]);
    await e2eAuthPool.query(`INSERT INTO maintainer_checks(pull_id, head_sha, source, name, app_slug, status, conclusion)
      VALUES ($1,$2,'check_run','verify','github-actions',$3,$4)`, [pull.id, HEAD, pull.check, pull.conclusion]);
  }
  await e2eAuthPool.query(`INSERT INTO maintainer_reviews(pull_id, github_review_id, reviewer_github_id, reviewer_login, reviewer_type, reviewer_association, state, commit_id, submitted_at)
    VALUES ($1,'910091','88000099','old-commenter','User','MEMBER','APPROVED',$2,now())`, [PULL_LOW, OLD]);

  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/admin/api/**', async route => {
      const headers = { ...route.request().headers(), 'cf-access-jwt-assertion': E2E_AUTHOR_CLAIM_ADMIN_TOKEN };
      await route.continue({ headers });
    });
    await page.goto('/admin');
    await page.getByRole('button', { name: 'PR 審核', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'PR 審核', exact: true })).toBeVisible();
    await expect(countOf(page, '待審')).toHaveText('1');
    await expect(countOf(page, '審核中')).toHaveText('0');
    await expect(countOf(page, '等 CI')).toHaveText('1');
    await expect(countOf(page, '待作者')).toHaveText('1');
    await expect(countOf(page, '待決定')).toHaveText('1');
    await expect(countOf(page, '已核准')).toHaveText('0');
    await expect(page.getByRole('list', { name: '儲存庫模式' })).toContainText('FreeTWAI-AI/freedom-platform');
    await expect(page.getByRole('list', { name: '儲存庫模式' })).toContainText('觀察');
    const filterByGuild = async (label: string) => {
      const pending = page.waitForResponse(response => response.url().includes('/review-center/pulls') && response.ok());
      await page.getByLabel('歸屬篩選').selectOption({ label });
      await pending;
    };
    await filterByGuild('無歸屬');
    await expect(page.locator(`[data-pull-id="${PULL_LOW}"]`)).toBeVisible();
    await filterByGuild('AI 開發公會');
    await expect(page.getByText('這個佇列目前沒有拉取請求。', { exact: true })).toBeVisible();
    await filterByGuild('全部');
    await expect(page.locator(`[data-pull-id="${PULL_LOW}"]`)).toBeVisible();
    for (const theme of ['light', 'dark', 'versefolk']) {
      await page.evaluate(name => { document.documentElement.dataset.theme = name; }, theme);
      await expectReviewBadgeColours(page, theme);
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

    const low = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await expect(low).toContainText('開放認領');
    await expect(low).toContainText('無人認領');
    await expect(low).toContainText('docs-author');
    const github = low.getByRole('link', { name: /#11/ });
    await expect(github).toHaveAttribute('href', 'https://github.com/FreeTWAI-AI/freedom-platform/pull/11');
    await expect(github).toHaveAttribute('target', '_blank');
    await expect(github).toHaveAttribute('rel', 'noopener noreferrer');
    const detailToggle = low.getByRole('button', { name: '詳情', exact: true });
    const toggleBox = await detailToggle.boundingBox();
    const lowBox = await low.boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(lowBox).not.toBeNull();
    expect(toggleBox!.width).toBeLessThan(200);
    expect(toggleBox!.height).toBeGreaterThanOrEqual(44);
    const contentLeft = await low.evaluate(element => {
      const style = getComputedStyle(element);
      return element.getBoundingClientRect().left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
    });
    expect(Math.abs(toggleBox!.x - contentLeft)).toBeLessThan(1);
    await detailToggle.click();
    await expect(low.getByRole('link', { name: '到 GitHub 審查 ↗', exact: true })).toHaveAttribute('href', 'https://github.com/FreeTWAI-AI/freedom-platform/pull/11/files');
    const reviewLine = low.getByRole('listitem').filter({ hasText: 'old-commenter' });
    await expect(reviewLine).toContainText('old-commenter');
    await expect(reviewLine).toContainText('核准');
    await expect(reviewLine).toContainText('bbbbbbb');
    await expect(reviewLine).toContainText('舊提交');
    await expect(reviewLine).toContainText('不算有效核准');
    await expect(reviewLine).not.toContainText('APPROVED');
    await low.getByRole('button', { name: '我來審', exact: true }).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await expect(low).toHaveCount(0);
    await expect(countOf(page, '審核中')).toHaveText('1');

    await page.getByRole('tab', { name: '審核中', exact: true }).click();
    await expect(page.locator(`[data-pull-id="${PULL_LOW}"]`)).toContainText('審核中');
    await page.getByRole('tab', { name: '我認領的', exact: true }).click();
    const mine = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await expect(mine).toContainText('e2e-reviewer');
    await expect(mine).toContainText('剩餘');
    await mine.getByRole('button', { name: '詳情', exact: true }).click();
    await expect(mine).toContainText('自己認領');
    await expect(mine).toContainText('認領中');
    await expect(mine.getByRole('button', { name: '指派給…', exact: true })).toBeDisabled();
    await mine.getByRole('button', { name: '暫停', exact: true }).click();
    await mine.getByLabel('暫停理由').fill('先暫停這筆認領。');
    await mine.getByRole('button', { name: '確認暫停', exact: true }).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await expect(mine).toBeVisible();
    await expect(mine.getByLabel('暫停理由')).toHaveCount(0);
    await expect(mine.getByLabel('恢復理由')).toHaveCount(0);
    await expect(mine.getByRole('button', { name: '恢復', exact: true })).toBeVisible();
    await mine.getByRole('button', { name: '恢復', exact: true }).click();
    await mine.getByLabel('恢復理由').fill('恢復這筆認領。');
    await mine.getByRole('button', { name: '確認恢復', exact: true }).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await expect(mine.getByLabel('恢復理由')).toHaveCount(0);
    await expect(mine.getByRole('button', { name: '暫停', exact: true })).toBeVisible();
    await mine.getByRole('button', { name: '放棄認領', exact: true }).click();
    await mine.getByLabel('放棄理由').fill('這次先交還佇列。');
    await mine.getByRole('button', { name: '確認放棄認領', exact: true }).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await expect(mine).toHaveCount(0);

    await page.getByRole('tab', { name: '待審', exact: true }).click();
    const returned = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await expect(returned).toContainText('無人認領');
    await returned.getByRole('button', { name: '詳情', exact: true }).click();
    const released = returned.getByRole('listitem').filter({ hasText: 'e2e-reviewer' });
    await expect(released).toContainText('自己認領');
    await expect(released).toContainText('管理員已釋放');
    await expect(released).not.toContainText('本人放棄認領');
    await returned.getByRole('button', { name: '指派給…', exact: true }).click();
    await returned.getByLabel('審查人').selectOption({ label: '另一位審查者（@e2e-reviewer-two・AI 開發公會・公會長）' });
    await expect(returned.getByLabel('審查人')).toContainText('維護審查者（@e2e-reviewer・管理員）');
    await returned.getByLabel('指派理由').fill('請這位公會長看這次變更。');
    await returned.getByRole('button', { name: '確認指派', exact: true }).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await page.getByRole('tab', { name: '審核中', exact: true }).click();
    const assigned = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await expect(assigned).toContainText('e2e-reviewer-two');
    await expect(assigned).toContainText('剩餘');
    await assigned.getByRole('button', { name: '詳情', exact: true }).click();
    await expect(assigned).toContainText('由 認領審核員 指派');
    await assigned.getByRole('button', { name: '放棄認領', exact: true }).click();
    await assigned.getByLabel('放棄理由').fill('指派確認後交還佇列。');
    await assigned.getByRole('button', { name: '確認放棄認領', exact: true }).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();

    await page.getByRole('tab', { name: '待作者', exact: true }).click();
    const author = page.locator(`[data-pull-id="${PULL_AUTHOR}"]`);
    await expect(author).toContainText('dependabot[bot]');
    await expect(author).toContainText('fork');
    await expect(author).toContainText('Bot');
    await page.getByRole('tab', { name: '待決定', exact: true }).click();
    const decision = page.locator(`[data-pull-id="${PULL_HIGH}"]`);
    await expect(decision).toContainText('這個 PR 不是要合併到預設分支，請公會長或管理員決定怎麼處理。');
    await decision.getByRole('button', { name: '詳情', exact: true }).click();
    await expect(decision).toContainText('改到 .github、授權或品牌等敏感檔案，合併前請親自看過。');
    await expect(decision).toContainText('.github/workflows/verify.yml');

    await page.getByRole('tab', { name: '等 CI', exact: true }).click();
    const ci = page.locator(`[data-pull-id="${PULL_CI}"]`);
    await expect(ci).toContainText('ci-author');
    await expect(ci).toContainText('首次貢獻');
    await expect(ci).toContainText('進行中');
    await ci.getByRole('button', { name: '詳情', exact: true }).click();
    await ci.getByRole('button', { name: '暫停', exact: true }).click();
    await ci.getByLabel('暫停理由').fill('先暫停這次自動處理。');
    await ci.getByRole('button', { name: '確認暫停', exact: true }).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await page.getByRole('tab', { name: '已暫停', exact: true }).click();
    const paused = page.locator(`[data-pull-id="${PULL_CI}"]`);
    await expect(paused).toContainText('已暫停');
    await paused.getByRole('button', { name: '詳情', exact: true }).click();
    await paused.getByRole('button', { name: '恢復', exact: true }).click();
    await paused.getByLabel('恢復理由').fill('檢查可以繼續看。');
    await paused.getByRole('button', { name: '確認恢復', exact: true }).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await page.getByRole('tab', { name: '等 CI', exact: true }).click();
    const rederived = page.locator(`[data-pull-id="${PULL_CI}"]`);
    await expect(rederived).toContainText('必要檢查還在跑，稍後會再看一次。');

    await page.getByText('儲存庫設定', { exact: true }).click();
    const settings = page.locator('.review-settings');
    await expect(settings.getByLabel('認領時效（小時）')).toHaveValue('24');
    await expect(settings.getByLabel('認領時效（小時）')).toHaveAttribute('placeholder', '不自動釋放');
    await settings.getByLabel('歸屬', { exact: true }).selectOption({ label: 'AI 開發公會' });
    await settings.getByLabel('類型').selectOption({ label: '模組' });
    await settings.getByLabel('歸屬理由').fill('這份儲存庫交給 AI 開發公會。');
    await settings.getByRole('button', { name: '儲存歸屬', exact: true }).click();
    await expect(settings.locator('p.muted').first()).toContainText('歸屬 AI 開發公會 · 模組');
    await expect(page.getByRole('region', { name: '審核人' })).toContainText('已可審查');
    await expect(page.getByRole('region', { name: '審核人' })).toContainText('另一位審查者');
    await page.getByRole('tab', { name: '待審', exact: true }).click();
    const owned = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await expect(owned).toContainText('AI 開發公會');
    await owned.getByRole('button', { name: '詳情', exact: true }).click();
    await owned.getByRole('button', { name: '變更歸屬…', exact: true }).click();
    await expect(owned).toContainText('會套用到整個 FreeTWAI-AI/freedom-platform。');
    await owned.getByLabel('歸屬', { exact: true }).selectOption({ label: '開放公會長認領' });
    await owned.getByLabel('歸屬理由').fill('改回開放公會長認領。');
    await owned.getByRole('button', { name: '儲存歸屬', exact: true }).click();
    await expect(page.locator(`[data-pull-id="${PULL_LOW}"] span.badge-open`)).toHaveText('開放認領');

    await page.getByRole('button', { name: '操作紀錄', exact: true }).click();
    for (const label of ['認領審核', '釋放審核認領', '指派審核', '暫停拉取請求', '恢復拉取請求', '變更 PR 審核歸屬']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    expect((await e2eAuthPool.query(`SELECT kind FROM maintainer_jobs WHERE repository_id=$1 ORDER BY kind`, [REPO])).rows.map(row => row.kind)).toEqual(['request_reviewer', 'request_reviewer']);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'PR 審核', exact: true }).click();
    await page.getByRole('tab', { name: '待審', exact: true }).click();
    const phone = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await expect(phone).toBeVisible();
    const phoneToggle = phone.getByRole('button', { name: '詳情', exact: true });
    const phoneToggleBox = await phoneToggle.boundingBox();
    const phoneBox = await phone.boundingBox();
    expect(phoneToggleBox).not.toBeNull();
    expect(phoneBox).not.toBeNull();
    expect(phoneToggleBox!.x).toBeGreaterThanOrEqual(phoneBox!.x - 0.5);
    expect(phoneToggleBox!.x + phoneToggleBox!.width).toBeLessThanOrEqual(phoneBox!.x + phoneBox!.width + 0.5);
    await phoneToggle.click();
    for (const name of ['我來審', '指派給…', '暫停']) {
      const action = phone.getByRole('button', { name, exact: true });
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThan(220);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await phone.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  } finally {
    if (previousOfficer) {
      await e2eAuthPool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)
        ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=EXCLUDED.user_id`, [DEMO_COMMUNITY, GUILD, previousOfficer.user_id]);
    } else {
      await e2eAuthPool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3', [DEMO_COMMUNITY, GUILD, USER_OTHER]);
    }
    await e2eAuthPool.query('DELETE FROM positioning_profession_memberships WHERE user_id=$1', [USER_OTHER]);
    await wipe(e2eAuthPool);
  }
});

function commandPattern(cli: string) {
  return new RegExp(`^${cli} "\\$\\(cat freedom-handoff-[0-9a-f]{8}\\.md\\)"$`);
}

async function generatedCommand(scope: Locator, cli: string) {
  const code = scope.locator('code.handoff-command');
  await expect(code).toHaveText(commandPattern(cli));
  const text = (await code.innerText()).trim();
  const id = text.match(/freedom-handoff-([0-9a-f]{8})\.md/)?.[1];
  expect(id, text).toBeTruthy();
  await expect(scope).toContainText(`任務已產生（交接編號 ${id}）。`);
  return id!;
}

async function saveTaskFile(page: Page, scope: Locator, id: string) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    scope.getByRole('button', { name: '下載任務檔', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`freedom-handoff-${id}.md`);
}

async function expectCommandTokens(page: Page) {
  const paint = await page.locator('code.handoff-command').first().evaluate(element => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  const ink = await page.evaluate(() => {
    const host = document.querySelector('.review-center');
    if (!host) throw new Error('找不到審核中心');
    const probe = document.createElement('span');
    probe.style.color = 'var(--ink)';
    host.appendChild(probe);
    try { return getComputedStyle(probe).color; } finally { probe.remove(); }
  });
  expect(paint.color).toBe(ink);
  expect(paint.background).toBe(await tokenBackground(page, '--bg-elev'));
}

test('an admin hands a pull and an issue to a local AI', async ({ page, e2eAuthPool }) => {
  test.setTimeout(180_000);
  await wipe(e2eAuthPool);
  await e2eAuthPool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)
    ON CONFLICT(email) DO UPDATE SET active=true, community_id=EXCLUDED.community_id, display_name=EXCLUDED.display_name`,
  ['05800000-0000-4000-8000-000000000041', DEMO_COMMUNITY, E2E_AUTHOR_CLAIM_ADMIN_EMAIL, '認領審核員']);
  await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,email_verified_at)
    SELECT $1, community_id, $2, $3, password_hash, $4, now() FROM users WHERE user_id=$5`,
  [USER_SELF, E2E_AUTHOR_CLAIM_ADMIN_EMAIL, '維護審查者', '05800000-0000-4000-8000-000000000051', DEMO_USERS[0].user_id]);
  await e2eAuthPool.query(`INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens)
    VALUES ($1,$2,'77010001','e2e-reviewer','e2e-placeholder-not-a-token')`,
  [USER_SELF, DEMO_COMMUNITY]);
  await e2eAuthPool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, settings, open_to_guilds, next_sweep_at)
    VALUES ($1,$2,'910058','770058','FreeTWAI-AI/freedom-platform','main','active','observe','{}'::jsonb,true,'2099-01-01T00:00:00Z')`,
  [REPO, DEMO_COMMUNITY]);
  const pulls = [
    { id: PULL_LOW, number: 11, title: '文件修正', queue: 'awaiting_review', queueCode: 'awaiting_review', queueMessage: '檢查已過，等公會長或管理員核准。' },
    { id: PULL_READY, number: 15, title: '已可合併的修正', queue: 'ready', queueCode: 'ready_human_approved', queueMessage: '已有有效核准，而且必要檢查通過。' },
  ];
  for (const pull of pulls) {
    await e2eAuthPool.query(`INSERT INTO maintainer_pull_requests (
      pull_id, repository_id, number, github_pull_id, title, html_url, state, is_draft, author_github_id, author_login, author_type,
      author_association, is_fork, head_sha, base_ref, base_sha, labels, additions, deletions, changed_files, github_created_at,
      github_updated_at, head_observed_at, attention_reasons, queue_state, queue_reasons, migration_reasons, policy_version, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,'open',false,'88000011','docs-author','User','CONTRIBUTOR',false,$7,'main',$8,'{}',1,0,1,now(),now(),now(),'[]'::jsonb,$9,$10::jsonb,'[]'::jsonb,'2026-10-01.1',now())`,
    [pull.id, REPO, pull.number, String(910000 + pull.number), pull.title, `https://github.com/FreeTWAI-AI/freedom-platform/pull/${pull.number}`,
      HEAD, OLD, pull.queue, JSON.stringify([{ code: pull.queueCode, message: pull.queueMessage }])]);
  }
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route('**/admin/api/**', async route => {
      const headers = { ...route.request().headers(), 'cf-access-jwt-assertion': E2E_AUTHOR_CLAIM_ADMIN_TOKEN };
      await route.continue({ headers });
    });
    await page.goto('/admin');
    await page.getByRole('button', { name: 'PR 審核', exact: true }).click();
    const low = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await low.getByRole('button', { name: '詳情', exact: true }).click();
    await low.getByRole('button', { name: '交給本機 AI…', exact: true }).click();
    await expect(low.locator('option[value="merge"]')).toHaveAttribute('disabled', '');
    await expect(low).toContainText('只有已核准（有效核准落在目前的提交上）而且 CI 通過的 PR，才能交給 AI 合併。');
    const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/review-center/pulls/') && response.url().endsWith('/handoffs'));
    await low.getByRole('button', { name: '產生任務', exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    const firstKey = createdResponse.request().headers()['idempotency-key'];
    const fixId = await generatedCommand(low, 'claude');
    await saveTaskFile(page, low, fixId);
    await expect(low.getByRole('list', { name: '最近的交接' })).toContainText('讓 AI 修');
    await expect(low.getByRole('list', { name: '最近的交接' })).toContainText('@e2e-reviewer');
    await expectCommandTokens(page);
    await page.screenshot({ path: 'test-results/repo-maintainer-handoff-admin-1280.png', fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expectCommandTokens(page);
    await page.screenshot({ path: 'test-results/repo-maintainer-handoff-admin-dark-1280.png', fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

    await page.setViewportSize({ width: 390, height: 844 });
    const download = low.getByRole('button', { name: '下載任務檔', exact: true });
    await download.scrollIntoViewIfNeeded();
    const box = await download.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThan(220);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    const handoffButton = low.getByRole('button', { name: '交給本機 AI…', exact: true });
    const handoffBox = await handoffButton.boundingBox();
    expect(handoffBox).not.toBeNull();
    expect(handoffBox!.width).toBeLessThan(220);
    expect(handoffBox!.x + handoffBox!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await low.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/repo-maintainer-handoff-admin-390.png', fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/repo-maintainer-handoff-admin-dark-390.png', fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.setViewportSize({ width: 1280, height: 900 });
    await low.getByRole('button', { name: '再產生一個', exact: true }).click();
    await expect(low.getByRole('button', { name: '產生任務', exact: true })).toBeVisible();
    await expect(low.getByLabel('工作')).toHaveValue('fix');
    await expect(low.getByLabel('工具')).toHaveValue('claude');
    const again = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/review-center/pulls/') && response.url().endsWith('/handoffs'));
    await low.getByRole('button', { name: '產生任務', exact: true }).click();
    const againResponse = await again;
    expect(againResponse.status()).toBe(201);
    expect(againResponse.request().headers()['idempotency-key']).not.toBe(firstKey);

    await page.getByRole('tab', { name: '已核准', exact: true }).click();
    const ready = page.locator(`[data-pull-id="${PULL_READY}"]`);
    await ready.getByRole('button', { name: '詳情', exact: true }).click();
    await ready.getByRole('button', { name: '交給本機 AI…', exact: true }).click();
    await expect(ready.locator('option[value="merge"]')).not.toHaveAttribute('disabled');
    await ready.getByLabel('工作').selectOption({ label: '讓 AI 合併這個 PR' });
    const merged = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/review-center/pulls/${PULL_READY}/handoffs`));
    await ready.getByRole('button', { name: '產生任務', exact: true }).click();
    expect((await merged).status()).toBe(201);
    await generatedCommand(ready, 'claude');
    await ready.getByText('預覽任務內容', { exact: true }).click();
    const preview = await ready.locator('pre').innerText();
    expect(preview).toContain(`--match-head-commit ${HEAD}`);
    expect(preview).not.toContain('--admin');

    const issue = page.locator('details.handoff-panel');
    await issue.locator('summary').click();
    await expect(issue.getByLabel('交接儲存庫')).toHaveValue(REPO);
    await issue.getByLabel('Issue 編號').fill('42');
    await issue.getByLabel('工具').selectOption({ label: 'Codex CLI' });
    const issued = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/issue-handoffs'));
    await issue.getByRole('button', { name: '產生任務', exact: true }).click();
    const issuedResponse = await issued;
    expect(issuedResponse.status()).toBe(201);
    const issueKey = issuedResponse.request().headers()['idempotency-key'];
    await generatedCommand(issue, 'codex');
    await issue.getByText('預覽任務內容', { exact: true }).click();
    await expect(issue.locator('pre')).toContainText('Closes #42');
    await expect(issue.locator('pre')).not.toContainText('平台觀察到的資料');
    await issue.getByRole('button', { name: '再產生一個', exact: true }).click();
    await expect(issue.getByRole('button', { name: '產生任務', exact: true })).toBeVisible();
    await expect(issue.getByLabel('Issue 編號')).toHaveValue('');
    await expect(issue.getByLabel('交接儲存庫')).toHaveValue(REPO);
    await expect(issue.getByLabel('工具')).toHaveValue('codex');
    await issue.getByLabel('Issue 編號').fill('43');
    const issuedAgain = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/issue-handoffs'));
    await issue.getByRole('button', { name: '產生任務', exact: true }).click();
    const issuedAgainResponse = await issuedAgain;
    expect(issuedAgainResponse.status()).toBe(201);
    expect(issuedAgainResponse.request().headers()['idempotency-key']).not.toBe(issueKey);
  } finally {
    await wipe(e2eAuthPool);
  }
});
