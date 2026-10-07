import {randomUUID} from 'node:crypto';
import {test,expect} from './fixtures.js';

// Expected interface copy is pinned independently of the product catalog.
const cases=[
  {id:'zh-Hant',locale:'zh-TW',create:'建立帳號',login:'登入',submit:'建立帳號，先逛工坊',invalid:'帳號或密碼不正確。',welcome:'Language member，歡迎來到自由工坊。',choose:'選擇主要公會',join:'加入公會，開始參與',home:'會員首頁',settings:'設定'},
  {id:'en',locale:'en-US',create:'Create account',login:'Sign in',submit:'Create account and explore',invalid:'Email or password is incorrect.',welcome:'Welcome to Freedom Workshop, Language member.',choose:'Choose your primary guild',join:'Join guild and get started',home:'Home',settings:'Settings'},
  {id:'ja',locale:'ja-JP',create:'アカウント作成',login:'ログイン',submit:'アカウントを作成して見てみる',invalid:'メールアドレスまたはパスワードが正しくありません。',welcome:'Language memberさん、自由工坊へようこそ。',choose:'メインギルドを選ぶ',join:'ギルドに参加して始める',home:'ホーム',settings:'設定'},
  {id:'ko',locale:'ko-KR',create:'계정 만들기',login:'로그인',submit:'계정을 만들고 둘러보기',invalid:'이메일 또는 비밀번호가 올바르지 않습니다.',welcome:'Language member님, 자유공방에 오신 것을 환영합니다.',choose:'주 길드 선택',join:'길드에 가입하고 시작하기',home:'홈',settings:'설정'},
  {id:'es',locale:'es-ES',create:'Crear cuenta',login:'Iniciar sesión',submit:'Crear cuenta y explorar',invalid:'El correo o la contraseña no son correctos.',welcome:'Te damos la bienvenida a Freedom Workshop, Language member.',choose:'Elige tu gremio principal',join:'Unirme al gremio y empezar',home:'Inicio',settings:'Ajustes'},
] as const;

for(const language of cases)test(`${language.id}: browser language, real invalid login, registration and guild entry`,async({browser})=>{
  const context=await browser.newContext({locale:language.locale,viewport:{width:390,height:844}});
  try{
    const page=await context.newPage();await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang',language.id);
    await expect(page.getByRole('combobox',{name:'Language',exact:true})).toHaveValue('auto');
    const resourceToggle=page.locator('.entry-resources > details > summary');await resourceToggle.click();await expect(page.locator('.entry-resource-list article')).toHaveCount(3);await resourceToggle.click();
    const form=page.locator('.login-card form');
    await form.locator('[name=email]').fill(`absent-${randomUUID()}@example.test`);
    await form.locator('[name=password]').fill('invalid-language-password');
    const rejected=page.waitForResponse(response=>response.url().endsWith('/api/v1/auth/login'));
    await form.getByRole('button',{name:language.login,exact:true}).click();expect((await rejected).status()).toBe(401);
    await expect(page.getByRole('alert')).toContainText(language.invalid);
    await page.getByRole('button',{name:language.create,exact:true}).click();
    await expect(form.locator('input[required]')).toHaveCount(2);
    await expect(form.locator('[name=nickname]')).not.toHaveAttribute('required','');
    await expect(form.locator('[name=password]')).toHaveAttribute('minlength','12');
    await expect(form.locator('[name=password]')).toHaveAttribute('maxlength','128');
    await form.locator('[name=email]').fill(`language-${randomUUID()}@example.test`);
    await form.locator('[name=password]').fill('freedom-language-password-2026');
    await form.locator('[name=nickname]').fill('Language member');
    for(const width of [320,390]){
      await page.setViewportSize({width,height:844});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${language.id} ${width} overflow`).toBe(true);
      expect((await page.getByRole('combobox',{name:'Language',exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await form.getByRole('button',{name:language.submit,exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({path:`test-results/account-language-${language.id}-390.png`,fullPage:true});
    const registered=page.waitForResponse(response=>response.url().endsWith('/api/v1/auth/register'));
    await form.getByRole('button',{name:language.submit,exact:true}).click();expect((await registered).status()).toBe(201);
    await expect(page.getByRole('heading',{name:language.welcome,exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:language.choose,exact:true})).toBeVisible();
    await page.locator('.quick-guild-options').getByRole('radio').first().check();
    await page.locator('.quick-join-actions .btn-primary').click();
    const questions=page.locator('.quick-start .guild-question');await expect(questions.first()).toBeVisible();
    for(const question of await questions.all())await question.getByRole('radio').first().check();
    await page.getByRole('button',{name:language.join,exact:true}).click();
    await expect(page.getByRole('heading',{name:language.home,level:1,exact:true})).toBeVisible();
    await page.getByRole('button',{name:language.settings,exact:true}).click();
    const menu=page.getByRole('menu');await expect(menu.getByRole('menuitemradio',{name:'日本語',exact:true})).toBeVisible();
    await menu.getByRole('menuitemradio',{name:'English',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('lang','en');
    await page.keyboard.press('Escape');await expect(page.getByRole('heading',{name:'Home',level:1,exact:true})).toBeVisible();
    await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','en');await expect(page.getByRole('heading',{name:'Home',level:1,exact:true})).toBeVisible();
  }finally{await context.close();}
});

test('explicit language survives reload and switching preserves registration inputs and destination',async({browser})=>{
  const context=await browser.newContext({locale:'es-ES',viewport:{width:320,height:844}});
  try{
    const page=await context.newPage();await page.goto('/');
    await page.getByRole('button',{name:'Proveedor: mostrar productos y buscar socios',exact:true}).click();
    const form=page.locator('.login-card form');await form.locator('[name=email]').fill('preserved-language@example.test');
    await form.locator('[name=password]').fill('preserved-language-password');await form.locator('[name=nickname]').fill('原本的名字');
    const picker=page.getByRole('combobox',{name:'Language',exact:true});await picker.selectOption('ja');
    await expect(page.locator('html')).toHaveAttribute('lang','ja');await expect(form.locator('[name=email]')).toHaveValue('preserved-language@example.test');
    await expect(form.locator('[name=password]')).toHaveValue('preserved-language-password');await expect(form.locator('[name=nickname]')).toHaveValue('原本的名字');
    await expect(page.getByRole('status').filter({hasText:'完了後の移動先：商品と供給条件。'})).toBeVisible();
    await expect(form.getByRole('button',{name:'アカウントを作成して見てみる',exact:true})).toBeVisible();
    await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','ja');await expect(picker).toHaveValue('ja');
    await picker.selectOption('auto');await expect(page.locator('html')).toHaveAttribute('lang','es');
    expect(await page.evaluate(()=>localStorage.getItem('freedom-interface-language-v1'))).toBeNull();
  }finally{await context.close();}
});

test('switching language during a real sign-in keeps the pending action and sends it once',async({browser})=>{
  const context=await browser.newContext({locale:'en-US'});let release=()=>{};
  try{
    const page=await context.newPage(),gate=new Promise<void>(resolve=>{release=resolve});let attempts=0;
    await page.route('**/api/v1/auth/login',async route=>{attempts++;await gate;await route.continue();});
    await page.goto('/');const form=page.locator('.login-card form');await form.locator('[name=email]').fill('maker@local.test');await form.locator('[name=password]').fill('freedom-local-demo');
    await form.getByRole('button',{name:'Sign in',exact:true}).click();await expect.poll(()=>attempts).toBe(1);
    await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('ko');
    await expect(form.getByRole('button',{name:'처리 중…',exact:true})).toBeDisabled();await expect(form.locator('[name=email]')).toHaveValue('maker@local.test');await expect(form.locator('[name=password]')).toHaveValue('freedom-local-demo');
    release();await expect(page.getByRole('heading',{name:'홈',level:1,exact:true})).toBeVisible();expect(attempts).toBe(1);
  }finally{release();await context.close();}
});

test('unsupported browser language and unavailable preference storage keep account controls usable',async({browser})=>{
  const context=await browser.newContext({locale:'fr-FR',viewport:{width:320,height:844}});
  try{
    await context.addInitScript(()=>{
      const storage=localStorage;
      for(const key of ['getItem','setItem','removeItem'] as const){const original=Storage.prototype[key];Object.defineProperty(Storage.prototype,key,{configurable:true,value:function(this:Storage,...args:unknown[]){if(this===storage)throw new DOMException('blocked','SecurityError');return Reflect.apply(original,this,args);}});}
    });
    const page=await context.newPage();await page.goto('/');await expect(page.locator('html')).toHaveAttribute('lang','en');
    await page.getByRole('combobox',{name:'Language',exact:true}).selectOption('es');await expect(page.locator('html')).toHaveAttribute('lang','es');
    await page.getByRole('button',{name:'Crear cuenta',exact:true}).click();await expect(page.locator('.login-card form [name=nickname]')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','en');
  }finally{await context.close();}
});

test('all five reset forms preserve validation, translate mismatch feedback and return to sign-in',async({browser})=>{
  const resetCopy=[
    {locale:'zh-TW',save:'儲存新密碼',mismatch:'兩次輸入的新密碼不一致。',back:'返回登入'},
    {locale:'en-US',save:'Save new password',mismatch:'The new passwords do not match.',back:'Back to sign in'},
    {locale:'ja-JP',save:'新しいパスワードを保存',mismatch:'新しいパスワードが一致しません。',back:'ログインに戻る'},
    {locale:'ko-KR',save:'새 비밀번호 저장',mismatch:'새 비밀번호가 일치하지 않습니다.',back:'로그인으로 돌아가기'},
    {locale:'es-ES',save:'Guardar nueva contraseña',mismatch:'Las nuevas contraseñas no coinciden.',back:'Volver al inicio de sesión'},
  ];
  for(const copy of resetCopy){
    const context=await browser.newContext({locale:copy.locale,viewport:{width:320,height:844}});
    try{
      const page=await context.newPage();let writes=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/auth/reset/confirm'))writes++;});
      await page.goto(`/#reset-password/${'a'.repeat(43)}`);const fields=page.locator('.login-card form input');await expect(fields).toHaveCount(2);
      for(const field of await fields.all()){await expect(field).toHaveAttribute('minlength','12');await expect(field).toHaveAttribute('maxlength','128');}
      await fields.first().fill('first-password-2026');await fields.last().fill('different-password-2026');
      await page.getByRole('button',{name:copy.save,exact:true}).click();await expect(page.getByRole('alert')).toContainText(copy.mismatch);expect(writes).toBe(0);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.getByRole('button',{name:copy.back,exact:true}).click();await expect(page.locator('.login-card form [name=email]')).toBeVisible();expect(new URL(page.url()).hash).toBe('');
    }finally{await context.close();}
  }
});
