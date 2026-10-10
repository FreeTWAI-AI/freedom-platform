import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import sharp from 'sharp';
import {test,expect,type Page,type Locator,type APIRequestContext} from './member-feature-fixture.js';
import {navigate} from './navigation.js';

const COMMUNITY='10000000-0000-4000-8000-000000000001';
type Account={id:string;email:string};

async function account(db:Pool,label:string):Promise<Account>{
  const id=randomUUID(),email=`outcomes-${id}@local.test`;
  await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,community_id,$2,$3,password_hash,$4,false FROM users WHERE email='maker@local.test'`,[id,email,label,randomUUID()]);
  return {id,email};
}
async function login(page:Page,user:Account){
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill(user.email);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.locator('.shell')).toBeVisible();
}
async function event(db:Pool,author:Account){
  const id=randomUUID();
  await db.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    VALUES($1,$2,$3,$4,'作者整理活動回顧',now()-interval '2 days',now()-interval '1 day','online','隔離線上活動','published','open','other')`,[id,COMMUNITY,author.id,`精華驗收 ${id}`]);
  return id;
}
async function openEvent(page:Page,id:string){
  await page.goto(`/#highlights/${id}`);
  const section=page.getByRole('region',{name:'活動精華與成果'});
  await expect(section).toBeVisible();
  await section.getByText('整理自己的精華、媒體與成果來源',{exact:true}).click();
  return section;
}
async function saveRecap(section:Locator,title:string,source?:string){
  await section.getByLabel('精華標題').fill(title);
  await section.getByLabel('活動摘要').fill('這是作者明確撰寫的活動摘要，不是出席或官方驗收。');
  await section.getByLabel('發布範圍').selectOption('public');
  if(source)await section.getByLabel(new RegExp(`小隊成果 · ${source}`)).check();
  await section.getByRole('button',{name:'儲存私人草稿',exact:true}).click();
  await expect(section.getByRole('status')).toContainText('摘要草稿已儲存');
  await expect(section.getByRole('button',{name:'發布已儲存精華與綁定媒體'})).toBeDisabled();
}
async function publishRecap(section:Locator){
  await section.getByLabel('我有權向所選範圍發布摘要、連結與綁定媒體，已保留真實作者及來源，並取得涉及人物所需同意。').check();
  await section.getByRole('button',{name:'發布已儲存精華與綁定媒體'}).click();
  await expect(section.getByRole('status')).toHaveText('活動精華已依所選範圍發布。');
}
async function addPhoto(page:Page,title:string){
  await page.getByText('補上照片或影片連結',{exact:true}).click();
  await page.getByRole('group',{name:'要補上的內容'}).getByRole('button',{name:'照片',exact:true}).click();
  await page.getByLabel('照片',{exact:true}).setInputFiles({name:'authored.jpg',mimeType:'image/jpeg',buffer:await sharp({create:{width:80,height:40,channels:3,background:'#2255aa'}}).jpeg().toBuffer()});
  await page.getByLabel('標題（選填）').fill(title);
  await page.getByRole('button',{name:'送出',exact:true}).click();
  await expect(page.locator('.hl-photos img')).toHaveCount(1);
  await expect(page.locator('.hl-photos img')).toHaveAttribute('alt',new RegExp(title));
  await expect.poll(()=>page.locator('.hl-photos img').evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}
async function boundPhoto(db:Pool,eventId:string){
  const rows=(await db.query(`SELECT h.media_id,b.outcome_id FROM community_event_highlights h JOIN community_event_outcome_media b USING(media_id)
    WHERE h.event_id=$1 AND h.kind='photo'`,[eventId])).rows;
  expect(rows).toHaveLength(1);
  return rows[0] as {media_id:string;outcome_id:string};
}
async function mediaStatus(api:APIRequestContext,id:string,status:number,publicRoute=false){
  for(const variant of ['image','thumb']){
    const response=await api.get(`/api/v1/${publicRoute?'public/':''}event-highlights/media/${id}/${variant}`);
    expect(response.status(),`${publicRoute?'anonymous':'member'} ${variant}`).toBe(status);
  }
}
async function publicItems(api:APIRequestContext,eventId:string){
  const response=await api.get(`/api/v1/public/event-highlights/${eventId}/outcomes`);
  expect(response.status()).toBe(200);
  return (await response.json()).items as {outcome_id:string;title:string}[];
}

// Every case creates unique rows in the runner-owned schema. Immutable media
// bindings intentionally cannot be deleted; the server drops this whole schema.
test.describe('outcome flags off',()=>{
  test.use({memberFeatures:{}});
  test('new routes return 404 before authentication',async({request,baseURL})=>{
    const id=randomUUID();
    for(const path of [`squads/${id}/outcomes`,`squad-outcomes/${id}`,`event-highlights/${id}/outcomes`,`event-highlights/${id}/outcomes/own`,`event-highlights/${id}/outcome-references`,`event-outcomes/${id}`,`event-outcome-backlinks/squad_outcome/${id}`,`public/squad-outcomes/${id}`,`public/event-highlights/${id}/outcomes`,`public/event-outcomes/${id}`]){
      expect((await request.get(`/api/v1/${path}`)).status(),path).toBe(404);
    }
    expect((await request.post(`/api/v1/event-highlights/${id}/outcomes`,{data:{},headers:{Origin:baseURL!}})).status()).toBe(404);
    expect((await request.post(`/api/v1/squads/${id}/outcomes`,{data:{},headers:{Origin:baseURL!}})).status()).toBe(404);
  });
});

test.describe('isolated authored outcomes',()=>{
  test.use({memberFeatures:{squadOutcomesEnabled:true,eventOutcomesEnabled:true}});
  test.setTimeout(180000);

  test('an author keeps draft photos private, explicitly publishes, then withdraws recap and bytes',async({page,browser,request,e2eAuthPool})=>{
    const author=await account(e2eAuthPool,'精華作者'),viewer=await account(e2eAuthPool,'另一位會員');
    const eventId=await event(e2eAuthPool,author),title=`公開精華 ${randomUUID()}`,photo='草稿綁定照片';
    await login(page,author);
    const section=await openEvent(page,eventId);
    await saveRecap(section,title);
    await addPhoto(page,photo);
    const binding=await boundPhoto(e2eAuthPool,eventId);
    await mediaStatus(page.request,binding.media_id,200);
    expect(await publicItems(request,eventId)).toEqual([]);
    await mediaStatus(request,binding.media_id,404,true);
    const other=await browser.newContext({baseURL:new URL(page.url()).origin});
    try{
      const member=await other.newPage();await login(member,viewer);
      await openEvent(member,eventId);
      await expect(member.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
      await expect(member.locator('.hl-photos img')).toHaveCount(0);
      expect((await member.request.get(`/api/v1/event-outcomes/${binding.outcome_id}`)).status()).toBe(404);
      await mediaStatus(member.request,binding.media_id,404);
      await publishRecap(section);
      expect((await publicItems(request,eventId)).map(item=>item.title)).toContain(title);
      await mediaStatus(request,binding.media_id,200,true);
      await member.reload();
      await expect(member.getByRole('heading',{name:title,exact:true})).toBeVisible();
      await expect(member.locator('.hl-photos img')).toHaveCount(1);
      await section.getByRole('button',{name:'撤下這份精華',exact:true}).click();
      await expect(section.getByRole('status')).toContainText('精華已撤下');
      expect(await publicItems(request,eventId)).toEqual([]);
      expect((await request.get(`/api/v1/public/event-outcomes/${binding.outcome_id}`)).status()).toBe(404);
      await mediaStatus(request,binding.media_id,404,true);
      await mediaStatus(member.request,binding.media_id,404);
      await member.reload();
      await expect(member.getByRole('heading',{name:title,exact:true})).toHaveCount(0);
      await expect(member.locator('.hl-photos img')).toHaveCount(0);
      await expect(section.getByText(`${title} · 已撤下`,{exact:true})).toBeVisible();
    }finally{await other.close();}
  });

  test('withdrawing a browser-authored squad source hides its downstream recap, media and backlinks',async({page,request,e2eAuthPool})=>{
    const author=await account(e2eAuthPool,'小隊成果作者'),eventId=await event(e2eAuthPool,author);
    const name=`成果小隊 ${randomUUID().slice(0,8)}`,source=`作者成果 ${randomUUID().slice(0,8)}`,title=`引用精華 ${randomUUID().slice(0,8)}`;
    await login(page,author);await navigate(page,'小隊集合');
    await page.getByRole('button',{name:'成立一支小隊',exact:true}).click();
    const create=page.locator('form').filter({has:page.getByRole('heading',{name:'成立一支小隊'})});
    await create.getByLabel('小隊名稱').fill(name);
    await create.getByLabel('小隊類型').selectOption('coaching');
    await create.getByLabel('我們想一起完成什麼').fill('整理作者可公開的練習成果。');
    await create.getByRole('button',{name:'成立小隊'}).click();
    const squad=page.getByRole('region',{name:'小隊成果'});
    await squad.getByLabel('成果標題').fill(source);
    await squad.getByLabel('成果摘要').fill('作者自己的成果摘要，不含任何私人對話。');
    await squad.getByRole('button',{name:'儲存私人草稿',exact:true}).click();
    await expect(squad.getByRole('status')).toHaveText('私人草稿已儲存；尚未發布。');
    const sourceId=(await e2eAuthPool.query('SELECT outcome_id FROM member_squad_outcomes WHERE author_ref=$1 AND title=$2',[author.id,source])).rows[0].outcome_id as string;
    expect((await request.get(`/api/v1/public/squad-outcomes/${sourceId}`)).status()).toBe(404);
    await expect(squad.getByRole('button',{name:'依所選範圍發布已儲存草稿'})).toBeDisabled();
    await squad.getByLabel('發布範圍').selectOption('public');
    await squad.getByLabel('我有權發布文字與來源、已取得涉及人物所需同意，並同意向所選範圍分享作者與小隊名稱。這不是平台正式驗收。').check();
    await squad.getByRole('button',{name:'依所選範圍發布已儲存草稿'}).click();
    await expect(squad.getByRole('status')).toHaveText('成果已依所選範圍發布。');
    expect((await request.get(`/api/v1/public/squad-outcomes/${sourceId}`)).status()).toBe(200);
    const section=await openEvent(page,eventId);
    await saveRecap(section,title,source);await addPhoto(page,'來源綁定照片');await publishRecap(section);
    const binding=await boundPhoto(e2eAuthPool,eventId);
    await mediaStatus(request,binding.media_id,200,true);
    const backlinks=await request.get(`/api/v1/public/event-outcome-backlinks/squad_outcome/${sourceId}`);
    expect(backlinks.status()).toBe(200);
    expect((await backlinks.json()).items).toEqual(expect.arrayContaining([expect.objectContaining({outcome_id:binding.outcome_id})]));
    await navigate(page,'小隊集合');
    await page.getByLabel('搜尋小隊',{exact:true}).fill(name);
    await page.getByRole('button',{name:`查看小隊：${name}`,exact:true}).click();
    await page.getByRole('region',{name:'小隊成果'}).getByRole('button',{name:'撤下這份成果',exact:true}).click();
    await expect(page.getByRole('region',{name:'小隊成果'}).getByRole('status')).toContainText('成果已撤下');
    expect((await request.get(`/api/v1/public/squad-outcomes/${sourceId}`)).status()).toBe(404);
    expect((await request.get(`/api/v1/public/event-outcome-backlinks/squad_outcome/${sourceId}`)).status()).toBe(404);
    expect(await publicItems(request,eventId)).toEqual([]);
    expect((await request.get(`/api/v1/public/event-outcomes/${binding.outcome_id}`)).status()).toBe(404);
    await mediaStatus(request,binding.media_id,404,true);
    await openEvent(page,eventId);
    await expect(page.getByRole('region',{name:'活動精華與成果'}).getByRole('heading',{name:title,exact:true})).toHaveCount(0);
    await expect(page.locator('.hl-photos img')).toHaveCount(0);
    await mediaStatus(page.request,binding.media_id,404);
    const own=await page.request.get(`/api/v1/event-outcomes/${binding.outcome_id}`);
    expect(own.status()).toBe(200);
    expect((await own.json()).refs).toEqual([expect.objectContaining({kind:'squad_outcome',id:sourceId,unavailable:true})]);
  });
});
