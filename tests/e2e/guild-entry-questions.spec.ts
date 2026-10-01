import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {quickJoin} from './quick-join.js';

const shots='/home/ted-h/tmp-scratch/fp_work/grok-f66719a6/guild-questions-scratch';
async function register(page:Page,name:string){
  await page.goto('/');
  await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill(name);
  await page.getByLabel('電子郵件',{exact:true}).fill(`guildq-${randomUUID()}@example.test`);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-guild-questions-password');
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(page.getByRole('heading',{name:`${name}，歡迎來到自由工坊。`})).toBeVisible();
}
async function fits(page:Page){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}
async function paint(element:Page|ReturnType<Page['locator']>,name:string){
  await element.screenshot({path:`${shots}/${name}.png`});
}

for(const width of [390,820,1280]){
  test(`quick start asks guild questions in two steps at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:width===390?844:900});
    await register(page,`寬度${width}`);
    const quick=page.getByRole('region',{name:'快速加入公會'});
    const next=quick.getByRole('button',{name:'下一步：回答小問題',exact:true});
    await expect(next).toBeDisabled();
    await expect(quick.getByRole('radio')).toHaveCount(18);
    await fits(page);
    if(width!==820)await paint(quick,'quick-start-step1-'+width);
    await quick.locator('input[value="guild_ai_vibe"]').check();
    await quick.getByRole('button',{name:/下一步：回答 \d+ 個小問題/}).click();
    const heading=quick.getByRole('heading',{name:/關於AI 開發公會的 \d+ 個小問題/});
    await expect(heading).toBeFocused();
    await expect(quick.getByText('把想法與程式做成可重用開源作品。')).toBeVisible();
    await expect(quick.getByText('答案會存在你的定位資料，可在「我的定位」修改。')).toBeVisible();
    const join=quick.getByRole('button',{name:'加入公會，開始參與',exact:true});
    await expect(join).toBeDisabled();
    const questions=quick.locator('.guild-question');
    await expect(questions).toHaveCount(4);
    await questions.first().locator('input[type=radio]').first().check();
    await quick.getByRole('button',{name:'換一個公會',exact:true}).click();
    await expect(quick.getByRole('heading',{name:'選擇主要公會',exact:true})).toBeFocused();
    await expect(quick.locator('input[value="guild_ai_vibe"]')).toBeChecked();
    await quick.getByRole('button',{name:/下一步：回答 \d+ 個小問題/}).click();
    await expect(questions.first().locator('input[type=radio]').first()).toBeChecked();
    for(let index=1;index<4;index+=1)await questions.nth(index).locator('input[type=radio]').first().check();
    await expect(join).toBeEnabled();
    await fits(page);
    if(width!==820)await paint(quick,'quick-start-step2-'+width);
    const option=questions.first().locator('.guild-question-option').first();
    const box=await option.boundingBox();
    expect(box&&box.height>=44).toBe(true);
  });
}

test('my positioning lists guild answers and saves an edit',async({page})=>{
  await page.setViewportSize({width:1280,height:900});
  await register(page,'定位小問答');
  await quickJoin(page);
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  await navigate(page,'我的定位');
  const section=page.getByRole('region',{name:'公會小問答'});
  await expect(section.getByRole('heading',{name:'公會小問答',exact:true})).toBeVisible();
  const card=section.getByRole('article',{name:'AI 開發公會'});
  await expect(card.getByText('還沒做過專案',{exact:true})).toBeVisible();
  await expect(card.getByRole('button',{name:'修改',exact:true})).toBeVisible();
  await paint(section,'positioning-1280');
  await page.setViewportSize({width:390,height:844});
  await expect(section).toBeVisible();
  await fits(page);
  await paint(section,'positioning-390');
  await page.setViewportSize({width:1280,height:900});
  await card.getByRole('button',{name:'修改',exact:true}).click();
  await card.getByRole('radio',{name:'寫可重現說明',exact:true}).check();
  await card.getByRole('button',{name:'儲存小問答',exact:true}).click();
  await expect(section.getByText('已儲存AI 開發公會的小問答。',{exact:true})).toBeVisible();
  await expect(card.getByText('寫可重現說明',{exact:true})).toBeVisible();
  await expect(card.getByRole('button',{name:'修改',exact:true})).toBeVisible();
});

test('joining another guild offers a link to its unanswered questions',async({page})=>{
  await page.setViewportSize({width:1280,height:900});
  await register(page,'再加入一個');
  await quickJoin(page);
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  await navigate(page,'職業公會');
  const guild=page.locator('.guild-card',{has:page.getByRole('heading',{name:'音樂創作與MV公會',exact:true})});
  await guild.getByRole('button',{name:'加入音樂創作與MV公會',exact:true}).click();
  const notice=page.getByRole('status').filter({hasText:'已加入音樂創作與MV公會，技能書已解鎖。'});
  await expect(notice).toBeVisible();
  await notice.getByRole('button',{name:'回答音樂創作與MV公會的小問題',exact:true}).click();
  const section=page.getByRole('region',{name:'公會小問答'});
  await expect(section).toBeVisible();
  await expect(section.getByRole('article',{name:'音樂創作與MV公會'}).getByRole('button',{name:'回答',exact:true})).toBeVisible();
  await expect(section.getByRole('article',{name:'AI 開發公會'}).getByRole('button',{name:'修改',exact:true})).toBeVisible();
});

test('a selected guild answer stays distinct in light, dark and versefolk',async({page})=>{
  await page.setViewportSize({width:1280,height:900});
  await register(page,'主題對照');
  const quick=page.getByRole('region',{name:'快速加入公會'});
  await quick.locator('input[value="guild_ai_vibe"]').check();
  await quick.getByRole('button',{name:/下一步：回答 \d+ 個小問題/}).click();
  const options=quick.locator('.guild-question').first().locator('.guild-question-option');
  await options.nth(1).locator('input').check();
  const menu=page.locator('details.preview-profile-menu');
  const expected={
    light:{plain:'rgb(255, 255, 255)',selected:'rgb(242, 248, 220)'},
    dark:{plain:'rgb(20, 22, 27)',selected:'rgb(34, 44, 18)'},
    versefolk:{plain:'rgb(255, 250, 241)',selected:'rgb(237, 243, 219)'},
  } as const;
  for(const [theme,label] of [['light','自由工坊－明亮'],['dark','自由工坊－夜航'],['versefolk','自由工坊－敘生']] as const){
    if(!await menu.evaluate(element=>(element as HTMLDetailsElement).open))await menu.locator('summary').click();
    await menu.getByRole('radio',{name:label,exact:true}).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    const colors=await options.evaluateAll(nodes=>nodes.slice(0,2).map(node=>{
      const style=getComputedStyle(node);
      return {background:style.backgroundColor,border:style.borderTopColor,weight:style.fontWeight};
    }));
    expect(colors[0].background).toBe(expected[theme].plain);
    expect(colors[1].background).toBe(expected[theme].selected);
    expect(colors[0].border).not.toBe(colors[1].border);
    expect(Number(colors[1].weight)).toBeGreaterThan(Number(colors[0].weight));
  }
});
