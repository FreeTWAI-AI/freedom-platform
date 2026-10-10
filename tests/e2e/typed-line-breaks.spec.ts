import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { navigate } from './navigation.js';
import { test, expect, type Locator, type Page } from './fixtures.js';
import { DEMO_COMMUNITY, DEMO_USERS } from '../../packages/testing/seed.js';

const maker = DEMO_USERS[0];
const stamp = randomUUID().replaceAll('-', '').slice(0, 12);
const workTitle = `換行工作 ${stamp}`;
const workObjective = '把會議紀錄整理成共同筆記。\n也能把筆記交給下一班的人。';
const guildKey = `guild_custom_${stamp}`;
const guildName = `換行公會 ${stamp.slice(0, 6)}`;
const guildPurpose = '陪會員把想法做成這週的練習。\n做完再一起看下一步。';
const skillTitle = `換行技能 ${stamp}`;
const skillDescription = '把一段錄音整理成可重用的筆記。\n也標出還需要人檢查的地方。';
const storeName = `換行商店 ${stamp.slice(0, 6)}`;
const storeDescription = '店裡收的是小批量手作。\n出貨前會再跟你確認顏色。';
const squadName = `換行小隊 ${stamp.slice(0, 6)}`;
const squadPurpose = '這季想一起完成一份可分享的練習。\n歡迎會寫文件的夥伴。';
const eventTitle = `換行活動 ${stamp.slice(0, 6)}`;
const eventDescription = '上午先看彼此的作品。\n下午留時間改下一步。';
const serviceTitle = `換行服務 ${stamp.slice(0, 6)}`;
const serviceSummary = '第一行說明這項服務能幫上什麼。\n第二行寫給來看卡片的人。\n第三行應被卡片收成兩行。';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(maker.email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible();
}

function rendered(locator: Locator) {
  return locator.evaluate(node => (node as HTMLElement).innerText);
}

function card(page: Page, title: string) {
  return page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();
}

test('typed multi-line text keeps its line breaks on the pages that show it', async ({ page, e2eAuthPool }) => {
  test.setTimeout(180_000);
  const workId = randomUUID();
  const skillId = randomUUID();
  const projectId = randomUUID();
  const versionId = randomUUID();
  const storeId = randomUUID();
  const squadId = randomUUID();
  const eventId = randomUUID();
  const serviceId = randomUUID();
  const sha = 'a'.repeat(64);
  const commit = 'b'.repeat(40);
  const repositoryId = `${Date.now()}`;
  const repository = `example/newline-${stamp}`;
  const repositoryUrl = `https://github.com/${repository}`;
  const payload = {
    title: skillTitle,
    description: skillDescription,
    use_notes: '先看原作 README。\n再在自己的帳號試一次。',
    relationship: 'curator',
    share_introductions: ['換行技能的一則分享短文'],
  };
  const starts = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const ends = new Date(starts.getTime() + 2 * 60 * 60 * 1000);
  await e2eAuthPool.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,participation_terms_sha256,claim_window_expires_at,due_at)
    VALUES($1,$2,$3,$4,$5,'完成條件寫在第二行之前。','完成後可以留下自己的筆記。','open','{}',$6,now()+interval '7 days',now()+interval '14 days')`,
  [workId, DEMO_COMMUNITY, maker.user_id, workTitle, workObjective, sha]);
  await e2eAuthPool.query(`INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key)
    VALUES($1,$2,$3,$4,'先完成一件可以核對的小事。','guilds')`,
  [guildKey, `custom_${stamp}`, guildName, guildPurpose]);
  await e2eAuthPool.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,repository_id,repository_full_name,repository_url,relationship)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'curator')`,
  [projectId, DEMO_COMMUNITY, maker.user_id, skillTitle, skillDescription, payload.use_notes, repositoryId, repository, repositoryUrl]);
  await e2eAuthPool.query(`INSERT INTO oss_project_versions(version_id,project_id,repository_id,commit_sha,default_branch,repository_full_name,repository_url,readme_url,license_spdx,is_fork,archived,source_snapshot,source_sha256,facts_sha256,inspected_at)
    VALUES($1,$2,$3,$4,'main',$5,$6,$7,'MIT',false,false,'{}',$8,$8,now())`,
  [versionId, projectId, repositoryId, commit, repository, repositoryUrl, `${repositoryUrl}#readme`, sha]);
  await e2eAuthPool.query('UPDATE oss_projects SET current_version_id=$2 WHERE project_id=$1', [projectId, versionId]);
  await e2eAuthPool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,status,payload,payload_sha256,consent_to_share,project_id,project_version_id,published_at,grant_consumed_at)
    VALUES($1,$2,$3,'published',$4,$5,true,$6,$7,now(),now())`,
  [skillId, DEMO_COMMUNITY, maker.user_id, payload, createHash('sha256').update(JSON.stringify(payload)).digest('hex'), projectId, versionId]);
  await e2eAuthPool.query(`INSERT INTO retail_stores(store_id,community_id,seller_ref,name,description,support_contact)
    VALUES($1,$2,$3,$4,$5,'店內留言')`,
  [storeId, DEMO_COMMUNITY, maker.user_id, storeName, storeDescription]);
  await e2eAuthPool.query(`INSERT INTO member_squads(squad_id,community_id,name,kind,purpose,owner_ref)
    VALUES($1,$2,$3,'project',$4,$5)`,
  [squadId, DEMO_COMMUNITY, squadName, squadPurpose, maker.user_id]);
  await e2eAuthPool.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')`, [squadId, maker.user_id]);
  await e2eAuthPool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,'online','線上教室','published','open','other')`,
  [eventId, DEMO_COMMUNITY, maker.user_id, eventTitle, eventDescription, starts.toISOString(), ends.toISOString()]);
  await e2eAuthPool.query(`INSERT INTO member_services(service_id,community_id,owner_user_id,title,category,summary,service_mode,contacts,state)
    VALUES($1,$2,$3,$4,'design',$5,'online','[{"label":"網站","url":"https://example.com/newline"}]'::jsonb,'active')`,
  [serviceId, DEMO_COMMUNITY, maker.user_id, serviceTitle, serviceSummary]);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    await navigate(page, '社群任務');
    const work = card(page, workTitle);
    await expect(work).toBeVisible();
    expect(await rendered(work.locator('p', { hasText: '共同筆記' }))).toBe(workObjective);

    await navigate(page, '職業公會');
    await page.getByLabel('搜尋公會', { exact: true }).fill(guildName);
    const guild = page.getByRole('article', { name: guildName, exact: true });
    await expect(guild).toBeVisible();
    expect(await rendered(guild.locator('p.guild-purpose'))).toBe(guildPurpose);

    await navigate(page, '技能書架');
    await page.getByLabel('搜尋社群技能書', { exact: true }).fill(skillTitle);
    const skill = card(page, skillTitle);
    await expect(skill).toBeVisible();
    expect(await rendered(skill.locator('p.skill-library-purpose'))).toBe(skillDescription);

    await navigate(page, '我可以賣東西');
    await page.getByText('查看舊版商品與合作資料', { exact: true }).click();
    const store = card(page, storeName);
    await expect(store).toBeVisible();
    expect(await rendered(store.locator('p', { hasText: '小批量' }))).toBe(storeDescription);

    await navigate(page, '小隊集合');
    const squad = card(page, squadName);
    await expect(squad).toBeVisible();
    await squad.getByRole('button',{name:`查看小隊：${squadName}`}).click();
    expect(await rendered(page.getByRole('region',{name:'小隊詳情'}).locator('p.multiline-text'))).toBe(squadPurpose);

    await navigate(page, '社群活動');
    const event = card(page, eventTitle);
    await expect(event).toBeVisible();
    expect(await rendered(event.locator('p', { hasText: '彼此的作品' }))).toBe(eventDescription);

    await navigate(page, '社員服務');
    const service = card(page, serviceTitle);
    await expect(service).toBeVisible();
    const summary = service.locator('p.service-summary');
    const clamp = await summary.evaluate(node => {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      return {
        text: element.innerText,
        full: element.textContent,
        clamp: style.getPropertyValue('-webkit-line-clamp'),
        whiteSpace: style.whiteSpace,
        clipped: element.scrollHeight > element.clientHeight + 1,
      };
    });
    expect(clamp.full).toBe(serviceSummary);
    expect(clamp.text).toContain('\n');
    expect(clamp.clamp).toBe('2');
    expect(clamp.whiteSpace).toBe('pre-wrap');
    expect(clamp.clipped).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await navigate(page, '社群任務');
    const narrow = card(page, workTitle);
    await expect(narrow).toBeVisible();
    const fit = await narrow.evaluate(node => {
      const article = node as HTMLElement;
      const bounds = article.getBoundingClientRect();
      return { scrollWidth: document.documentElement.scrollWidth, viewport: window.innerWidth, left: bounds.left, right: bounds.right };
    });
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.viewport + 1);
    expect(fit.left).toBeGreaterThanOrEqual(-1);
    expect(fit.right).toBeLessThanOrEqual(fit.viewport + 1);

    mkdirSync('test-results/typed-line-breaks-shots', { recursive: true });
    const surfaces = [
      { key: 'task', nav: '社群任務', title: workTitle },
      { key: 'guild', nav: '職業公會', title: guildName, search: ['搜尋公會', guildName] as const },
      { key: 'service', nav: '社員服務', title: serviceTitle },
    ];
    for (const theme of [{ id: 'light', label: '自由工坊－明亮' }, { id: 'dark', label: '自由工坊－夜航' }] as const) {
      const settings = page.getByRole('button', { name: '設定', exact: true });
      if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
      await page.getByRole('menuitemradio', { name: theme.label, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
      if (await settings.getAttribute('aria-expanded') === 'true') await settings.click();
      for (const size of [{ width: 1440, height: 900, label: '1440' }, { width: 390, height: 844, label: '390' }] as const) {
        await page.setViewportSize(size);
        for (const surface of surfaces) {
          await navigate(page, surface.nav);
          if (surface.search) await page.getByLabel(surface.search[0], { exact: true }).fill(surface.search[1]);
          const shot = surface.key === 'guild'
            ? page.getByRole('article', { name: guildName, exact: true })
            : card(page, surface.title);
          await expect(shot).toBeVisible();
          await shot.scrollIntoViewIfNeeded();
          await shot.screenshot({ path: `test-results/typed-line-breaks-shots/${surface.key}-${theme.id}-${size.label}.png` });
        }
      }
    }
  } finally {
    await e2eAuthPool.query('DELETE FROM skill_submissions WHERE submission_id=$1', [skillId]);
    await e2eAuthPool.query('UPDATE oss_projects SET current_version_id=NULL WHERE project_id=$1', [projectId]);
    await e2eAuthPool.query('DELETE FROM oss_project_versions WHERE project_id=$1', [projectId]);
    await e2eAuthPool.query('DELETE FROM oss_projects WHERE project_id=$1', [projectId]);
    await e2eAuthPool.query('DELETE FROM member_squad_memberships WHERE squad_id=$1', [squadId]);
    await e2eAuthPool.query('DELETE FROM member_squads WHERE squad_id=$1', [squadId]);
    await e2eAuthPool.query('DELETE FROM community_events WHERE event_id=$1', [eventId]);
    await e2eAuthPool.query('DELETE FROM retail_stores WHERE store_id=$1', [storeId]);
    await e2eAuthPool.query('DELETE FROM member_services WHERE service_id=$1', [serviceId]);
    // Work IDs are immutable and cannot be deleted/rebound after WORK-A.
    // This synthetic row is removed by the fixture's isolated schema teardown.
    await e2eAuthPool.query('DELETE FROM positioning_guild_catalog WHERE guild_key=$1', [guildKey]);
  }
});
