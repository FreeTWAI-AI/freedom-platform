import {test,expect} from '@playwright/test';

test('admin entry never grants access through a member login or onboarding',async({page})=>{
  await page.goto('/admin');
  await expect(page.getByRole('heading',{name:'需要管理員驗證',exact:true})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'平台管理選單'})).toHaveCount(0);
  await expect(page.getByLabel('電子郵件',{exact:true})).toHaveCount(0);
  const anonymous=await page.request.get('/admin/api/bootstrap');expect([401,403,503]).toContain(anonymous.status());
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'主要工作區'})).toBeVisible();
  await page.getByRole('link',{name:'平台管理 ↗',exact:true}).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading',{name:'需要管理員驗證',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'會員管理',exact:true})).toHaveCount(0);
});

test('verified admin UI keeps member, guild, nomination and audit operations separate from member onboarding',async({page})=>{
  // Browser-only API response fixtures exercise UI wiring. Runtime tests verify signed Access JWTs and real DB commands.
  const csrf='browser-only-csrf-fixture',user='00000000-0000-4000-8000-000000000099';
  let active=true,version=7,reviewed=false,master=false,linked=false;const calls:{path:string;body:any;headers:Record<string,string>}[]=[];
  let memberSessionRequests=0;page.on('request',request=>{if(request.url().endsWith('/api/v1/session'))memberSessionRequests++;});
  await page.route('**/admin/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/admin/api','');
    if(request.method()==='POST'){
      const body=request.postDataJSON();calls.push({path,body,headers:request.headers()});
      if(path.includes('/status')){active=body.active;version++;}
      if(path.includes('/review'))reviewed=true;
      if(path.includes('/master'))master=true;
      if(path==='/link-member')linked=true;
      await route.fulfill({json:{saved:true}});return;
    }
    const member={user_id:user,email:'member@example.test',display_name:'待管理夥伴',active,onboarding_required:true,onboarding_completed_at:null,aggregate_version:version,guilds:[{guild_key:'guild_testing',name:'測試公會'}]};
    const payload=path==='/bootstrap'?{admin:{admin_id:'fixture-admin',display_name:'測試管理員',email:'admin@example.test',role:'super_admin',community_id:'community-fixture'},csrf_token:csrf,summary:{members:1,active_members:active?1:0,pending_guild_applications:reviewed?0:1,guilds:1,admins:1},available_skill_books:[{id:'testing-book',title:'協作入門技能書'}],pending_guild_appointments:[{guild_key:'guild_pending',name:'預定公會',state:linked?'bound':'pending',bound_user_id:linked?user:null}]}:path==='/members'?{items:[member],next_offset:null}:path==='/guild-applications'?{items:[{application_id:'application-fixture',name:'專業測試公會',profession:'軟體測試',reason:'一起練習測試與分享測試技巧',state:reviewed?'approved':'pending',applicant_name:'申請夥伴',applicant_email:'applicant@example.test',aggregate_version:3,review_reason:reviewed?'已有明確學習方向':null}],next_offset:null}:path==='/guilds'?{items:[{guild_key:'guild_testing',name:'測試公會',purpose:'一起測試實用的作品',guild_master:master?{user_id:user,display_name:'待管理夥伴'}:null,officer_version:master?33:28}]}:path==='/admins'?{items:[{admin_id:'fixture-admin',display_name:'測試管理員',email:'admin@example.test',role:'super_admin',active:true,identity_binding:'unverified_email_match'}]}:{items:[{audit_id:'audit-fixture',admin_name:'測試管理員',action:'member_status',reason:'配合會員本人提出的停用要求',created_at:'2026-09-23T12:00:00Z',target_type:'member',target_ref:user}]};
    await route.fulfill({json:payload});
  });
  await page.goto('/admin');await expect(page.getByRole('heading',{name:'會員管理',exact:true})).toBeVisible();
  expect(memberSessionRequests).toBe(0);
  await expect(page.getByText('預定公會 · 等待本人確認連結',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'停用這位會員',exact:true}).click();await page.getByLabel('操作理由',{exact:true}).fill('配合會員本人提出的停用要求');await page.getByRole('button',{name:'確認停用這位會員',exact:true}).click();await expect(page.getByText('已停用',{exact:true})).toBeVisible();
  expect(calls[0].headers['x-admin-csrf']).toBe(csrf);expect(calls[0].headers['if-match']).toBe('"7"');expect(calls[0].headers['idempotency-key']).toBeTruthy();expect(calls[0].body.active).toBe(false);
  await page.getByRole('button',{name:'重新啟用會員',exact:true}).click();await page.getByLabel('操作理由',{exact:true}).fill('會員本人確認重新啟用');await page.getByRole('button',{name:'確認重新啟用會員',exact:true}).click();await expect(page.getByText('啟用中',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'公會申請',exact:true}).click();await page.getByLabel('公會宗旨',{exact:true}).fill('一起練習軟體測試並分享經驗');await page.getByLabel('新成員的第一步',{exact:true}).fill('閱讀入門技能書並完成第一個測試');await page.getByLabel('審核說明',{exact:true}).fill('已有明確學習方向');
  await expect(page.getByRole('button',{name:'保存審核決定',exact:true})).toBeDisabled();await page.getByLabel('協作入門技能書',{exact:true}).check();await page.getByRole('button',{name:'保存審核決定',exact:true}).click();await expect(page.getByText('已核准',{exact:true})).toBeVisible();expect(calls.find(call=>call.path.includes('/review'))?.body.guild.skill_book_ids).toEqual(['testing-book']);
  await page.getByRole('button',{name:'公會管理',exact:true}).click();await page.getByRole('button',{name:'設定公會長',exact:true}).click();await page.getByRole('combobox',{name:'公會長人選',exact:true}).selectOption(user);await page.getByLabel('任命理由',{exact:true}).fill('具備帶領公會的經驗並同意任命');await page.getByRole('button',{name:'確認任命',exact:true}).click();await expect(page.getByText('公會長：待管理夥伴',{exact:true})).toBeVisible();expect(calls.find(call=>call.path.includes('/master'))?.headers['if-match']).toBe('"28"');
  await page.getByRole('button',{name:'管理員名單',exact:true}).click();await expect(page.getByText(/同信箱會員尚未驗證，不視為身分綁定/)).toBeVisible();
  await page.getByRole('button',{name:'操作紀錄',exact:true}).click();await expect(page.getByText('操作人：測試管理員',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'連結我的會員帳號並確認會長任命',exact:true}).click();await expect(page.getByText('預定公會 · 已連結會員並確認任命',{exact:true})).toBeVisible();expect(calls.find(call=>call.path==='/link-member')?.headers['x-admin-csrf']).toBe(csrf);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
