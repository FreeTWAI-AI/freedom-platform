import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DEMO_USERS, DEMO_WORK } from '../../packages/testing/seed.js';
import { navigate } from './navigation.js';
import { test, expect, type Page } from './fixtures.js';

async function seedWorks(pool: Pool) {
  const ids = Array.from({length: 30}, () => randomUUID());
  const titles = ids.map((_, index) => `分頁工作 ${String(index + 1).padStart(2, '0')}`);
  const created = ids.map((_, index) => `2099-01-01T00:00:00.123${String(index).padStart(3, '0')}Z`);
  await pool.query(`WITH source AS (
      SELECT community_id,objective,acceptance_criteria,gain,participation_terms,participation_terms_sha256
      FROM work_items WHERE work_item_id=$4
    ), input AS (
      SELECT * FROM unnest($1::uuid[],$2::text[],$3::timestamptz[]) AS value(work_item_id,title,created_at)
    )
    INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,
      participation_terms_sha256,claim_window_expires_at,due_at,created_at)
    SELECT input.work_item_id,source.community_id,$5,input.title,source.objective,source.acceptance_criteria,source.gain,'open',
      source.participation_terms,source.participation_terms_sha256,'2099-01-02T00:00:00Z','2099-01-03T00:00:00Z',input.created_at
    FROM input CROSS JOIN source`, [ids, titles, created, DEMO_WORK, DEMO_USERS[1].user_id]);
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill('maker@local.test');
  await page.getByLabel('密碼', {exact: true}).fill('freedom-local-demo');
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('heading', {name: '會員首頁', exact: true})).toBeVisible();
}

const paginationHeadings = (page: Page) => page.getByRole('heading', {level: 3, name: /^分頁工作 \d{2}$/});

test('workbench and task board load bounded work pages without losing microsecond peers', async ({page, e2eAuthPool}) => {
  await seedWorks(e2eAuthPool);
  await page.setViewportSize({width: 1280, height: 900});
  await login(page);
  await navigate(page, '我的工作');
  await expect(paginationHeadings(page)).toHaveCount(24);
  const workbenchMore = page.getByRole('button', {name: '載入較早的社群工作', exact: true});
  await expect(workbenchMore).toBeVisible();
  await workbenchMore.click();
  await expect(paginationHeadings(page)).toHaveCount(30);
  await expect(workbenchMore).toHaveCount(0);

  await page.setViewportSize({width: 390, height: 844});
  await navigate(page, '社群任務');
  await expect(paginationHeadings(page)).toHaveCount(24);
  const taskBoardMore = page.getByRole('button', {name: '載入較早的工坊工作', exact: true});
  await expect(taskBoardMore).toBeVisible();
  await taskBoardMore.click();
  await expect(paginationHeadings(page)).toHaveCount(30);
  await expect(taskBoardMore).toHaveCount(0);
});
