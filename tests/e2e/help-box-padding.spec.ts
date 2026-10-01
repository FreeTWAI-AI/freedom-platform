import { randomUUID } from 'node:crypto';
import { navigate } from './navigation.js';
import { expect, test, type Locator, type Page } from './fixtures.js';
import { DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';

const maker = DEMO_USERS[0];
const projectTitle = '內距檢查作品';
const draftTitle = `內距草稿 ${Date.now()}`;
const draftCopy = '歡迎先讀使用說明，再帶一個問題加入交流。';

type BoxMetrics = { paddingLeft: string; paddingRight: string; radius: string; inset: number };

function submission() {
  return {
    submission_id: 'sub-ready', status: 'ready_for_review', aggregate_version: 3, project_id: null, public_path: null,
    created_at: '2026-09-23T01:00:00Z', updated_at: '2026-09-23T01:00:00Z', illustration_url: null,
    grant_expires_at: null, grant_consumed_at: '2026-09-23T01:00:00Z', grant_revoked_at: null,
    payload: {
      repository_url: 'https://github.com/example/skill-demo', title: '流程整理技能', description: '讀取 README 後整理出的真實介紹。',
      use_notes: '安裝 Node.js 後執行第一個範例。', demo_url: null, relationship: 'maintainer', share_introductions: ['第一則介紹'],
    },
  };
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(maker.email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
}

async function useTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate(value => {
    localStorage.setItem('freedom-theme', value);
    document.documentElement.dataset.theme = value;
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function expectPaddedBox(box: Locator, label: string) {
  await expect(box, label).toBeVisible();
  const metrics = await box.evaluate((element): BoxMetrics => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.textContent && node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const text = walker.nextNode();
    const raw = text?.textContent ?? '';
    const start = raw.search(/\S/);
    const end = raw.search(/\s*$/);
    if (!text || start < 0 || end <= start) throw new Error('help box has no text');
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    const textRect = range.getBoundingClientRect();
    if (textRect.width <= 0) throw new Error('help box text has no width');
    return {
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      radius: style.borderTopLeftRadius,
      inset: textRect.left - rect.left,
    };
  });
  expect(metrics.paddingLeft, `${label} padding-left`).toBe('12px');
  expect(metrics.paddingRight, `${label} padding-right`).toBe('12px');
  expect(metrics.radius, `${label} border-top-left-radius`).toBe('12px');
  expect(metrics.inset, `${label} text inset`).toBeGreaterThanOrEqual(12);
}

test('help boxes pad their text in light and dark, and the login demo box stays padded', async ({ page, e2eAuthPool }) => {
  test.setTimeout(90_000);
  const projectId = randomUUID();
  const versionId = randomUUID();
  const repositoryId = String(Date.now());
  const sha = 'a'.repeat(64);
  try {
    await page.goto('/');
    const demo = page.getByRole('complementary', { name: '示範帳號' });
    await expect(demo).toBeVisible();
    const loginBox = await demo.evaluate(element => {
      const style = getComputedStyle(element);
      const paragraph = element.querySelector('p');
      const chips = element.querySelector('.chip-row');
      return {
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        radiusTopLeft: style.borderTopLeftRadius,
        radiusTopRight: style.borderTopRightRadius,
        radiusBottomRight: style.borderBottomRightRadius,
        radiusBottomLeft: style.borderBottomLeftRadius,
        paragraphMarginTop: paragraph ? getComputedStyle(paragraph).marginTop : null,
        chipMarginTop: chips ? getComputedStyle(chips).marginTop : null,
      };
    });
    expect(loginBox.paddingTop).toBe('12px');
    expect(loginBox.paddingRight).toBe('12px');
    expect(loginBox.paddingBottom).toBe('12px');
    expect(loginBox.paddingLeft).toBe('12px');
    expect(loginBox.radiusTopLeft).toBe('12px');
    expect(loginBox.radiusTopRight).toBe('12px');
    expect(loginBox.radiusBottomRight).toBe('12px');
    expect(loginBox.radiusBottomLeft).toBe('12px');
    expect(loginBox.paragraphMarginTop).toBe('0px');
    expect(loginBox.chipMarginTop).toBe('9.6px');

    await e2eAuthPool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship)
      VALUES($1,$2,$3,$4,'確認說明文字離左邊框有空隙。','先閱讀使用文件，再執行第一個範例。',$5,'example/help-box-padding','https://github.com/example/help-box-padding','curator')`,
    [projectId, DEMO_COMMUNITY, maker.user_id, projectTitle, repositoryId]);
    await e2eAuthPool.query(`INSERT INTO oss_project_versions(version_id,project_id,repository_id,commit_sha,default_branch,repository_full_name,repository_url,readme_url,license_spdx,is_fork,archived,source_snapshot,source_sha256,facts_sha256,inspected_at)
      VALUES($1,$2,$3,$4,'main','example/help-box-padding','https://github.com/example/help-box-padding','https://github.com/example/help-box-padding#readme','MIT',false,false,'{}',$5,$5,now())`,
    [versionId, projectId, repositoryId, 'b'.repeat(40), sha]);
    await e2eAuthPool.query('UPDATE oss_projects SET current_version_id=$2 WHERE project_id=$1', [projectId, versionId]);

    const ready = submission();
    await page.route('**/api/v1/me/skill-submissions**', async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/me/skill-submissions') return route.fulfill({ json: { items: [ready] } });
      if (path.endsWith(`/${ready.submission_id}`)) return route.fulfill({ json: ready });
      return route.fallback();
    });

    await login(page);
    await navigate(page, '行銷工作室');
    await page.getByLabel('活動來源簡述', { exact: true }).fill('會員自願交流，分享開源工具的使用經驗。');
    await page.getByLabel('活動名稱', { exact: true }).fill(draftTitle);
    await page.getByLabel('想分享給誰', { exact: true }).fill('剛加入的會員');
    await page.getByLabel('希望對方下一步做什麼', { exact: true }).fill('閱讀使用說明');
    await page.getByLabel('文案草稿', { exact: true }).fill(draftCopy);
    await page.getByRole('button', { name: '儲存私人草稿', exact: true }).click();
    const campaign = page.getByRole('article', { name: `行銷活動：${draftTitle}`, exact: true });
    await expect(campaign.getByText(draftCopy, { exact: true })).toBeVisible();

    for (const theme of ['light', 'dark'] as const) {
      await useTheme(page, theme);
      await navigate(page, '開源投稿');
      const project = page.getByRole('article', { name: `開源作品：${projectTitle}`, exact: true });
      await expect(project.getByText('如何開始', { exact: true })).toBeVisible();
      await expectPaddedBox(project.locator('.help-box'), `${theme} project`);

      const advanced = page.locator('details.work-sharing-advanced').filter({ has: page.getByText('使用 Agent 或聊天 AI 協助整理（進階）', { exact: true }) });
      if (!await advanced.evaluate(element => (element as HTMLDetailsElement).open)) {
        await page.getByText('使用 Agent 或聊天 AI 協助整理（進階）', { exact: true }).click();
      }
      await page.getByRole('button', { name: '上傳技能', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
      // A ready draft's button reads 預覽 or 預覽並送出 depending on the dialog version.
      await dialog.getByRole('button', { name: /^預覽(並送出)?：流程整理技能$/ }).click();
      const preview = dialog.getByRole('region', { name: '預覽：流程整理技能', exact: true });
      await expect(preview.getByText('如何開始', { exact: true })).toBeVisible();
      await expectPaddedBox(preview.locator('.help-box'), `${theme} upload`);
      await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
      await expect(dialog).toBeHidden();

      await navigate(page, '行銷工作室');
      await expectPaddedBox(campaign.locator('.help-box'), `${theme} campaign`);
    }
  } finally {
    await e2eAuthPool.query('UPDATE oss_projects SET current_version_id = NULL WHERE project_id = $1', [projectId]);
    await e2eAuthPool.query('DELETE FROM oss_project_versions WHERE project_id = $1', [projectId]);
    await e2eAuthPool.query('DELETE FROM oss_projects WHERE project_id = $1', [projectId]);
    await e2eAuthPool.query('DELETE FROM marketing_campaign_drafts WHERE owner_ref = $1 AND title = $2', [maker.user_id, draftTitle]);
  }
});
