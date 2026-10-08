import {test,expect} from './fixtures.js';

for(const width of [320,1280])test(`offline ${width}px has one announcement at the top without covering content`,async({page,context},info)=>{
  await page.setViewportSize({width,height:844});await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('button',{name:'建立貼文',exact:true})).toBeVisible();
  await expect(page.locator('.request-feedback')).toHaveCount(0);await context.setOffline(true);
  try{
    const banner=page.locator('.app-connection-status'),feedback=page.locator('.request-feedback.is-offline');
    await expect(banner).toBeVisible();await expect(feedback).toBeVisible();
    for(const name of ['自由工坊－明亮','自由工坊－夜航','自由工坊－敘生']){
      await page.getByRole('button',{name:'設定',exact:true}).click();
      await page.getByRole('menuitemradio',{name,exact:true}).click();await page.keyboard.press('Escape');
      await expect(page.locator('.app-connection-status[role=status], .request-feedback.is-offline[role=status]')).toHaveCount(1);
      await expect(banner).toContainText('草稿保留在此頁。');
      await expect(banner).toHaveAttribute('aria-live','polite');await expect(banner).toHaveAttribute('aria-atomic','true');
      const top=(await banner.boundingBox())!,message=(await feedback.boundingBox())!;
      expect(message.y).toBeGreaterThanOrEqual(top.y);expect(message.y+message.height).toBeLessThanOrEqual(top.y+top.height);
      expect(message.x).toBeGreaterThanOrEqual(0);expect(message.x+message.width).toBeLessThanOrEqual(width);
      expect(await feedback.evaluate(element=>getComputedStyle(element).position)).toBe('static');
      await expect(page.getByRole('button',{name:'建立貼文',exact:true})).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
    await page.screenshot({path:info.outputPath(`offline-single-${width}.png`),fullPage:true});
  }finally{await context.setOffline(false);}
  await expect(page.locator('.app-connection-status')).toHaveCount(0);await expect(page.locator('.request-feedback')).toHaveCount(0);
});
