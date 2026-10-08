import {test,expect,type Page} from './fixtures.js';

async function composer(page:Page){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();
  await page.getByRole('button',{name:'建立貼文',exact:true}).click();
  return page.getByRole('dialog',{name:'建立貼文',exact:true});
}
test('optimization is off by default, personal tool handoff previews and restores copy without publishing',async({page})=>{
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  const requests:string[]=[];page.on('request',request=>{if(request.url().includes('/api/v1/me/model-')||request.url().includes('/api/v1/me/private-work')||request.method()==='POST'&&request.url().includes('/social-posts/notes'))requests.push(request.url());});
  const dialog=await composer(page),original='這是我自己的作品，想找設計夥伴一起完成。';
  await dialog.getByLabel('貼文內容',{exact:true}).fill(original);
  await expect(dialog.getByRole('button',{name:'✦ Social Post 優化',exact:true})).toHaveAttribute('aria-pressed','false');
  expect(requests).toHaveLength(0);
  await dialog.getByRole('button',{name:'✦ Social Post 優化',exact:true}).click();
  await dialog.getByRole('button',{name:'到自己的 AI 工具',exact:true}).click();
  await dialog.getByRole('combobox',{name:'我的 AI 工具',exact:true}).selectOption('Claude Code');
  await dialog.getByRole('button',{name:'複製文案優化任務',exact:true}).click();
  const task=await page.evaluate(()=>navigator.clipboard.readText());expect(task).toContain('/social-post');expect(task).toContain(original);
  const result='一起把作品完成。\n我正在找設計夥伴，歡迎交流。';
  await dialog.getByLabel('貼回 AI 優化結果',{exact:true}).fill(result);
  await expect(dialog.getByLabel('貼文內容',{exact:true})).toHaveValue(original);
  await expect(dialog.getByRole('region',{name:'優化文案預覽'})).toContainText(result);
  await dialog.getByRole('button',{name:'採用這版文案',exact:true}).click();
  await expect(dialog.getByLabel('貼文內容',{exact:true})).toHaveValue(result);
  await dialog.getByRole('button',{name:'復原原稿',exact:true}).click();await expect(dialog.getByLabel('貼文內容',{exact:true})).toHaveValue(original);
  await dialog.getByRole('button',{name:'關閉發文',exact:true}).click();await page.getByRole('button',{name:'建立貼文',exact:true}).click();
  await expect(dialog.getByLabel('貼文內容',{exact:true})).toHaveValue(original);
  expect(requests.filter(value=>value.includes('/social-posts/notes'))).toHaveLength(0);
  const storage=await page.evaluate(()=>JSON.stringify(Object.entries(localStorage).concat(Object.entries(sessionStorage))));expect(storage).not.toContain(original);expect(storage).not.toContain(result);
});
test('stale preview cannot overwrite newly edited copy and model setup preserves the composer',async({page})=>{
  const dialog=await composer(page);await dialog.getByLabel('貼文內容',{exact:true}).fill('最初的內容。');
  await dialog.getByRole('button',{name:'✦ Social Post 優化',exact:true}).click();
  const setup=dialog.getByRole('link',{name:'設定我的模型 ↗',exact:true});await expect(setup).toHaveAttribute('href','/#private-ai');await expect(setup).toHaveAttribute('target','_blank');
  await dialog.getByRole('button',{name:'到自己的 AI 工具',exact:true}).click();
  await dialog.getByRole('combobox',{name:'我的 AI 工具',exact:true}).selectOption('Grok');
  await dialog.getByLabel('貼回 AI 優化結果',{exact:true}).fill('<img src=x onerror=alert(1)> 這只是文字。');
  await expect(dialog.locator('.optimizer-preview img')).toHaveCount(0);
  await dialog.getByLabel('貼文內容',{exact:true}).fill('我剛新增了真實資訊，不能被覆蓋。');
  await expect(dialog.getByRole('button',{name:'採用這版文案',exact:true})).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('原稿已更新');
});

test('copy edit paste keeps the handoff source across closing, while a fresh exported task can be adopted',async({page})=>{
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  const dialog=await composer(page),source=dialog.getByLabel('貼文內容',{exact:true}),copy=dialog.getByRole('button',{name:'複製文案優化任務',exact:true});
  const original='週一在台北舉辦工作坊。',updated='週二改到台中舉辦工作坊。';await source.fill(original);
  await dialog.getByRole('button',{name:'✦ Social Post 優化',exact:true}).click();await dialog.getByRole('button',{name:'到自己的 AI 工具',exact:true}).click();
  await copy.click();await expect(dialog.getByRole('status').filter({hasText:'任務已複製'})).toBeVisible();expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain(original);
  await source.fill(updated);await dialog.getByRole('button',{name:'關閉發文',exact:true}).click();await page.getByRole('button',{name:'建立貼文',exact:true}).click();
  await dialog.getByRole('button',{name:'到自己的 AI 工具',exact:true}).click();
  await dialog.getByLabel('貼回 AI 優化結果',{exact:true}).fill('週一，台北見！');
  await expect(dialog.getByRole('alert')).toContainText('原稿已更新');await expect(dialog.getByRole('button',{name:'採用這版文案',exact:true})).toBeDisabled();await expect(source).toHaveValue(updated);
  await copy.click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain(updated);
  await expect(page.locator('.social-publish-dialog[open]')).toHaveAccessibleName('建立貼文');
  await dialog.getByLabel('貼回 AI 優化結果',{exact:true}).fill('週二，台中見！');await expect(dialog.getByRole('button',{name:'採用這版文案',exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:'採用這版文案',exact:true}).click();await expect(source).toHaveValue('週二，台中見！');
  await source.fill('週三在高雄展出新作品。');
  await dialog.getByLabel('貼回 AI 優化結果',{exact:true}).fill('週三，高雄的新作品等你來看。');
  await expect(dialog.getByRole('button',{name:'採用這版文案',exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:'採用這版文案',exact:true}).click();await expect(source).toHaveValue('週三，高雄的新作品等你來看。');
});
test('320px optimization stays within every theme and unresolved service never asks for raw keys in the post',async({page})=>{
  await page.setViewportSize({width:320,height:800});const dialog=await composer(page);
  await dialog.getByLabel('貼文內容',{exact:true}).fill('希望在社群找到合作夥伴。');
  await dialog.getByRole('button',{name:'✦ Social Post 優化',exact:true}).click();
  await expect(dialog.getByRole('status').filter({hasText:'目前沒有可直接執行的本人模型連線'})).toBeVisible();
  await expect(dialog.locator('input[type=password]')).toHaveCount(0);
  await dialog.getByRole('button',{name:'到自己的 AI 工具',exact:true}).click();
  await dialog.getByLabel('貼回 AI 優化結果',{exact:true}).fill('展示你的商品、作品和技術，找到一起做事的夥伴。');
  for(const theme of ['light','rpg','versefolk']){
    await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
    expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const button=dialog.getByRole('button',{name:'採用這版文案',exact:true});expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await button.scrollIntoViewIfNeeded();await expect(dialog.getByRole('button',{name:'關閉發文',exact:true})).toBeInViewport();await page.screenshot({path:`test-results/social-post-optimizer-${theme}-320.png`});
  }
});
