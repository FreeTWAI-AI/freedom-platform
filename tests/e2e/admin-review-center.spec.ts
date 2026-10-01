import type {Page} from '@playwright/test';
import {test, expect} from './fixtures.js';
import {DEMO_COMMUNITY, DEMO_USERS} from '../../packages/testing/seed.js';
import {E2E_AUTHOR_CLAIM_ADMIN_EMAIL, E2E_AUTHOR_CLAIM_ADMIN_TOKEN} from '../../packages/testing/e2e-admin.js';

const REPO = '05800000-0000-4000-8000-000000000001';
const PULL_LOW = '05800000-0000-4000-8000-000000000011';
const PULL_HIGH = '05800000-0000-4000-8000-000000000012';
const PULL_AUTHOR = '05800000-0000-4000-8000-000000000013';
const PULL_CI = '05800000-0000-4000-8000-000000000014';
const REVIEWER_SELF = '05800000-0000-4000-8000-000000000021';
const REVIEWER_OTHER = '05800000-0000-4000-8000-000000000022';
const USER_SELF = '05800000-0000-4000-8000-000000000031';
const USER_OTHER = '05800000-0000-4000-8000-000000000032';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OTHER_EMAIL = 'e2e-maintainer-other@example.invalid';

async function wipe(pool: {query: (text: string, values?: unknown[]) => Promise<unknown>}) {
  await pool.query(`DELETE FROM platform_admin_audit WHERE target_ref IN (
    SELECT pull_id::text FROM maintainer_pull_requests WHERE repository_id=$1
    UNION SELECT claim_id::text FROM maintainer_review_claims c
      JOIN maintainer_pull_requests p ON p.pull_id=c.pull_id WHERE p.repository_id=$1)`, [REPO]);
  await pool.query(`DELETE FROM platform_admin_receipts WHERE operation LIKE '%/review-center/%' AND admin_id IN (
    SELECT admin_id FROM platform_admins WHERE email=$1)`, [E2E_AUTHOR_CLAIM_ADMIN_EMAIL]);
  await pool.query('DELETE FROM maintainer_jobs WHERE repository_id=$1', [REPO]);
  await pool.query(`DELETE FROM maintainer_review_claims WHERE pull_id IN (
    SELECT pull_id FROM maintainer_pull_requests WHERE repository_id=$1)`, [REPO]);
  await pool.query('DELETE FROM maintainer_pull_requests WHERE repository_id=$1', [REPO]);
  await pool.query('DELETE FROM maintainer_reviewers WHERE reviewer_id=ANY($1::uuid[])', [[REVIEWER_SELF, REVIEWER_OTHER]]);
  await pool.query('DELETE FROM maintainer_repositories WHERE repository_id=$1', [REPO]);
  await pool.query('DELETE FROM github_social_connections WHERE user_id=ANY($1::uuid[]) OR github_user_id=ANY($2::text[])', [[USER_SELF, USER_OTHER], ['77010001', '77010002']]);
  await pool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[]) OR email=ANY($2::text[])', [[USER_SELF, USER_OTHER], [E2E_AUTHOR_CLAIM_ADMIN_EMAIL, OTHER_EMAIL]]);
}

function countOf(page: Page, label: string) {
  return page.locator('.review-counts > div').filter({has: page.getByText(label, {exact: true})}).locator('dd');
}

test('an admin claims, assigns, pauses and reads the review center on desktop and phone', async ({page, e2eAuthPool}) => {
  test.setTimeout(120_000);
  await wipe(e2eAuthPool);
  await e2eAuthPool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)
    ON CONFLICT(email) DO UPDATE SET active=true, community_id=EXCLUDED.community_id, display_name=EXCLUDED.display_name`,
  ['05800000-0000-4000-8000-000000000041', DEMO_COMMUNITY, E2E_AUTHOR_CLAIM_ADMIN_EMAIL, '認領審核員']);
  const admin = await e2eAuthPool.query('SELECT admin_id FROM platform_admins WHERE email=$1', [E2E_AUTHOR_CLAIM_ADMIN_EMAIL]);
  const adminId = admin.rows[0].admin_id as string;
  await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,email_verified_at)
    SELECT $1, community_id, $2, $3, password_hash, $4, now() FROM users WHERE user_id=$5`,
  [USER_SELF, E2E_AUTHOR_CLAIM_ADMIN_EMAIL, '維護審查者', '05800000-0000-4000-8000-000000000051', DEMO_USERS[0].user_id]);
  await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,email_verified_at)
    SELECT $1, community_id, $2, $3, password_hash, $4, now() FROM users WHERE user_id=$5`,
  [USER_OTHER, OTHER_EMAIL, '另一位審查者', '05800000-0000-4000-8000-000000000052', DEMO_USERS[0].user_id]);
  await e2eAuthPool.query(`INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens)
    VALUES ($1,$2,'77010001','e2e-reviewer','e2e-placeholder-not-a-token'), ($3,$2,'77010002','e2e-reviewer-two','e2e-placeholder-not-a-token')`,
  [USER_SELF, DEMO_COMMUNITY, USER_OTHER]);
  await e2eAuthPool.query(`INSERT INTO maintainer_reviewers(reviewer_id,community_id,github_user_id,github_login,user_id,max_risk,active,appointed_by)
    VALUES ($1,$2,'77010001','e2e-reviewer',$3,'high',true,$4), ($5,$2,'77010002','e2e-reviewer-two',$6,'high',true,$4)`,
  [REVIEWER_SELF, DEMO_COMMUNITY, USER_SELF, adminId, REVIEWER_OTHER, USER_OTHER]);
  await e2eAuthPool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, settings, next_sweep_at)
    VALUES ($1,$2,'910058','770058','FreeTWAI-AI/freedom-platform','main','active','observe','{}'::jsonb,'2099-01-01T00:00:00Z')`,
  [REPO, DEMO_COMMUNITY]);
  const pulls = [
    {id: PULL_LOW, number: 11, title: '低風險文件修正', author: '88000011', login: 'docs-author', association: 'CONTRIBUTOR', type: 'User', fork: false, file: 'docs/guide.md', risk: 'low', riskCode: 'low_docs', riskMessage: '這次只動到文件或圖片，風險較低，仍需要真人核准。', queue: 'awaiting_review', queueCode: 'awaiting_review', queueMessage: '檢查已過，還在等符合風險等級的真人核准。', check: 'completed', conclusion: 'success', migration: []},
    {id: PULL_HIGH, number: 12, title: '高風險工作流程', author: '88000012', login: 'workflow-author', association: 'MEMBER', type: 'User', fork: false, file: '.github/workflows/verify.yml', risk: 'high', riskCode: 'high_sensitive', riskMessage: '變更碰到清單上的敏感路徑，請擁有者親自看過再合併。', queue: 'needs_owner', queueCode: 'high_risk_requires_owner', queueMessage: '這是高風險變更，需要擁有者處理，一般審查者的核准不夠。', check: 'completed', conclusion: 'success', migration: []},
    {id: PULL_AUTHOR, number: 13, title: '遷移編號衝突', author: '88000013', login: 'dependabot[bot]', association: 'NONE', type: 'Bot', fork: true, file: 'docs/note.md', risk: 'medium', riskCode: 'bot_author', riskMessage: '作者是 Bot。自動化審查不能代替真人，請由符合風險等級的審查者處理。', queue: 'needs_author', queueCode: 'migration_number_collision', queueMessage: '編號 001 已存在於 main。請改用下一個編號。', check: 'completed', conclusion: 'success', migration: [{code: 'migration_number_collision', message: '編號 001 已存在於 main。請改用下一個編號。'}]},
    {id: PULL_CI, number: 14, title: '檢查還在跑', author: '88000014', login: 'ci-author', association: 'FIRST_TIME_CONTRIBUTOR', type: 'User', fork: false, file: 'docs/waiting.md', risk: 'medium', riskCode: 'author_first_time_contributor', riskMessage: '作者是首次貢獻者，風險至少為中，請由真人審查。', queue: 'waiting_ci', queueCode: 'ci_running', queueMessage: '必要檢查還在跑，稍後會再看一次。', check: 'in_progress', conclusion: null, migration: []},
  ];
  for (const pull of pulls) {
    await e2eAuthPool.query(`INSERT INTO maintainer_pull_requests (
      pull_id, repository_id, number, github_pull_id, title, html_url, state, is_draft, author_github_id, author_login, author_type,
      author_association, is_fork, head_sha, base_ref, base_sha, labels, additions, deletions, changed_files, github_created_at,
      github_updated_at, head_observed_at, risk_class, risk_reasons, queue_state, queue_reasons, migration_reasons, sla_due_at, policy_version, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,'open',false,$7,$8,$9,$10,$11,$12,'main',$13,'{}',1,0,1,now(),now(),now(),$14,$15::jsonb,$16,$17::jsonb,$18::jsonb,
        CASE WHEN $16='awaiting_review' THEN now() + interval '24 hours' ELSE NULL END,'2026-09-30.2',now())`,
    [pull.id, REPO, pull.number, String(910000 + pull.number), pull.title, `https://github.com/FreeTWAI-AI/freedom-platform/pull/${pull.number}`,
      pull.author, pull.login, pull.type, pull.association, pull.fork, HEAD, OLD, pull.risk,
      JSON.stringify([{code: pull.riskCode, message: pull.riskMessage, paths: [pull.file]}]), pull.queue,
      JSON.stringify([{code: pull.queueCode, message: pull.queueMessage}]), JSON.stringify(pull.migration)]);
    await e2eAuthPool.query(`INSERT INTO maintainer_pull_files(pull_id, path, status, additions, deletions) VALUES ($1,$2,'modified',1,0)`, [pull.id, pull.file]);
    await e2eAuthPool.query(`INSERT INTO maintainer_checks(pull_id, head_sha, source, name, app_slug, status, conclusion)
      VALUES ($1,$2,'check_run','verify','github-actions',$3,$4)`, [pull.id, HEAD, pull.check, pull.conclusion]);
  }
  await e2eAuthPool.query(`INSERT INTO maintainer_reviews(pull_id, github_review_id, reviewer_github_id, reviewer_login, reviewer_type, reviewer_association, state, commit_id, submitted_at)
    VALUES ($1,'910091','88000099','old-commenter','User','MEMBER','APPROVED',$2,now())`, [PULL_LOW, OLD]);

  try {
    await page.setViewportSize({width: 1280, height: 900});
    await page.route('**/admin/api/**', async route => {
      const headers = {...route.request().headers(), 'cf-access-jwt-assertion': E2E_AUTHOR_CLAIM_ADMIN_TOKEN};
      await route.continue({headers});
    });
    await page.goto('/admin');
    await page.getByRole('button', {name: 'PR 審核', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'PR 審核', exact: true})).toBeVisible();
    await expect(countOf(page, '待審')).toHaveText('1');
    await expect(countOf(page, '審核中')).toHaveText('0');
    await expect(countOf(page, '等 CI')).toHaveText('1');
    await expect(countOf(page, '待作者')).toHaveText('1');
    await expect(countOf(page, '需要擁有者')).toHaveText('1');
    await expect(countOf(page, '已核准')).toHaveText('0');
    await expect(page.getByRole('list', {name: '儲存庫模式'})).toContainText('FreeTWAI-AI/freedom-platform');
    await expect(page.getByRole('list', {name: '儲存庫模式'})).toContainText('觀察');

    const low = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await expect(low).toContainText('低風險');
    await expect(low.locator('span.badge', {hasText: '低風險'})).toHaveClass(/badge-ok/);
    await expect(low).toContainText('無人認領');
    await expect(low).toContainText('docs-author');
    const github = low.getByRole('link', {name: /#11/});
    await expect(github).toHaveAttribute('href', 'https://github.com/FreeTWAI-AI/freedom-platform/pull/11');
    await expect(github).toHaveAttribute('target', '_blank');
    await expect(github).toHaveAttribute('rel', 'noopener noreferrer');
    await low.getByRole('button', {name: '詳情', exact: true}).click();
    await expect(low.getByRole('link', {name: '在 GitHub 審核', exact: true})).toHaveAttribute('href', 'https://github.com/FreeTWAI-AI/freedom-platform/pull/11/files');
    await expect(low).toContainText('舊提交');
    await expect(low).toContainText('不算有效核准');
    const reviewLine = low.getByRole('listitem').filter({hasText: 'old-commenter'});
    await expect(reviewLine).toContainText('核准');
    await expect(reviewLine).not.toContainText('APPROVED');
    await low.getByRole('button', {name: '我來審', exact: true}).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await expect(low).toHaveCount(0);
    await expect(countOf(page, '審核中')).toHaveText('1');

    await page.getByRole('tab', {name: '審核中', exact: true}).click();
    await expect(page.locator(`[data-pull-id="${PULL_LOW}"]`)).toContainText('審核中');
    await page.getByRole('tab', {name: '我認領的', exact: true}).click();
    const mine = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await expect(mine).toContainText('e2e-reviewer');
    await expect(mine).toContainText('剩餘');
    await mine.getByRole('button', {name: '詳情', exact: true}).click();
    await expect(mine).toContainText('自己認領');
    await expect(mine).toContainText('認領中');
    await expect(mine.getByRole('button', {name: '指派給…', exact: true})).toBeDisabled();
    await mine.getByRole('button', {name: '放棄認領', exact: true}).click();
    await mine.getByLabel('放棄理由').fill('這次先交還佇列。');
    await mine.getByRole('button', {name: '確認放棄認領', exact: true}).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await expect(mine).toHaveCount(0);

    await page.getByRole('tab', {name: '待審', exact: true}).click();
    const returned = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await expect(returned).toContainText('無人認領');
    await returned.getByRole('button', {name: '詳情', exact: true}).click();
    await expect(returned).toContainText('已手動釋放');
    await page.getByRole('tab', {name: '待作者', exact: true}).click();
    const author = page.locator(`[data-pull-id="${PULL_AUTHOR}"]`);
    await expect(author).toContainText('dependabot[bot]');
    await expect(author).toContainText('fork');
    await expect(author).toContainText('Bot');
    await page.getByRole('tab', {name: '需要擁有者', exact: true}).click();
    const high = page.locator(`[data-pull-id="${PULL_HIGH}"]`);
    await expect(high).toContainText('高風險');
    await expect(high.locator('span.badge', {hasText: '高風險'})).toHaveClass(/badge-alert/);
    await high.getByRole('button', {name: '詳情', exact: true}).click();
    await high.getByRole('button', {name: '指派給…', exact: true}).click();
    await high.getByLabel('審查者').selectOption({label: 'e2e-reviewer-two（高風險）'});
    await high.getByLabel('指派理由').fill('請這位看高風險變更。');
    await high.getByRole('button', {name: '確認指派', exact: true}).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await page.getByRole('tab', {name: '審核中', exact: true}).click();
    const assigned = page.locator(`[data-pull-id="${PULL_HIGH}"]`);
    await expect(assigned).toContainText('e2e-reviewer-two');
    await expect(assigned).toContainText('剩餘');
    await assigned.getByRole('button', {name: '詳情', exact: true}).click();
    await expect(assigned).toContainText('由 認領審核員 指派');

    await page.getByRole('tab', {name: '等 CI', exact: true}).click();
    const ci = page.locator(`[data-pull-id="${PULL_CI}"]`);
    await expect(ci).toContainText('首次貢獻');
    await expect(ci).toContainText('進行中');
    await ci.getByRole('button', {name: '詳情', exact: true}).click();
    await ci.getByRole('button', {name: '暫停自動處理', exact: true}).click();
    await ci.getByLabel('暫停理由').fill('先暫停這次自動處理。');
    await ci.getByRole('button', {name: '確認暫停', exact: true}).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await page.getByRole('tab', {name: '已暫停', exact: true}).click();
    const paused = page.locator(`[data-pull-id="${PULL_CI}"]`);
    await expect(paused).toContainText('已暫停');
    await paused.getByRole('button', {name: '詳情', exact: true}).click();
    await paused.getByRole('button', {name: '恢復', exact: true}).click();
    await paused.getByLabel('恢復理由').fill('檢查可以繼續看。');
    await paused.getByRole('button', {name: '確認恢復', exact: true}).click();
    await expect(page.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await page.getByRole('tab', {name: '等 CI', exact: true}).click();
    await expect(page.locator(`[data-pull-id="${PULL_CI}"]`)).toBeVisible();

    await page.getByRole('button', {name: '操作紀錄', exact: true}).click();
    for (const label of ['認領審核', '釋放審核認領', '指派審核', '暫停拉取請求', '恢復拉取請求']) {
      await expect(page.getByText(label, {exact: true}).first()).toBeVisible();
    }
    expect((await e2eAuthPool.query('SELECT count(*) FROM maintainer_jobs WHERE repository_id=$1', [REPO])).rows[0].count).toBe('0');

    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('button', {name: 'PR 審核', exact: true}).click();
    await page.getByRole('tab', {name: '待審', exact: true}).click();
    const phone = page.locator(`[data-pull-id="${PULL_LOW}"]`);
    await expect(phone).toBeVisible();
    await phone.getByRole('button', {name: '詳情', exact: true}).click();
    for (const name of ['我來審', '指派給…', '暫停自動處理']) {
      const action = phone.getByRole('button', {name, exact: true});
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await phone.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  } finally {
    await wipe(e2eAuthPool);
  }
});
