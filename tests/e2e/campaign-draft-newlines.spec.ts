import { randomUUID } from 'node:crypto';
import { navigate } from './navigation.js';
import { test, expect, type Locator, type Page } from './fixtures.js';
import { DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';

const longUrl = `https://example.invalid/${'a'.repeat(96)}`;

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
}

function rendered(locator: Locator) {
  return locator.evaluate(node => (node as HTMLElement).innerText);
}

test('campaign drafts and project notes keep the line breaks a member typed', async ({ page, e2eAuthPool }) => {
  expect(longUrl).toHaveLength(120);
  const projectId = randomUUID(), versionId = randomUUID();
  const title = `換行作品 ${projectId.slice(0, 8)}`;
  const description = '可以把會議紀錄整理成共同筆記。\n也能把筆記分享給小隊。';
  const useNotes = '先閱讀 README。\n再在自己的帳號建立 fork。';
  const repositoryId = String(Date.now());
  const sha = 'a'.repeat(64), commit = 'b'.repeat(40);
  const repository = 'example/newline-notes';
  const repositoryUrl = 'https://github.com/example/newline-notes';
  await e2eAuthPool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'curator')`, [projectId, DEMO_COMMUNITY, DEMO_USERS[0].user_id, title, description, useNotes, repositoryId, repository, repositoryUrl]);
  await e2eAuthPool.query(`INSERT INTO oss_project_versions(version_id,project_id,repository_id,commit_sha,default_branch,repository_full_name,repository_url,readme_url,license_spdx,is_fork,archived,source_snapshot,source_sha256,facts_sha256,inspected_at)
    VALUES($1,$2,$3,$4,'main',$5,$6,$7,'MIT',false,false,'{}',$8,$8,now())`, [versionId, projectId, repositoryId, commit, repository, repositoryUrl, `${repositoryUrl}#readme`, sha]);
  await e2eAuthPool.query('UPDATE oss_projects SET current_version_id=$2 WHERE project_id=$1', [projectId, versionId]);
  try {
    await login(page);
    await navigate(page, '開源投稿');
    const project = page.getByRole('article', { name: `開源作品：${title}`, exact: true });
    await expect(project).toBeVisible();
    expect(await rendered(project.locator('p.project-copy').first())).toBe(description);
    expect(await rendered(project.locator('.help-box p.project-copy'))).toBe(useNotes);

    const campaignTitle = `換行草稿 ${randomUUID().slice(0, 8)}`;
    const brief = '週末下午的交流，不收費。\n請先讀完使用說明再來。';
    const draft = `第一行先說明這次交流要做的事。\n${longUrl}`;
    await navigate(page, '行銷工作室');
    await page.getByLabel('活動來源簡述', { exact: true }).fill(brief);
    await page.getByLabel('活動名稱', { exact: true }).fill(campaignTitle);
    await page.getByLabel('想分享給誰', { exact: true }).fill('剛加入的會員');
    await page.getByLabel('希望對方下一步做什麼', { exact: true }).fill('閱讀使用說明');
    await page.getByLabel('文案草稿', { exact: true }).fill(draft);
    await page.getByRole('button', { name: '儲存私人草稿', exact: true }).click();
    const card = page.getByRole('article', { name: `行銷活動：${campaignTitle}`, exact: true });
    await expect(card).toBeVisible();
    const draftCopy = card.locator('p.draft-copy');
    expect(await rendered(draftCopy)).toBe(draft);
    expect(await rendered(card.locator('dd .draft-copy'))).toBe(brief);

    await page.setViewportSize({ width: 390, height: 844 });
    const fit = await draftCopy.evaluate(node => {
      const paragraph = node as HTMLElement;
      const bounds = paragraph.closest('article')!.getBoundingClientRect();
      return { scrollWidth: paragraph.scrollWidth, clientWidth: paragraph.clientWidth, left: bounds.left, right: bounds.right, viewport: window.innerWidth };
    });
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 1);
    expect(fit.left).toBeGreaterThanOrEqual(-1);
    expect(fit.right).toBeLessThanOrEqual(fit.viewport + 1);
  } finally {
    await e2eAuthPool.query('UPDATE oss_projects SET current_version_id=NULL WHERE project_id=$1', [projectId]);
    await e2eAuthPool.query('DELETE FROM oss_project_versions WHERE project_id=$1', [projectId]);
    await e2eAuthPool.query('DELETE FROM oss_projects WHERE project_id=$1', [projectId]);
  }
});
