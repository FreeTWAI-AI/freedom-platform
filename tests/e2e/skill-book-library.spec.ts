import {test,expect} from '@playwright/test';

test('guild skill book introduces a real first deliverable before external reading and stays usable on a phone',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();
  await page.getByRole('button',{name:'職業公會',exact:true}).click();
  const guild=page.getByRole('article',{name:'商品品質與供應公會',exact:true});
  const trigger=guild.getByRole('button',{name:'供應端工作台',exact:true});await trigger.click();
  const modal=page.getByRole('dialog',{name:'供應端工作台',exact:true});await expect(modal).toBeVisible();
  await expect(modal).toContainText('一份能讀回自己商品與申請的私人供應端檢視。');
  await expect(modal).toContainText('沒有寫入或付款權限');
  const start=modal.locator('details').filter({has:page.getByText('開始練習：準備與步驟',{exact:true})});
  await expect(start).not.toHaveAttribute('open');await start.locator('summary').click();
  await expect(start).toContainText('Node.js 24');await expect(start.locator('pre')).toContainText('npm run read -- products');
  await expect(modal.getByRole('link',{name:'開啟技能書完整指南 ↗',exact:true})).toHaveAttribute('href','/development/skills/supplier-client');
  await expect(modal.getByRole('link',{name:'閱讀技能書 ↗',exact:true})).toHaveAttribute('href',/github\.com\/FreeTWAI-AI\/freedom-supplier-client\/blob\/[a-f0-9]{40}\/README\.md$/);
  await modal.getByText('作者、授權與收錄來源',{exact:true}).click();await expect(modal).toContainText('來源 GitHub 帳號：FreeTWAI-AI');await expect(modal).toContainText('未明確宣告授權條款');
  await page.setViewportSize({width:390,height:844});expect(await modal.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:'test-results/skill-book-intro-phone.png'});
  await page.keyboard.press('Escape');await expect(modal).not.toBeVisible();await expect(trigger).toBeFocused();
  // Locate by the known book label so guild naming remains independent from the guide content.
  const music=page.getByRole('button',{name:'音樂與 MV 製作入門手冊',exact:true}).first();await music.click();
  const musicModal=page.getByRole('dialog',{name:'音樂與 MV 製作入門手冊',exact:true});await expect(musicModal).toContainText('歌曲／MV 小企劃');
  await musicModal.getByText('開始練習：準備與步驟',{exact:true}).click();await expect(musicModal.locator('pre')).toHaveCount(0);await expect(musicModal).not.toContainText('npm run read');
  await musicModal.getByRole('button',{name:'關閉技能書介紹',exact:true}).click();expect(errors).toEqual([]);
});
