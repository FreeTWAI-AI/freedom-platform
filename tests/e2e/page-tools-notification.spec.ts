import {test,expect,type Page} from './fixtures.js';

const widths=[320,390,820,1280] as const;
const themes=[['light','自由工坊－明亮'],['dark','自由工坊－夜航']] as const;

async function signIn(page:Page){
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
}

async function selectTheme(page:Page,id:(typeof themes)[number][0],label:(typeof themes)[number][1]){
  if(await page.locator('html').getAttribute('data-theme')===id)return;
  await page.getByRole('button',{name:'設定'}).click();
  await page.getByRole('menuitemradio',{name:label}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme',id);
  await page.getByRole('button',{name:'設定'}).click();
  await expect(page.getByRole('menu',{name:'個人檔案'})).toBeHidden();
}

test('the idea control shows its label and the notification button matches neighbouring top-bar buttons',async({page})=>{
  await page.setViewportSize({width:320,height:720});
  await page.goto('/');
  const signedOut=page.locator('.login-page-tools .page-tool-button--idea');
  await expect(signedOut.locator('.page-tool-label')).toHaveText('提出想法');
  await expect(signedOut).toHaveAccessibleName('提出想法');
  const signedOutBox=await signedOut.boundingBox();
  expect(signedOutBox!.width).toBeGreaterThanOrEqual(40);
  expect(signedOutBox!.height).toBeGreaterThanOrEqual(40);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

  await signIn(page);
  await page.evaluate(()=>{location.hash='members';});
  await expect(page.getByRole('heading',{name:'工坊夥伴',level:1})).toBeVisible();

  for(const width of widths){
    await page.setViewportSize({width,height:width<500?720:900});
    for(const [id,label] of themes){
      await selectTheme(page,id,label);
      const where=`${id} ${width}`;
      const idea=page.locator('.topbar .page-tool-button--idea');
      await expect(idea.locator('.page-tool-label'),where).toHaveText('提出想法');
      await expect(idea,where).toHaveAccessibleName('提出想法');
      const box=await idea.boundingBox();
      expect(box!.width,where).toBeGreaterThanOrEqual(40);
      expect(box!.height,where).toBeGreaterThanOrEqual(40);
      const metrics=await page.evaluate(()=>{
        const rect=(selector:string)=>{
          const node=document.querySelector(selector);
          if(!node)return null;
          const box=node.getBoundingClientRect();
          return {width:box.width,height:box.height,top:box.top};
        };
        const title=document.querySelector('.topbar h1')!.getBoundingClientRect();
        const ideaBox=document.querySelector('.page-tool-button--idea')!.getBoundingClientRect();
        const actions=[...document.querySelectorAll('.topbar-actions .btn')].map(node=>{
          const box=node.getBoundingClientRect();
          return {name:node.getAttribute('aria-label')||(node.textContent??'').trim().slice(0,12),width:box.width,height:box.height,top:box.top};
        });
        return {
          overflow:document.documentElement.scrollWidth-innerWidth,
          overlap:Math.min(title.right,ideaBox.right)-Math.max(title.left,ideaBox.left)>0&&Math.min(title.bottom,ideaBox.bottom)-Math.max(title.top,ideaBox.top)>0,
          actions,
          tools:['.page-tool-button--idea','.page-tool-button--help','.page-tool-button--edit'].map(selector=>rect(selector)),
          icons:{
            idea:rect('.page-tool-button--idea svg'),
            help:rect('.page-tool-button--help svg'),
            edit:rect('.page-tool-button--edit svg'),
            bell:rect('.notification-bell-trigger svg'),
          },
        };
      });
      expect(metrics.overflow,where).toBeLessThanOrEqual(0);
      expect(metrics.overlap,where).toBe(false);
      const bell=metrics.actions.find(action=>action.name.startsWith('通知'));
      expect(bell,where).toBeTruthy();
      for(const action of metrics.actions){
        expect(Math.abs(action.height-bell!.height),`${where} ${action.name}`).toBeLessThanOrEqual(1);
        expect(Math.abs(action.top-bell!.top),`${where} ${action.name}`).toBeLessThanOrEqual(1);
        expect(action.width,`${where} ${action.name}`).toBeGreaterThanOrEqual(40);
        expect(action.height,`${where} ${action.name}`).toBeGreaterThanOrEqual(40);
      }
      for(const tool of metrics.tools){
        expect(tool,where).toBeTruthy();
        expect(Math.abs(tool!.height-bell!.height),where).toBeLessThanOrEqual(1);
        expect(Math.abs(tool!.top-metrics.tools[0]!.top),where).toBeLessThanOrEqual(1);
      }
      for(const icon of [metrics.icons.help,metrics.icons.edit,metrics.icons.bell]){
        expect(Math.abs(icon!.width-metrics.icons.idea!.width),where).toBeLessThanOrEqual(1);
        expect(Math.abs(icon!.height-metrics.icons.idea!.height),where).toBeLessThanOrEqual(1);
      }
      await expect.poll(()=>page.evaluate(()=>{
        const idea=getComputedStyle(document.querySelector('.page-tool-button--idea')!).backgroundColor;
        const probe=document.createElement('span');
        probe.style.background=getComputedStyle(document.documentElement).getPropertyValue('--green').trim();
        document.body.append(probe);
        const green=getComputedStyle(probe).backgroundColor;
        probe.remove();
        return idea===green;
      }),where).toBe(true);
    }
  }
});
