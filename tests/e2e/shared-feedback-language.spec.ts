import {test,expect,type Page,type Locator} from './fixtures.js';

// Expected copy is independent of the implementation's interface catalog.
const languages=[
  {id:'zh-Hant',locale:'zh-TW',name:'繁體中文',login:'登入',pending:'處理中…',home:'會員首頁',messages:'我的訊息',working:'正在處理…',reading:'正在讀取…',offline:'目前離線，連線恢復後再試。',opening:'正在開啟我的訊息…',failed:'我的訊息暫時無法開啟。',hint:'請確認網路後重新載入頁面。',reload:'重新載入頁面',back:'返回首頁'},
  {id:'en',locale:'en-US',name:'English',login:'Sign in',pending:'Working…',home:'Home',messages:'Messages',working:'Working…',reading:'Loading…',offline:'You are offline. Try again when connected.',opening:'Opening Messages…',failed:'Messages could not open.',hint:'Check your connection, then reload the page.',reload:'Reload page',back:'Back to home'},
  {id:'ja',locale:'ja-JP',name:'日本語',login:'ログイン',pending:'処理中…',home:'ホーム',messages:'メッセージ',working:'処理中…',reading:'読み込み中…',offline:'オフラインです。接続が戻ってからお試しください。',opening:'メッセージを開いています…',failed:'メッセージを開けません。',hint:'接続を確認してからページを再読み込みしてください。',reload:'ページを再読み込み',back:'ホームに戻る'},
  {id:'ko',locale:'ko-KR',name:'한국어',login:'로그인',pending:'처리 중…',home:'홈',messages:'메시지',working:'처리 중…',reading:'불러오는 중…',offline:'오프라인입니다. 연결이 복구되면 다시 시도해 주세요.',opening:'메시지 여는 중…',failed:'메시지 페이지를 열 수 없습니다.',hint:'연결을 확인한 다음 페이지를 새로고침해 주세요.',reload:'페이지 새로고침',back:'홈으로 돌아가기'},
  {id:'es',locale:'es-ES',name:'Español',login:'Iniciar sesión',pending:'Procesando…',home:'Inicio',messages:'Mensajes',working:'Procesando…',reading:'Cargando…',offline:'Sin conexión. Inténtalo de nuevo cuando se restablezca.',opening:'Abriendo Mensajes…',failed:'No se pudo abrir Mensajes.',hint:'Comprueba la conexión y vuelve a cargar la página.',reload:'Volver a cargar la página',back:'Volver al inicio'},
] as const;
type Language=typeof languages[number];

async function login(page:Page,language:Language=languages[0]){
  await page.goto('/');const form=page.locator('.login-card form');
  await form.locator('[name=email]').fill('maker@local.test');
  await form.locator('[name=password]').fill('freedom-local-demo');
  await form.getByRole('button',{name:language.login,exact:true}).click();
  await expect(page.getByRole('heading',{name:language.home,level:1,exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'建立貼文',exact:true})).toBeVisible();
}

async function selectLanguage(page:Page,language:Language){
  await page.locator('.settings-menu-button').click();
  await page.getByRole('menuitemradio',{name:language.name,exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('lang',language.id);
}

async function contained(page:Page,element:Locator){
  const box=(await element.boundingBox())!;expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}

for(const [index,language] of languages.entries()){
  test(`${language.id}: pending ACK updates its language without remounting the form or resending login`,async({browser})=>{
    const context=await browser.newContext({locale:language.locale,viewport:{width:320,height:844},reducedMotion:'reduce'});
    let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve});let attempts=0;
    try{
      const page=await context.newPage();await page.goto('/');
      const form=page.locator('.login-card form');
      await form.locator('[name=email]').fill('maker@local.test');
      await form.locator('[name=password]').fill('freedom-local-demo');
      await expect(page.locator('.request-feedback')).toHaveCount(0);
      await page.route('**/api/v1/auth/login',async route=>{attempts++;const response=await route.fetch();await gate;await route.fulfill({response});});
      await form.getByRole('button',{name:language.login,exact:true}).click();
      const feedback=page.locator('.request-feedback');
      await expect(feedback).toHaveText(language.working);
      await expect(feedback).toHaveAttribute('role','status');
      await expect(feedback).toHaveAttribute('aria-live','polite');
      await expect(feedback).toHaveAttribute('aria-atomic','true');
      await expect(form.getByRole('button',{name:language.pending,exact:true})).toBeDisabled();
      await expect.poll(()=>attempts).toBe(1);
      const next=languages[(index+1)%languages.length];
      await page.getByRole('combobox',{name:'Language',exact:true}).selectOption(next.id);
      await expect(feedback).toHaveText(next.working);
      await expect(form.getByRole('button',{name:next.pending,exact:true})).toBeDisabled();
      await expect(form.locator('[name=email]')).toHaveValue('maker@local.test');
      await expect(form.locator('[name=password]')).toHaveValue('freedom-local-demo');
      await contained(page,feedback);expect(attempts).toBe(1);
      release();await expect(page.getByRole('heading',{name:next.home,level:1,exact:true})).toBeVisible();
      await expect(feedback).toHaveCount(0);expect(attempts).toBe(1);
    }finally{release();await context.close();}
  });

  test(`${language.id}: a real pending read follows language changes and keeps typed input`,async({browser})=>{
    const context=await browser.newContext({locale:language.locale,viewport:{width:320,height:844}});
    let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve});let reads=0;
    try{
      const page=await context.newPage();
      await page.route('**/api/v1/site',async route=>{reads++;const response=await route.fetch();await gate;await route.fulfill({response});});
      await page.goto('/');const feedback=page.locator('.request-feedback');
      await expect(feedback).toHaveText(language.reading);await expect.poll(()=>reads).toBe(1);
      const input=page.locator('.login-card form [name=email]');await input.fill('kept-feedback@example.test');
      const next=languages[(index+1)%languages.length];
      await page.getByRole('combobox',{name:'Language',exact:true}).selectOption(next.id);
      await expect(feedback).toHaveText(next.reading);await expect(input).toHaveValue('kept-feedback@example.test');
      for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});await contained(page,feedback);}
      expect(reads).toBe(1);release();await expect(feedback).toHaveCount(0);expect(reads).toBe(1);
    }finally{release();await context.close();}
  });

  test(`${language.id}: offline feedback remains readable in all themes and device widths`,async({browser},info)=>{
    const context=await browser.newContext({locale:language.locale,viewport:{width:320,height:844},reducedMotion:'reduce'});
    try{
      const page=await context.newPage();await login(page,language);await expect(page.locator('.request-feedback')).toHaveCount(0);
      await context.setOffline(true);const feedback=page.locator('.request-feedback');await expect(feedback).toHaveText(language.offline);
      for(const [theme,name] of ['自由工坊－明亮','自由工坊－夜航','自由工坊－敘生'].entries()){
        await page.locator('.settings-menu-button').click();await page.getByRole('menuitemradio',{name,exact:true}).click();await page.keyboard.press('Escape');
        for(const width of [320,390,1280]){
          await page.setViewportSize({width,height:844});await contained(page,feedback);
          const style=await feedback.evaluate(element=>({background:getComputedStyle(element).backgroundColor,pointerEvents:getComputedStyle(element).pointerEvents}));
          expect(style.background).not.toBe('rgba(0, 0, 0, 0)');expect(style.pointerEvents).toBe('none');
          const settings=(await page.locator('.settings-menu-button').boundingBox())!;
          expect(settings.width).toBeGreaterThanOrEqual(44);expect(settings.height).toBeGreaterThanOrEqual(44);
          if(language.id==='es'&&width===320)await page.screenshot({path:info.outputPath(`offline-es-theme-${theme}-320.png`),fullPage:true});
        }
      }
      await context.setOffline(false);await expect(feedback).toHaveCount(0);
    }finally{await context.setOffline(false);await context.close();}
  });
}

test('a held deferred page translates in place and navigation can still leave it',async({page},info)=>{
  await login(page);let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve});let assets=0;
  await page.route(/\/assets\/MemberMessages-[^/]+\.js$/,async route=>{assets++;await gate;await route.continue();});
  try{
    await page.locator('#workspace-navigation').getByRole('button',{name:'我的訊息',exact:true}).click();
    for(const language of languages){
      await selectLanguage(page,language);await expect(page.locator('.page-loading')).toContainText(language.opening);
      await expect(page.locator('#workspace-navigation')).toBeVisible();expect(assets).toBe(1);
    }
    await page.setViewportSize({width:320,height:844});await page.emulateMedia({reducedMotion:'reduce'});
    await contained(page,page.locator('.page-loading'));
    expect(await page.locator('.page-loading .request-feedback-progress').evaluate(element=>getComputedStyle(element).animationName)).toBe('none');
    await page.screenshot({path:info.outputPath('loading-es-320.png'),fullPage:true});
    await page.setViewportSize({width:1280,height:844});
    await page.locator('#workspace-navigation').getByRole('button',{name:'Inicio',exact:true}).click();
    await expect(page.getByRole('button',{name:'建立貼文',exact:true})).toBeVisible();
  }finally{release();}
  expect(assets).toBe(1);
  await page.locator('#workspace-navigation').getByRole('button',{name:'Mensajes',exact:true}).click();
  await expect(page.getByRole('tab',{name:/^私人訊息/})).toBeVisible();expect(assets).toBe(1);
});

test('a failed deferred page keeps its failure and translated recovery controls on language changes',async({page},info)=>{
  await login(page);let assets=0;
  await page.route(/\/assets\/MemberMessages-[^/]+\.js$/,route=>{assets++;return route.abort();});
  await page.locator('#workspace-navigation').getByRole('button',{name:'我的訊息',exact:true}).click();
  for(const language of languages){
    await selectLanguage(page,language);const alert=page.getByRole('alert');
    await expect(alert).toContainText(language.failed);await expect(alert).toContainText(language.hint);
    await expect(alert.getByRole('button',{name:language.reload,exact:true})).toBeVisible();
    await expect(alert.getByRole('link',{name:language.back,exact:true})).toHaveAttribute('href','/#home');
    for(const width of [320,390,1280]){
      await page.setViewportSize({width,height:844});await contained(page,alert);
      for(const action of [alert.getByRole('button',{name:language.reload,exact:true}),alert.getByRole('link',{name:language.back,exact:true})]){
        const box=(await action.boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
        await contained(page,action);
      }
    }
    expect(assets).toBe(1);
  }
  await page.setViewportSize({width:320,height:844});await page.screenshot({path:info.outputPath('recovery-es-320.png'),fullPage:true});
  await page.getByRole('link',{name:'Volver al inicio',exact:true}).click();
  await expect(page.getByRole('button',{name:'建立貼文',exact:true})).toBeVisible();expect(assets).toBe(1);
});
