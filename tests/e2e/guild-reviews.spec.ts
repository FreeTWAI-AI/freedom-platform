import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { navigate } from './navigation.js';
import { DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';

const MAKER = DEMO_USERS[0].user_id;
const GUILDS = ['guild_ai_vibe', 'guild_platform_engineering'] as const;
const REPOS = {
  own: '05900000-0000-4000-8000-000000000001',
  open: '05900000-0000-4000-8000-000000000002',
  other: '05900000-0000-4000-8000-000000000003',
  admin: '05900000-0000-4000-8000-000000000004',
};
const PULLS = {
  own: '05900000-0000-4000-8000-000000000011',
  open: '05900000-0000-4000-8000-000000000012',
  other: '05900000-0000-4000-8000-000000000013',
  admin: '05900000-0000-4000-8000-000000000014',
};
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const GITHUB_ID = '77015901';

type Pool = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
type Snapshot = {
  officers: Array<{ guild_key: string; user_id: string }>;
  memberships: Array<{ guild_key: string; state: string; left_at: string | null }>;
  github: { github_user_id: string; github_login: string; encrypted_tokens: string; community_id: string } | null;
};

async function snapshot(pool: Pool): Promise<Snapshot> {
  const officers = await pool.query(
    'SELECT guild_key, user_id FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=ANY($2::text[])',
    [DEMO_COMMUNITY, GUILDS],
  );
  const memberships = await pool.query(
    'SELECT guild_key, state, left_at FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=ANY($3::text[])',
    [DEMO_COMMUNITY, MAKER, GUILDS],
  );
  const github = await pool.query(
    'SELECT community_id, github_user_id, github_login, encrypted_tokens FROM github_social_connections WHERE user_id=$1',
    [MAKER],
  );
  return {
    officers: officers.rows as Snapshot['officers'],
    memberships: memberships.rows as Snapshot['memberships'],
    github: (github.rows[0] as Snapshot['github']) ?? null,
  };
}

async function appoint(pool: Pool) {
  for (const guild of GUILDS) {
    await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state)
      VALUES ($1,$2,$3,$4,'active')
      ON CONFLICT (community_id, user_id, guild_key) DO UPDATE SET state='active', left_at=NULL`,
    [randomUUID(), DEMO_COMMUNITY, MAKER, guild]);
    await pool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES ($1,$2,$3)
      ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id=EXCLUDED.user_id`,
    [DEMO_COMMUNITY, guild, MAKER]);
  }
  await pool.query(`INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens)
    VALUES ($1,$2,$3,'e2e-guild-leader','e2e-placeholder-not-a-token')
    ON CONFLICT (user_id) DO UPDATE SET community_id=EXCLUDED.community_id, github_user_id=EXCLUDED.github_user_id,
      github_login=EXCLUDED.github_login, encrypted_tokens=EXCLUDED.encrypted_tokens`,
  [MAKER, DEMO_COMMUNITY, GITHUB_ID]);
}

async function restore(pool: Pool, prior: Snapshot) {
  for (const guild of GUILDS) {
    const membership = prior.memberships.find(item => item.guild_key === guild);
    if (!membership) {
      await pool.query('DELETE FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3', [DEMO_COMMUNITY, MAKER, guild]);
    } else {
      await pool.query('UPDATE positioning_profession_memberships SET state=$4, left_at=$5 WHERE community_id=$1 AND user_id=$2 AND guild_key=$3',
        [DEMO_COMMUNITY, MAKER, guild, membership.state, membership.left_at]);
    }
  }
  for (const guild of GUILDS) {
    const officer = prior.officers.find(item => item.guild_key === guild);
    if (officer) {
      await pool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES ($1,$2,$3)
        ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id=EXCLUDED.user_id`,
      [DEMO_COMMUNITY, guild, officer.user_id]);
    } else {
      await pool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, guild]);
    }
  }
  if (prior.github) {
    await pool.query(`INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id) DO UPDATE SET community_id=EXCLUDED.community_id, github_user_id=EXCLUDED.github_user_id,
        github_login=EXCLUDED.github_login, encrypted_tokens=EXCLUDED.encrypted_tokens`,
    [MAKER, prior.github.community_id, prior.github.github_user_id, prior.github.github_login, prior.github.encrypted_tokens]);
  } else {
    await pool.query('DELETE FROM github_social_connections WHERE user_id=$1', [MAKER]);
  }
}

async function wipe(pool: Pool) {
  const ids = Object.values(REPOS);
  await pool.query(`DELETE FROM maintainer_review_claims WHERE pull_id IN (
    SELECT pull_id FROM maintainer_pull_requests WHERE repository_id=ANY($1::uuid[]))`, [ids]);
  await pool.query('DELETE FROM maintainer_jobs WHERE repository_id=ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM maintainer_ownership_changes WHERE repository_id=ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM maintainer_handoffs WHERE repository_id=ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM maintainer_pull_requests WHERE repository_id=ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM maintainer_repositories WHERE repository_id=ANY($1::uuid[])', [ids]);
}

async function seed(pool: Pool) {
  const repos = [
    { id: REPOS.own, github: '9100591', name: 'FreeTWAI-AI/e2e-guild-own', guild: 'guild_ai_vibe', open: false },
    { id: REPOS.open, github: '9100592', name: 'FreeTWAI-AI/e2e-guild-open', guild: null, open: true },
    { id: REPOS.other, github: '9100593', name: 'FreeTWAI-AI/e2e-guild-other', guild: 'guild_marketing', open: false },
    { id: REPOS.admin, github: '9100594', name: 'FreeTWAI-AI/e2e-guild-admin', guild: null, open: false },
  ];
  for (const repo of repos) {
    await pool.query(`INSERT INTO maintainer_repositories
      (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, settings, guild_key, open_to_guilds, next_sweep_at)
      VALUES ($1,$2,$3,'770059',$4,'main','active','observe','{}'::jsonb,$5,$6,'2099-01-01T00:00:00Z')`,
    [repo.id, DEMO_COMMUNITY, repo.github, repo.name, repo.guild, repo.open]);
  }
  const pulls = [
    { id: PULLS.own, repo: REPOS.own, number: 21, title: '公會自己的修正', observed: '2026-09-30T00:00:00Z' },
    { id: PULLS.open, repo: REPOS.open, number: 22, title: '開放認領的修正', observed: '2026-09-30T01:00:00Z' },
    { id: PULLS.other, repo: REPOS.other, number: 23, title: '別的公會的修正', observed: '2026-09-30T02:00:00Z' },
    { id: PULLS.admin, repo: REPOS.admin, number: 24, title: '只限管理員的修正', observed: '2026-09-30T03:00:00Z' },
  ];
  for (const pull of pulls) {
    const fullName = repos.find(repo => repo.id === pull.repo)!.name;
    await pool.query(`INSERT INTO maintainer_pull_requests (
      pull_id, repository_id, number, github_pull_id, title, html_url, state, is_draft, author_github_id, author_login, author_type,
      author_association, is_fork, head_sha, base_ref, base_sha, labels, additions, deletions, changed_files, github_created_at,
      github_updated_at, head_observed_at, attention_reasons, queue_state, queue_reasons, migration_reasons, policy_version, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,'open',false,'88005901','e2e-author','User','CONTRIBUTOR',false,$7,'main',$8,'{}',1,0,1,$9,$9,$9,'[]'::jsonb,'awaiting_review',$10::jsonb,'[]'::jsonb,'2026-10-01.1',$9)`,
    [pull.id, pull.repo, pull.number, String(91059000 + pull.number), pull.title, `https://github.com/${fullName}/pull/${pull.number}`,
      HEAD, BASE, pull.observed, JSON.stringify([{ code: 'awaiting_review', message: '檢查已過，等公會長或管理員核准。' }])]);
    await pool.query(`INSERT INTO maintainer_checks(pull_id, head_sha, source, name, app_slug, status, conclusion)
      VALUES ($1,$2,'check_run','verify','github-actions','completed','success')`, [pull.id, HEAD]);
  }
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

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
}

test('a guild leader claims an open repository pull and releases it', async ({ page, e2eAuthPool }) => {
  test.setTimeout(120_000);
  const prior = await snapshot(e2eAuthPool);
  await wipe(e2eAuthPool);
  await appoint(e2eAuthPool);
  await seed(e2eAuthPool);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page);
    await navigate(page, '公會管理');
    await page.getByRole('button', { name: 'PR 審核', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'PR 審核', level: 3 })).toBeVisible();
    await expect(page.locator('.review-center')).toContainText('AI 開發公會');
    await expect(page.locator('.review-center')).toContainText('平台工程公會');
    const own = page.locator(`[data-pull-id="${PULLS.own}"]`);
    const open = page.locator(`[data-pull-id="${PULLS.open}"]`);
    await expect(own).toContainText('公會自己的修正');
    await expect(own).toContainText('AI 開發公會');
    await expect(open).toContainText('開放認領的修正');
    await expect(open).toContainText('開放認領');
    await expect(page.locator('.review-list')).not.toContainText('別的公會的修正');
    await expect(page.locator('.review-list')).not.toContainText('只限管理員的修正');
    await page.getByRole('tab', { name: '全部未完成', exact: true }).click();
    await expect(page.locator('.review-list')).toContainText('公會自己的修正');
    await expect(page.locator('.review-list')).toContainText('開放認領的修正');
    await expect(page.locator('.review-list')).not.toContainText('別的公會的修正');
    await expect(page.locator('.review-list')).not.toContainText('只限管理員的修正');
    await page.getByRole('tab', { name: '待審', exact: true }).click();

    for (const theme of ['light', 'dark']) {
      await page.evaluate(name => { document.documentElement.dataset.theme = name; }, theme);
      const waiting = open.locator('span.badge', { hasText: '待審' });
      const opened = open.locator('span.badge-open', { hasText: '開放認領' });
      const owned = own.locator('span.badge-own', { hasText: 'AI 開發公會' });
      await expect(waiting).toBeVisible();
      let paints: { waiting: { background: string; color: string }; opened: { background: string; color: string }; owned: { background: string; color: string } } | null = null;
      await expect.poll(async () => {
        paints = await page.locator('.review-list').evaluate((list, ids) => {
          const read = (pullId: string, selector: string, text: string) => {
            const row = list.querySelector(`[data-pull-id="${pullId}"]`);
            const badge = row ? [...row.querySelectorAll(selector)].find(element => element.textContent?.includes(text)) : undefined;
            if (!badge) return null;
            const style = getComputedStyle(badge);
            if (!style.backgroundColor || !style.color) return null;
            return { background: style.backgroundColor, color: style.color };
          };
          const waitingPaint = read(ids.open, 'span.badge', '待審');
          const openedPaint = read(ids.open, 'span.badge-open', '開放認領');
          const ownedPaint = read(ids.own, 'span.badge-own', 'AI 開發公會');
          if (!waitingPaint || !openedPaint || !ownedPaint) return null;
          return { waiting: waitingPaint, opened: openedPaint, owned: ownedPaint };
        }, { open: PULLS.open, own: PULLS.own });
        return paints;
      }).not.toBeNull();
      const waitingPaint = paints!.waiting;
      const openedPaint = paints!.opened;
      const ownedPaint = paints!.owned;
      expect(waitingPaint.background, JSON.stringify({ waitingPaint, openedPaint, ownedPaint, theme })).not.toBe(openedPaint.background);
      expect(waitingPaint.background).not.toBe(ownedPaint.background);
      expect(openedPaint.background).not.toBe(ownedPaint.background);
      for (const paint of [waitingPaint, openedPaint, ownedPaint]) expect(paint.color).not.toBe(paint.background);
      if (theme === 'light') {
        expect(waitingPaint.background).toBe(await tokenBackground(page, '--info-bg'));
        expect(openedPaint.background).toBe(await tokenBackground(page, '--module-blue-tint'));
        expect(ownedPaint.background).toBe(await tokenBackground(page, '--green-soft'));
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

    await open.getByRole('button', { name: '詳情', exact: true }).click();
    await expect(open.getByText('請在 GitHub 送出審查（Approve 或 Request changes），送出後這裡會自動標示完成。')).toBeVisible();
    await expect(open.getByLabel('審完後歸到')).toBeVisible();
    await open.getByLabel('審完後歸到').selectOption({ label: '平台工程公會' });
    await expect(open).toContainText('這個儲存庫還沒有歸屬，你審完後會歸到平台工程公會。');
    await expect(open.getByRole('link', { name: '到 GitHub 審查 ↗', exact: true })).toHaveAttribute('href', 'https://github.com/FreeTWAI-AI/e2e-guild-open/pull/22/files');

    await page.setViewportSize({ width: 390, height: 844 });
    const claim = open.getByRole('button', { name: '我來審', exact: true });
    await claim.scrollIntoViewIfNeeded();
    const claimBox = await claim.boundingBox();
    const openBox = await open.boundingBox();
    expect(claimBox).not.toBeNull();
    expect(openBox).not.toBeNull();
    expect(claimBox!.width).toBeLessThan(220);
    expect(claimBox!.width).toBeLessThan(openBox!.width - 24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await open.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

    const claimed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/claim'));
    await claim.click();
    expect((await claimed).status()).toBe(201);
    await page.getByRole('tab', { name: '我認領的', exact: true }).click();
    const mine = page.locator(`[data-pull-id="${PULLS.open}"]`);
    await expect(mine).toBeVisible();
    await expect(mine).toContainText('e2e-guild-leader');
    await expect(mine).toContainText('平台工程公會・公會長');
    await expect(mine).toContainText('不自動釋放');
    await mine.getByRole('button', { name: '詳情', exact: true }).click();
    const releasedCall = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/release'));
    await mine.getByRole('button', { name: '放棄認領', exact: true }).click();
    expect((await releasedCall).ok()).toBeTruthy();
    await expect(mine).toHaveCount(0);
    await page.getByRole('tab', { name: '待審', exact: true }).click();
    const released = page.locator(`[data-pull-id="${PULLS.open}"]`);
    await expect(released).toContainText('無人認領');
    await released.getByRole('button', { name: '詳情', exact: true }).click();
    await expect(released).toContainText('本人放棄認領');
  } finally {
    await wipe(e2eAuthPool);
    await restore(e2eAuthPool, prior);
  }
});

const REVIEWER = DEMO_USERS[1].user_id;
const BOOK_REPO = '05900000-0000-4000-8000-000000000021';
const BOOK_PULL = '05900000-0000-4000-8000-000000000031';
const BOOK_GITHUB = '77015988';
const BOOK_ADMIN = '05900000-0000-4000-8000-000000000041';

test('a skill-book maintainer who is not a guild leader claims the book pull', async ({ page, e2eAuthPool }) => {
  test.setTimeout(120_000);
  const officers = await e2eAuthPool.query(
    'SELECT guild_key, user_id FROM positioning_guild_officers WHERE community_id=$1 AND user_id=$2',
    [DEMO_COMMUNITY, REVIEWER],
  );
  const github = await e2eAuthPool.query(
    'SELECT community_id, github_user_id, github_login, encrypted_tokens FROM github_social_connections WHERE user_id=$1',
    [REVIEWER],
  );
  const ownership = await e2eAuthPool.query('SELECT 1 FROM skill_editorial_ownership WHERE book_id=$1', ['career-guide']);
  const ownedBefore = ownership.rows.length > 0;
  await e2eAuthPool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND user_id=$2', [DEMO_COMMUNITY, REVIEWER]);
  await e2eAuthPool.query(`INSERT INTO platform_admins (admin_id, community_id, email, display_name)
    VALUES ($1,$2,'skill-book-e2e@example.invalid','技能書審查測試')`, [BOOK_ADMIN, DEMO_COMMUNITY]);
  await e2eAuthPool.query(`INSERT INTO skill_editorial_ownership (book_id, community_id) VALUES ('career-guide',$1) ON CONFLICT (book_id) DO NOTHING`, [DEMO_COMMUNITY]);
  await e2eAuthPool.query(`INSERT INTO skill_book_maintainers (book_id, community_id, user_id, appointed_by, active)
    VALUES ('career-guide',$1,$2,$3,true)`, [DEMO_COMMUNITY, REVIEWER, BOOK_ADMIN]);
  await e2eAuthPool.query(`INSERT INTO github_social_connections (user_id, community_id, github_user_id, github_login, encrypted_tokens)
    VALUES ($1,$2,$3,'e2e-book-maintainer','e2e-placeholder-not-a-token')
    ON CONFLICT (user_id) DO UPDATE SET community_id=EXCLUDED.community_id, github_user_id=EXCLUDED.github_user_id,
      github_login=EXCLUDED.github_login, encrypted_tokens=EXCLUDED.encrypted_tokens`,
  [REVIEWER, DEMO_COMMUNITY, BOOK_GITHUB]);
  await e2eAuthPool.query(`INSERT INTO maintainer_repositories
    (repository_id, community_id, github_repository_id, installation_id, full_name, default_branch, installation_state, mode, settings, guild_key, scope_kind, open_to_guilds, skill_book_id, next_sweep_at)
    VALUES ($1,$2,'9100598','770059','FreeTWAI-AI/freedom-skill-career-guide','main','active','observe','{}'::jsonb,NULL,'skill_book',false,'career-guide','2099-01-01T00:00:00Z')`,
  [BOOK_REPO, DEMO_COMMUNITY]);
  await e2eAuthPool.query(`INSERT INTO maintainer_pull_requests (
    pull_id, repository_id, number, github_pull_id, title, html_url, state, is_draft, author_github_id, author_login, author_type,
    author_association, is_fork, head_sha, base_ref, base_sha, labels, additions, deletions, changed_files, github_created_at,
    github_updated_at, head_observed_at, attention_reasons, queue_state, queue_reasons, migration_reasons, policy_version, synced_at)
    VALUES ($1,$2,31,'91059031','方向探索的工坊修正','https://github.com/FreeTWAI-AI/freedom-skill-career-guide/pull/31','open',false,'88005931','e2e-author','User','CONTRIBUTOR',false,$3,'main',$4,'{}',1,0,1,$5,$5,$5,'[]'::jsonb,'awaiting_review','[]'::jsonb,'[]'::jsonb,'2026-10-01.1',$5)`,
  [BOOK_PULL, BOOK_REPO, HEAD, BASE, '2026-09-30T04:00:00Z']);
  await e2eAuthPool.query(`INSERT INTO maintainer_checks (pull_id, head_sha, source, name, app_slug, status, conclusion)
    VALUES ($1,$2,'check_run','verify','github-actions','completed','success')`, [BOOK_PULL, HEAD]);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.getByLabel('電子郵件', { exact: true }).fill('reviewer@local.test');
    await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await navigate(page, '公會管理');
    await page.getByRole('button', { name: 'PR 審核', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'PR 審核', level: 3 })).toBeVisible();
    await expect(page.locator('.review-center')).toContainText('技能書維護者可以審自己那本書的工坊拉取請求');
    const pull = page.locator(`[data-pull-id="${BOOK_PULL}"]`);
    await expect(pull).toContainText('方向探索的工坊修正');
    const bookBadge = pull.locator('span.badge', { hasText: '管理員與技能書維護者' });
    await expect(bookBadge).toHaveAttribute('class', 'badge');
    await expect(pull).not.toContainText('只限管理員');
    await expect(page.locator('.review-center')).toContainText('方向探索與陪跑入門');
    await pull.getByRole('button', { name: '詳情', exact: true }).click();
    await expect(pull).toContainText('以方向探索與陪跑入門・維護者的身分認領。審完不會把儲存庫歸到公會。');
    await expect(pull).toContainText('歸屬 管理員與技能書維護者 · 技能書');
    await expect(pull).not.toContainText('只限管理員');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'PR 審核', exact: true })).toBeVisible();
    await expect(pull).toContainText('方向探索的工坊修正');
    const claim = pull.getByRole('button', { name: '我來審', exact: true });
    await claim.scrollIntoViewIfNeeded();
    const claimBox = await claim.boundingBox();
    expect(claimBox).not.toBeNull();
    expect(claimBox!.width).toBeLessThan(220);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const claimed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/claim'));
    await claim.click();
    expect((await claimed).status()).toBe(201);
    await page.getByRole('tab', { name: '我認領的', exact: true }).click();
    const mine = page.locator(`[data-pull-id="${BOOK_PULL}"]`);
    await expect(mine).toContainText('方向探索與陪跑入門・維護者');
    await expect(mine).toContainText('e2e-book-maintainer');
  } finally {
    await e2eAuthPool.query('DELETE FROM maintainer_review_claims WHERE pull_id=$1', [BOOK_PULL]);
    await e2eAuthPool.query('DELETE FROM maintainer_jobs WHERE repository_id=$1', [BOOK_REPO]);
    await e2eAuthPool.query('DELETE FROM maintainer_ownership_changes WHERE repository_id=$1', [BOOK_REPO]);
    await e2eAuthPool.query('DELETE FROM maintainer_handoffs WHERE repository_id=$1', [BOOK_REPO]);
    await e2eAuthPool.query('DELETE FROM maintainer_pull_requests WHERE repository_id=$1', [BOOK_REPO]);
    await e2eAuthPool.query('DELETE FROM maintainer_repositories WHERE repository_id=$1', [BOOK_REPO]);
    await e2eAuthPool.query('DELETE FROM skill_book_maintainers WHERE book_id=$1 AND user_id=$2', ['career-guide', REVIEWER]);
    if (!ownedBefore) await e2eAuthPool.query('DELETE FROM skill_editorial_ownership WHERE book_id=$1', ['career-guide']);
    await e2eAuthPool.query('DELETE FROM platform_admins WHERE admin_id=$1', [BOOK_ADMIN]);
    const priorGithub = github.rows[0] as { community_id: string; github_user_id: string; github_login: string; encrypted_tokens: string } | undefined;
    if (priorGithub) {
      await e2eAuthPool.query(`INSERT INTO github_social_connections (user_id, community_id, github_user_id, github_login, encrypted_tokens)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (user_id) DO UPDATE SET community_id=EXCLUDED.community_id, github_user_id=EXCLUDED.github_user_id,
          github_login=EXCLUDED.github_login, encrypted_tokens=EXCLUDED.encrypted_tokens`,
      [REVIEWER, priorGithub.community_id, priorGithub.github_user_id, priorGithub.github_login, priorGithub.encrypted_tokens]);
    } else {
      await e2eAuthPool.query('DELETE FROM github_social_connections WHERE user_id=$1', [REVIEWER]);
    }
    for (const officer of officers.rows as Array<{ guild_key: string; user_id: string }>) {
      await e2eAuthPool.query(`INSERT INTO positioning_guild_officers (community_id, guild_key, user_id) VALUES ($1,$2,$3)
        ON CONFLICT (community_id, guild_key) DO UPDATE SET user_id=EXCLUDED.user_id`,
      [DEMO_COMMUNITY, officer.guild_key, officer.user_id]);
    }
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

test('a guild leader hands a pull and an issue to a local AI', async ({ page, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const prior = await snapshot(e2eAuthPool);
  await wipe(e2eAuthPool);
  await appoint(e2eAuthPool);
  await seed(e2eAuthPool);
  await e2eAuthPool.query(`UPDATE maintainer_pull_requests SET queue_state='ready', queue_reasons=$2::jsonb WHERE pull_id=$1`,
    [PULLS.open, JSON.stringify([{ code: 'ready_human_approved', message: '已有有效核准，而且必要檢查通過。' }])]);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page);
    await navigate(page, '公會管理');
    await page.getByRole('button', { name: 'PR 審核', exact: true }).click();
    const own = page.locator(`[data-pull-id="${PULLS.own}"]`);
    await own.getByRole('button', { name: '詳情', exact: true }).click();
    await own.getByRole('button', { name: '交給本機 AI…', exact: true }).click();
    await expect(own.locator('option[value="merge"]')).toHaveAttribute('disabled', '');
    await expect(own).toContainText('只有已核准（有效核准落在目前的提交上）而且 CI 通過的 PR，才能交給 AI 合併。');
    const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/guild-reviews/${PULLS.own}/handoffs`));
    await own.getByRole('button', { name: '產生任務', exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    const firstKey = createdResponse.request().headers()['idempotency-key'];
    const fixId = await generatedCommand(own, 'claude');
    await saveTaskFile(page, own, fixId);
    await expect(own.getByRole('list', { name: '最近的交接' })).toContainText('@e2e-guild-leader');
    await expectCommandTokens(page);
    await page.screenshot({ path: 'test-results/repo-maintainer-handoff-guild-1280.png', fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await expectCommandTokens(page);
    await page.screenshot({ path: 'test-results/repo-maintainer-handoff-guild-dark-1280.png', fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

    await page.setViewportSize({ width: 390, height: 844 });
    const download = own.getByRole('button', { name: '下載任務檔', exact: true });
    await download.scrollIntoViewIfNeeded();
    const box = await download.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThan(220);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await own.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/repo-maintainer-handoff-guild-390.png', fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/repo-maintainer-handoff-guild-dark-390.png', fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.setViewportSize({ width: 1280, height: 900 });
    await own.getByRole('button', { name: '再產生一個', exact: true }).click();
    await expect(own.getByRole('button', { name: '產生任務', exact: true })).toBeVisible();
    await expect(own.getByLabel('工作')).toHaveValue('fix');
    await expect(own.getByLabel('工具')).toHaveValue('claude');
    const again = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/guild-reviews/${PULLS.own}/handoffs`));
    await own.getByRole('button', { name: '產生任務', exact: true }).click();
    const againResponse = await again;
    expect(againResponse.status()).toBe(201);
    expect(againResponse.request().headers()['idempotency-key']).not.toBe(firstKey);

    await page.getByRole('tab', { name: '已核准', exact: true }).click();
    const ready = page.locator(`[data-pull-id="${PULLS.open}"]`);
    await ready.getByRole('button', { name: '詳情', exact: true }).click();
    await ready.getByRole('button', { name: '交給本機 AI…', exact: true }).click();
    await expect(ready.locator('option[value="merge"]')).not.toHaveAttribute('disabled');
    await ready.getByLabel('工作').selectOption({ label: '讓 AI 合併這個 PR' });
    const merged = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/guild-reviews/${PULLS.open}/handoffs`));
    await ready.getByRole('button', { name: '產生任務', exact: true }).click();
    expect((await merged).status()).toBe(201);
    await generatedCommand(ready, 'claude');
    await ready.getByText('預覽任務內容', { exact: true }).click();
    const preview = await ready.locator('pre').innerText();
    expect(preview).toContain(`--match-head-commit ${HEAD}`);
    expect(preview).not.toContain('--admin');

    const issue = page.locator('details.handoff-panel');
    await expect(issue).toBeVisible();
    await issue.locator('summary').click();
    const repo = issue.getByLabel('交接儲存庫');
    await expect(repo.locator('option')).toHaveCount(2);
    await expect(repo).toContainText('FreeTWAI-AI/e2e-guild-own');
    await expect(repo).toContainText('FreeTWAI-AI/e2e-guild-open');
    await expect(repo).not.toContainText('e2e-guild-other');
    await expect(repo).not.toContainText('e2e-guild-admin');
    await repo.selectOption({ label: 'FreeTWAI-AI/e2e-guild-own' });
    await issue.getByLabel('Issue 編號').fill('18');
    await issue.getByLabel('工具').selectOption({ label: 'grok CLI' });
    const issued = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/guild-reviews/repositories/${REPOS.own}/issue-handoffs`));
    await issue.getByRole('button', { name: '產生任務', exact: true }).click();
    const issuedResponse = await issued;
    expect(issuedResponse.status()).toBe(201);
    const issueKey = issuedResponse.request().headers()['idempotency-key'];
    await generatedCommand(issue, 'grok');
    await issue.getByText('預覽任務內容', { exact: true }).click();
    await expect(issue.locator('pre')).toContainText('Closes #18');
    await expect(issue.locator('pre')).not.toContainText('平台觀察到的資料');
    await issue.getByRole('button', { name: '再產生一個', exact: true }).click();
    await expect(issue.getByRole('button', { name: '產生任務', exact: true })).toBeVisible();
    await expect(issue.getByLabel('Issue 編號')).toHaveValue('');
    await expect(issue.getByLabel('交接儲存庫')).toHaveValue(REPOS.own);
    await expect(issue.getByLabel('工具')).toHaveValue('grok');
    await issue.getByLabel('Issue 編號').fill('19');
    const issuedAgain = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/guild-reviews/repositories/${REPOS.own}/issue-handoffs`));
    await issue.getByRole('button', { name: '產生任務', exact: true }).click();
    const issuedAgainResponse = await issuedAgain;
    expect(issuedAgainResponse.status()).toBe(201);
    expect(issuedAgainResponse.request().headers()['idempotency-key']).not.toBe(issueKey);
  } finally {
    await wipe(e2eAuthPool);
    await restore(e2eAuthPool, prior);
  }
});
