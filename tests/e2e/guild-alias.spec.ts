import {randomUUID} from 'node:crypto';
import type {Locator, Page} from '@playwright/test';
import {navigate} from './navigation.js';
import {test, expect} from './fixtures.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS} from '../../packages/testing/seed.js';
import {E2E_AUTHOR_CLAIM_ADMIN_EMAIL, E2E_AUTHOR_CLAIM_ADMIN_TOKEN} from '../../packages/testing/e2e-admin.js';

const shot=(file:string)=>`test-results/guild-alias-${file}`;
const LONG_ALIAS='敢於體驗表達感受實驗小小兵';
const FIELD='guild_ai_field', MARKETING='guild_marketing', SECURITY='guild_security';
const BUILTIN_KEYS=[FIELD, MARKETING, SECURITY];

type CatalogRow={guild_key:string;name:string;alias:string;profession_title:string;catalog_version:number};
async function snapshot(db:import('pg').Pool,key:string){
  const row=(await db.query('SELECT guild_key,name,alias,profession_title,catalog_version FROM positioning_guild_catalog WHERE guild_key=$1',[key])).rows[0];
  if(!row) throw new Error(`missing guild ${key}`);
  return {...row,catalog_version:Number(row.catalog_version)} as CatalogRow;
}
async function colors(page:Page,theme:string,key:string){
  return page.evaluate(({theme,key})=>{
    localStorage.setItem('freedom-theme',theme);
    document.documentElement.dataset.theme=theme;
    const card=document.querySelector(`[data-guild-key="${key}"]`);
    const alias=card?.querySelector<HTMLElement>('.guild-name-alias');
    const main=card?.querySelector<HTMLElement>('.guild-name-main');
    if(!card||!alias||!main) return null;
    const probe=document.createElement('span');
    probe.style.color='var(--muted)';
    card.appendChild(probe);
    const read=(element:Element)=>getComputedStyle(element).color;
    const result={muted:read(probe),alias:read(alias),main:read(main)};
    probe.remove();
    return result;
  },{theme,key});
}
async function fits(page:Page){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
}
async function aliasInside(page:Page,key:string){
  expect(await page.locator(`[data-guild-key="${key}"]`).evaluate(article=>{
    const alias=article.querySelector('.guild-name-alias');
    if(!alias) return false;
    const box=alias.getBoundingClientRect(),host=article.getBoundingClientRect();
    return box.width>0&&box.left>=host.left-1&&box.right<=host.right+1;
  })).toBe(true);
}
async function badgeBesideHeading(card:Locator){
  const boxes=await card.evaluate(article=>{
    const heading=article.querySelector('h3'),badge=article.querySelector('.guild-card-topline .badge');
    if(!heading||!badge) return null;
    const h=heading.getBoundingClientRect(),b=badge.getBoundingClientRect();
    return {headingTop:h.top,headingRight:h.right,badgeTop:b.top,badgeLeft:b.left};
  });
  expect(boxes).not.toBeNull();
  expect(Math.abs(boxes!.badgeTop-boxes!.headingTop)).toBeLessThanOrEqual(8);
  expect(boxes!.badgeLeft).toBeGreaterThan(boxes!.headingRight);
}

test('guild aliases sit beside the name, and an admin can edit profiles, approve and merge',async({page,browser,e2eAuthPool})=>{
  test.setTimeout(120_000);
  const stamp=randomUUID().slice(0,8);
  const approveName=`別名核准${stamp}`,mergeName=`併入申請${stamp}`;
  const approveId=randomUUID(),mergeId=randomUUID();
  const prior=await e2eAuthPool.query('SELECT admin_id FROM platform_admins WHERE email=$1',[E2E_AUTHOR_CLAIM_ADMIN_EMAIL]);
  const createdAdmin=prior.rowCount===0;
  const adminId=createdAdmin?randomUUID():prior.rows[0].admin_id as string;
  const builtins=await Promise.all(BUILTIN_KEYS.map(key=>snapshot(e2eAuthPool,key)));
  let adminContext:Awaited<ReturnType<typeof browser.newContext>>|undefined;
  try{
    if(createdAdmin) await e2eAuthPool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,E2E_AUTHOR_CLAIM_ADMIN_EMAIL,'公會別名管理員']);
    await e2eAuthPool.query('INSERT INTO guild_creation_applications(application_id,community_id,user_id,name,profession,reason) VALUES($1,$2,$3,$4,$5,$6),($7,$2,$3,$8,$5,$6)',[approveId,DEMO_COMMUNITY,DEMO_USERS[0].user_id,approveName,'研究','想把一個可以公開核對的方向整理成公會。',mergeId,mergeName]);
    await e2eAuthPool.query('UPDATE positioning_guild_catalog SET alias=$2 WHERE guild_key=$1',[FIELD,LONG_ALIAS]);
    await page.setViewportSize({width:1280,height:900});
    await page.goto('/');
    await page.getByLabel('電子郵件',{exact:true}).fill(DEMO_USERS[0].email);
    await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
    await page.getByRole('button',{name:'登入',exact:true}).click();
    await navigate(page,'職業公會');
    const field=page.getByRole('article',{name:'AI 導入與驗證公會',exact:true});
    const plain=page.getByRole('article',{name:'成長與行銷公會',exact:true});
    await expect(field.locator('h3 .guild-name-main')).toHaveText('AI 導入與驗證公會');
    await expect(field.locator('h3 .guild-name-sep')).toHaveText('·');
    await expect(field.locator('h3 .guild-name-alias')).toContainText(LONG_ALIAS);
    await expect(plain.locator('.guild-name-sep')).toHaveCount(0);
    await expect(plain.locator('.guild-name-alias')).toHaveCount(0);
    await page.getByLabel('搜尋公會',{exact:true}).fill(LONG_ALIAS);
    await expect(field).toBeVisible();
    await expect(plain).toHaveCount(0);
    await page.getByLabel('搜尋公會',{exact:true}).fill('');
    await expect(plain).toBeVisible();
    for(const width of [390,820,1280]){
      await page.setViewportSize({width,height:width===390?844:1000});
      await field.scrollIntoViewIfNeeded();
      await fits(page);
      await aliasInside(page,FIELD);
      await badgeBesideHeading(field);
      await badgeBesideHeading(plain);
    }
    for(const theme of ['light','dark','versefolk']){
      const color=await colors(page,theme,FIELD);
      expect(color,theme).not.toBeNull();
      expect(color!.alias,theme).toBe(color!.muted);
      expect(color!.alias,theme).not.toBe(color!.main);
    }
    await page.evaluate(()=>{localStorage.setItem('freedom-theme','light');document.documentElement.dataset.theme='light';});
    for(const [width,file] of [[390,'guild-page-light-390.png'],[1280,'guild-page-light-1280.png']] as const){
      await page.setViewportSize({width,height:width===390?844:900});
      await field.scrollIntoViewIfNeeded();
      await page.screenshot({path:shot(file)});
      await field.screenshot({path:shot(`field-${file}`)});
      await plain.screenshot({path:shot(`plain-${file}`)});
    }
    await page.evaluate(()=>{localStorage.setItem('freedom-theme','dark');document.documentElement.dataset.theme='dark';});
    for(const [width,file] of [[390,'guild-page-dark-390.png'],[1280,'guild-page-dark-1280.png']] as const){
      await page.setViewportSize({width,height:width===390?844:900});
      await field.scrollIntoViewIfNeeded();
      await page.screenshot({path:shot(file)});
      await field.screenshot({path:shot(`field-${file}`)});
      await plain.screenshot({path:shot(`plain-${file}`)});
    }

    adminContext=await browser.newContext({viewport:{width:1280,height:900}});
    const admin=await adminContext.newPage();
    await admin.route('**/admin/api/**',async route=>{
      await route.continue({headers:{...route.request().headers(),'cf-access-jwt-assertion':E2E_AUTHOR_CLAIM_ADMIN_TOKEN}});
    });
    await admin.goto('/admin');
    await admin.getByRole('button',{name:'公會管理',exact:true}).click();
    const management=admin.locator('.admin-guild-management');
    await management.getByLabel('搜尋公會',{exact:true}).fill('成長與行銷');
    const marketing=management.getByRole('article',{name:'成長與行銷公會',exact:true});
    await marketing.getByRole('button',{name:'編輯名稱與別名',exact:true}).click();
    await expect(marketing.getByText('內建公會的名稱與職業稱號由平台維護。')).toBeVisible();
    await expect(marketing.getByLabel('公會名稱',{exact:true})).toHaveCount(0);
    await marketing.getByLabel('別名',{exact:true}).fill('行銷小名');
    await marketing.getByLabel('調整理由',{exact:true}).fill('補上對外使用的別名。');
    for(const [width,file] of [[390,'admin-edit-builtin-390.png'],[1280,'admin-edit-builtin-1280.png']] as const){
      await admin.setViewportSize({width,height:width===390?900:900});
      await marketing.scrollIntoViewIfNeeded();
      await fits(admin);
      await admin.screenshot({path:shot(file)});
    }
    await marketing.getByRole('button',{name:'儲存名稱與別名',exact:true}).click();
    await expect(marketing.getByText('已更新公會名稱與別名。')).toBeVisible();
    await expect(marketing.locator('.guild-name-alias')).toContainText('行銷小名');

    await admin.getByRole('button',{name:'公會申請',exact:true}).click();
    const approveCard=admin.locator('article').filter({has:admin.getByRole('heading',{name:approveName,exact:true})});
    await expect(approveCard).toBeVisible();
    await approveCard.getByLabel('別名',{exact:true}).fill('核准小名');
    await approveCard.getByLabel('職業稱號',{exact:true}).fill('核准實踐者');
    await approveCard.getByLabel('公會宗旨',{exact:true}).fill('整理一個可以公開核對的公會目標。');
    await approveCard.getByLabel('新成員的第一步',{exact:true}).fill('先讀入門技能書並完成一件小事。');
    await approveCard.getByLabel('方向探索與陪跑入門',{exact:true}).check();
    await approveCard.getByLabel('審核說明',{exact:true}).fill('核准並附上別名與稱號。');
    await approveCard.getByRole('button',{name:'保存審核決定',exact:true}).click();
    await expect(approveCard.getByText('已核准',{exact:true})).toBeVisible();

    await admin.getByRole('button',{name:'公會管理',exact:true}).click();
    await management.getByLabel('搜尋公會',{exact:true}).fill(approveName);
    const custom=management.getByRole('article',{name:approveName,exact:true});
    await custom.getByRole('button',{name:'編輯名稱與別名',exact:true}).click();
    const renamed=`${approveName}改`;
    await custom.getByLabel('公會名稱',{exact:true}).fill(renamed);
    await custom.getByLabel('別名',{exact:true}).fill('改過的別名');
    await custom.getByLabel('職業稱號',{exact:true}).fill('改過的稱號');
    await custom.getByLabel('調整理由',{exact:true}).fill('調整自訂公會的名稱與稱號。');
    for(const [width,file] of [[390,'admin-edit-custom-390.png'],[1280,'admin-edit-custom-1280.png']] as const){
      await admin.setViewportSize({width,height:900});
      await custom.scrollIntoViewIfNeeded();
      await fits(admin);
      await admin.screenshot({path:shot(file)});
    }
    await custom.getByRole('button',{name:'儲存名稱與別名',exact:true}).click();
    await expect(management.getByRole('article',{name:renamed,exact:true}).locator('.guild-name-alias')).toContainText('改過的別名');
    await expect(management.getByText('已更新公會名稱與別名。')).toBeVisible();
    const stored=await e2eAuthPool.query('SELECT profession_title FROM positioning_guild_catalog WHERE name=$1',[renamed]);
    expect(stored.rows[0].profession_title).toBe('改過的稱號');

    await admin.getByRole('button',{name:'公會申請',exact:true}).click();
    const mergeCard=admin.locator('article').filter({has:admin.getByRole('heading',{name:mergeName,exact:true})});
    await mergeCard.getByLabel('審核決定',{exact:true}).selectOption({label:'併入既有公會'});
    await expect(mergeCard.getByLabel('別名',{exact:true})).toHaveValue(mergeName);
    await mergeCard.getByLabel('目標公會',{exact:true}).selectOption(SECURITY);
    await mergeCard.getByLabel('別名',{exact:true}).fill('資安小名');
    await mergeCard.getByLabel('審核說明',{exact:true}).fill('併入資安公會並留下別名。');
    await expect(mergeCard.getByRole('button',{name:'併入這個公會',exact:true})).toBeEnabled();
    for(const [width,file] of [[390,'admin-merge-390.png'],[1280,'admin-merge-1280.png']] as const){
      await admin.setViewportSize({width,height:900});
      await mergeCard.scrollIntoViewIfNeeded();
      await fits(admin);
      if(width===1280){
        const size=await mergeCard.evaluate(card=>{
          const button=card.querySelector('button.btn-primary');
          if(!button) return null;
          return {button:button.getBoundingClientRect().width,card:card.getBoundingClientRect().width};
        });
        expect(size).not.toBeNull();
        expect(size!.button).toBeLessThan(size!.card/2);
      }
      await mergeCard.screenshot({path:shot(file)});
    }
    await mergeCard.getByRole('button',{name:'併入這個公會',exact:true}).click();
    await expect(mergeCard.locator('.badge.guild-merged')).toHaveText('已併入');
    await expect(mergeCard.getByText('併入：資安公會',{exact:true})).toBeVisible();

    await page.setViewportSize({width:1280,height:900});
    await page.goto('/');
    await navigate(page,'職業公會');
    await page.getByLabel('搜尋公會',{exact:true}).fill('資安小名');
    const security=page.getByRole('article',{name:'資安公會',exact:true});
    await expect(security.locator('.guild-name-alias')).toContainText('資安小名');
    await expect(security.locator('.guild-name-sep')).toBeVisible();
    await page.getByLabel('搜尋公會',{exact:true}).fill('行銷小名');
    await expect(page.getByRole('article',{name:'成長與行銷公會',exact:true}).locator('.guild-name-alias')).toContainText('行銷小名');
  }finally{
    await adminContext?.close().catch(()=>{});
    const client=await e2eAuthPool.connect();
    try{
      await client.query('BEGIN');
      const ids=[approveId,mergeId];
      for(const id of ids) await client.query('DELETE FROM member_notifications WHERE source_key LIKE $1',[`guild-application/${id}/%`]);
      const linked=await client.query('SELECT approved_guild_key FROM guild_creation_applications WHERE application_id=ANY($1::uuid[])',[ids]);
      const custom=[...new Set(linked.rows.map(row=>row.approved_guild_key as string|null).filter((key):key is string=>!!key&&/^guild_custom_[0-9a-f]{32}$/i.test(key)))];
      await client.query('DELETE FROM guild_creation_applications WHERE application_id=ANY($1::uuid[])',[ids]);
      if(custom.length){
        await client.query('DELETE FROM guild_skill_book_bindings WHERE guild_key=ANY($1::text[])',[custom]);
        await client.query('DELETE FROM positioning_guild_officers WHERE guild_key=ANY($1::text[])',[custom]);
        await client.query('DELETE FROM positioning_guild_experts WHERE guild_key=ANY($1::text[])',[custom]);
        await client.query('DELETE FROM positioning_profession_memberships WHERE guild_key=ANY($1::text[])',[custom]);
        await client.query('DELETE FROM positioning_guild_catalog WHERE guild_key=ANY($1::text[])',[custom]);
      }
      for(const row of builtins) await client.query('UPDATE positioning_guild_catalog SET name=$2,alias=$3,profession_title=$4,catalog_version=$5 WHERE guild_key=$1',[row.guild_key,row.name,row.alias,row.profession_title,row.catalog_version]);
      const refs=[...ids,...custom,...BUILTIN_KEYS];
      await client.query("DELETE FROM platform_admin_audit WHERE action IN ('guild_profile_update','guild_application_review') AND target_ref=ANY($1::text[])",[refs]);
      if(createdAdmin){
        await client.query('DELETE FROM platform_admin_receipts WHERE admin_id=$1',[adminId]);
        await client.query('DELETE FROM platform_admin_audit WHERE admin_id=$1',[adminId]);
        await client.query('DELETE FROM platform_admins WHERE admin_id=$1',[adminId]);
      }
      await client.query('COMMIT');
    }catch(error){
      await client.query('ROLLBACK');
      throw error;
    }finally{client.release();}
  }
});
