import {buildSync} from 'esbuild';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect,type Page} from './fixtures.js';

// Real React components, synthetic transport only. This fixture verifies client
// session/remount behavior, not database authorization or real publication.
export async function mountSharingFixture(page:Page, kind='probe') {
  const root=fileURLToPath(new URL('../..',import.meta.url));
  const script=buildSync({stdin:{resolveDir:root,loader:'tsx',contents:`
    import React,{useCallback,useEffect,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ApiError} from './apps/portal-web/src/api';
    import {client,PortalContext} from './apps/portal-web/src/portal-session';
    import {useAuthoringDraft,setSharingDraftAccount,authoringDraftState,sharingMutationState} from './apps/portal-web/src/modules/authoring-drafts';
    import {useModuleMutation,performModuleMutation} from './apps/portal-web/src/modules/shared';
    import {SimpleSkillSubmission} from './apps/portal-web/src/modules/SimpleSkillSubmission';
    import {CoCreationPanel} from './apps/portal-web/src/modules/CoCreationPanel';
    import {ShowcasePanel} from './apps/portal-web/src/modules/ShowcasePanel';
    import {MemberBlockingAction} from './apps/portal-web/src/modules/MemberBlocking';
    import {ShareLauncher,SHARE_TARGETS} from './apps/portal-web/src/ShareLauncher';
    import {MyContent} from './apps/portal-web/src/modules/MyContent';
    import {Navigation} from './apps/portal-web/src/Navigation';
    import {LanguageProvider} from './apps/portal-web/src/language';
    import {CommunitySearch} from './apps/portal-web/src/modules/CommunitySearch';
    const owner='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
    const pending=[],calls=[],reads=[],pendingReads=[];
    let user=owner,token='synthetic-session-1',projects=[],drafts=[],showcases=[],opportunities=[],blocked=false,render,content=[],deferReads=false,enabled=true,resumeId=null;
    client.csrfToken=token;setSharingDraftAccount(user,client.sessionGeneration);
    client.post=(path,body,options)=>new Promise((resolve,reject)=>{calls.push({path,body:structuredClone(body),options:structuredClone(options)});pending.push({resolve,reject});});
    client.patch=client.post;
    client.get=async path=>{reads.push(path);
      if(deferReads&&(path==='/me/content'||path.startsWith('/me/skill-submissions/'))){const deferred=Promise.withResolvers();pendingReads.push({path,...deferred});return deferred.promise;}
      if(path==='/me/content')return {items:content};
      if(path.startsWith('/me/showcases/')){const row=showcases.find(row=>path.endsWith('/'+row.showcase_id));if(row)return row;throw Error('Missing synthetic showcase');}
      if(path.startsWith('/community-search?'))return {items:[],next_cursor:null};
      if(path==='/community-relations/bookmarks')return {items:[],next_cursor:null};
      if(path==='/community-relations/follows')return {items:[]};
      if(path==='/me/skill-submissions')return {items:drafts};
      if(path==='/co-creation/projects')return {items:projects,guilds:[]};
      if(path==='/opensource/projects')return {items:[{project_id:'source-1',owner_ref:user,title:'Synthetic source',repository_full_name:'synthetic/repo'}]};
      if(path.includes('/activity'))return {repository_url:'https://github.com/synthetic/repo',issues:[],contributions:[],checked_at:'2026-10-09',truncated:false};
      if(path==='/showcases')return {items:showcases};
      if(path==='/opportunities')return {items:opportunities};
      if(path.startsWith('/me/blocks/'))return {user_id:other,blocked_by_me:blocked,aggregate_version:blocked?2:1};
      throw Error('Unexpected fixture read '+path);
    };
    window.sharingFixture={calls,reads,owner,other,
      readDraft:key=>authoringDraftState(user,key,null).read(),
      startSkillMutation:(type='skill')=>{void performModuleMutation(client,sharingMutationState({userId:user,type}),'/synthetic-skill-operation',{});},
      pendingReads,resolveRead:(index,value)=>pendingReads[index].resolve(value),rejectRead:index=>pendingReads[index].reject(Error('Synthetic private read failure')),
      content:value=>{content=value},deferReads:value=>{deferReads=value},enabled:value=>{enabled=value;render()},resume:value=>{resumeId=value;render()},
      resolve:(index,value)=>pending[index].resolve(value),
      reject:(index,network=true)=>pending[index].reject(new ApiError({message:'Synthetic response loss',network,status:network?0:409})),
      projects:value=>{projects=value},drafts:value=>{drafts=value},showcases:value=>{showcases=value},opportunities:value=>{opportunities=value},blocked:value=>{blocked=value},
      session:(next,replace=true)=>{user=next;if(replace)token+='x';client.csrfToken=next?token:null;setSharingDraftAccount(next,client.sessionGeneration);render();},
    };
    function Probe(){
      const [draft,setDraft,current]=useAuthoringDraft(user,'probe:draft','');
      const [receipt,setReceipt]=useAuthoringDraft(user,'probe:receipt','');
      const mutation=useModuleMutation(client,{userId:user,type:'probe'});
      return <><input aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/>
        <button disabled={mutation.busy} onClick={async()=>{const value=await mutation.mutate('/synthetic',{text:draft},7);if(value&&current())setReceipt(value.id)}}>Send</button>
        <output aria-label="Receipt">{receipt}</output><output aria-label="State">{mutation.busy?'pending':mutation.lastFailureUnknown?'unknown':mutation.error?'rejected':'idle'}</output></>;
    }
    function ErrorIdentityProbe(){
      const {setError,error}=useModuleMutation(client),[loads,setLoads]=useState(0),[renders,setRenders]=useState(0);
      const load=useCallback(()=>{setLoads(value=>value+1);setError(null)},[client,setError]);
      useEffect(()=>{load()},[load]);
      return <><output aria-label="Load cycles">{loads}</output><output aria-label="Error value">{error??'none'}</output><button onClick={()=>setRenders(v=>v+1)}>Unrelated render {renders}</button><button onClick={()=>setError('Synthetic error')}>Set error</button><button onClick={()=>setError(null)}>Clear error</button></>;
    }
    function Fixture(){
      const [mounted,setMounted]=useState(true),[version,setVersion]=useState(0),[guided,setGuided]=useState(false),[target,setTarget]=useState('');render=()=>setVersion(v=>v+1);
      const session={user:{user_id:user},csrf_token:token};
      const value={session,pending:null,error:null,mutate:()=>{throw Error('Authoring must use exact request identity')},clearError:()=>{},isMe:ref=>ref===user};
      return <><button onClick={()=>setMounted(v=>!v)}>Toggle form</button><button onClick={()=>setGuided(v=>!v)}>Toggle guidance</button>
        <output aria-label="Destination">{target}</output>
        {user&&mounted&&<PortalContext.Provider value={value}><div key={user+':'+client.sessionGeneration}>
          {${JSON.stringify(kind)}==='identity'?<ErrorIdentityProbe/>:${JSON.stringify(kind)}==='probe'?<Probe/>:${JSON.stringify(kind)}==='skill'?<SimpleSkillSubmission client={client} userId={user} onPublished={async()=>{}}/>:
          ${JSON.stringify(kind)}==='resume'?<SimpleSkillSubmission client={client} userId={user} resumeId={resumeId} onPublished={async()=>{}} onOpenDraft={id=>setTarget('advanced:'+id)}/>:
          ${JSON.stringify(kind)}==='content'?<LanguageProvider><Navigation current="my-content" onSelect={id=>setTarget(id)} canManageGuild={false} guildLaunchpadEnabled={false} communitySearchEnabled={false} personalContentEnabled={enabled} mobileOpen/><ShareLauncher onChoose={()=>{}} onMyContent={enabled?()=>setTarget('my-content'):undefined}/><MyContent/></LanguageProvider>:
          ${JSON.stringify(kind)}==='relations'?<CommunitySearch client={client} authKey={user+':'+client.sessionGeneration} relationsEnabled={enabled}/>:
          ${JSON.stringify(kind)}==='cooperation'?<CoCreationPanel client={client} session={session}/>:
          ${JSON.stringify(kind)}==='showcase'?<ShowcasePanel/>:
          ${JSON.stringify(kind)}==='blocking'?<MemberBlockingAction client={client} userId={other} nickname="Synthetic peer" onChanged={()=>{}}/>:
          <ShareLauncher guided={guided} onChoose={name=>setTarget(name+':'+SHARE_TARGETS[name].tab)}/>}
        </div></PortalContext.Provider>}</>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `},bundle:true,write:false,format:'iife',platform:'browser',loader:{'.css':'empty'},logLevel:'silent'}).outputFiles[0].text;
  await page.route('**/__sharing-authoring-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}));
  await page.goto('/__sharing-authoring-fixture');
  await page.addStyleTag({content:readFileSync(root+'/apps/portal-web/src/styles.css','utf8')+'\n'+readFileSync(root+'/apps/portal-web/src/ShareLauncher.css','utf8')});
  await page.addScriptTag({content:script});
}
const fixture=(page:Page,body:(f:any)=>unknown)=>page.evaluate(body=>new Function('f','return ('+body+')(f)')((window as any).sharingFixture),body.toString());
const remount=async(page:Page)=>{await page.getByRole('button',{name:'Toggle form',exact:true}).click();await page.getByRole('button',{name:'Toggle form',exact:true}).click();};

export const sharingCases:Record<string,(page:Page)=>Promise<void>>={
  'private showcase unknown create survives Close reopen with exact replay':async page=>{
    await mountSharingFixture(page,'content');
    await page.getByRole('button',{name:'新增私人作品草稿',exact:true}).click();
    await page.getByLabel('作品標題',{exact:true}).fill('Unknown private draft');
    await page.getByLabel('一句話介紹',{exact:true}).fill('Private description');
    await page.getByRole('button',{name:'儲存私人草稿',exact:true}).click();
    await fixture(page,f=>f.reject(0));
    await expect(page.getByRole('button',{name:'重試原請求',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'回到內容清單',exact:true}).click();
    await page.getByRole('button',{name:'新增私人作品草稿',exact:true}).click();
    await expect(page.getByLabel('作品標題',{exact:true})).toHaveValue('Unknown private draft');
    await page.getByRole('button',{name:'重試原請求',exact:true}).click();
    expect(await fixture(page,f=>JSON.stringify(f.calls[0])===JSON.stringify(f.calls[1]))).toBe(true);
    await fixture(page,f=>f.resolve(1,{showcase_id:'saved-private',title:'Unknown private draft',description:'Private description',artifact_ref:'artifact:saved',public_url:null,owner_ref:f.owner,owner_name:'Owner',status:'draft',visibility:'private',aggregate_version:1}));
    await expect(page.getByRole('region',{name:'私人作品編輯'})).toContainText('私人草稿已儲存');
  },
  'saved new showcase keeps dirty input after Close and PATCHes its saved ID':async page=>{
    await mountSharingFixture(page,'content');
    await page.getByRole('button',{name:'新增私人作品草稿',exact:true}).click();
    await page.getByLabel('作品標題',{exact:true}).fill('Saved private draft');
    await page.getByLabel('一句話介紹',{exact:true}).fill('Private description');
    await page.getByRole('button',{name:'儲存私人草稿',exact:true}).click();
    await fixture(page,f=>{f.content([{kind:'showcase',id:'saved-private',title:'Saved private draft',status:'draft',version:1,visibility:'private',actions:['edit']}]);f.resolve(0,{showcase_id:'saved-private',title:'Saved private draft',description:'Private description',artifact_ref:'artifact:saved',public_url:null,owner_ref:f.owner,owner_name:'Owner',status:'draft',visibility:'private',aggregate_version:1});});
    await expect(page.getByRole('region',{name:'私人作品編輯'})).toContainText('私人草稿已儲存');
    await page.getByLabel('作品標題',{exact:true}).fill('Unsent private edit');
    await page.getByRole('button',{name:'回到內容清單',exact:true}).click();
    await page.getByRole('link',{name:'編輯',exact:true}).click();
    await expect(page.getByLabel('作品標題',{exact:true})).toHaveValue('Unsent private edit');
    await page.getByRole('button',{name:'儲存私人草稿',exact:true}).click();
    expect(await fixture(page,f=>({path:f.calls[1].path,title:f.calls[1].body.title,version:f.calls[1].options.ifMatch}))).toEqual({path:'/me/showcases/saved-private',title:'Unsent private edit',version:1});
    await fixture(page,f=>f.resolve(1,{showcase_id:'saved-private',title:'Unsent private edit',description:'Private description',artifact_ref:'artifact:saved',public_url:null,owner_ref:f.owner,owner_name:'Owner',status:'draft',visibility:'private',aggregate_version:2}));
    await expect(page.getByRole('region',{name:'私人作品編輯'})).toContainText('版本 2');
  },
  'authoritative gallery removal cannot resurrect the last publication receipt':async page=>{
    await mountSharingFixture(page,'showcase');
    await page.getByLabel('作品標題',{exact:true}).fill('Withdrawn work');
    await page.getByLabel('一句話介紹',{exact:true}).fill('Description');
    await page.getByLabel('我同意以社群可見方式分享這件作品').check();
    await page.getByRole('button',{name:'發布作品',exact:true}).click();
    await fixture(page,f=>f.resolve(0,{showcase_id:'withdrawn-work',title:'Withdrawn work',description:'Description',artifact_ref:'artifact:saved',public_url:null,owner_ref:f.owner,owner_name:'Owner',status:'published',visibility:'community',aggregate_version:1}));
    await expect(page.getByRole('heading',{name:'Withdrawn work',exact:true})).toBeVisible();
    await remount(page);
    await expect(page.getByRole('heading',{name:'Withdrawn work',exact:true})).toHaveCount(0);
    expect(await fixture(page,f=>f.readDraft('showcase:published'))).toBe(null);
  },

  'personal content keyboard navigation sharing and flags in three themes at desktop 320 and 390':async page=>{
    for(const width of [1280,320,390])for(const theme of ['light','dark','versefolk']){
      await page.setViewportSize({width,height:844});await mountSharingFixture(page,'content');
      await page.evaluate(value=>{document.documentElement.dataset.theme=value},theme);
      await expect(page.getByRole('heading',{name:'草稿與已發布內容'})).toBeVisible();
      await page.locator('.nav-more > summary').click();
      await page.getByRole('button',{name:'我的內容',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByLabel('Destination')).toHaveText('my-content');
      const trigger=page.getByRole('button',{name:'分享或提交'});await trigger.focus();await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
      await trigger.click();await page.getByRole('dialog').getByRole('button',{name:/我的內容/}).focus();await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).not.toBeVisible();await expect(trigger).toBeFocused();
      await fixture(page,f=>f.enabled(false));await trigger.click();await expect(page.getByRole('dialog').getByRole('button',{name:/我的內容/})).toHaveCount(0);
      await page.keyboard.press('Escape');await page.locator('.nav-more > summary').click();
      await page.getByRole('searchbox').fill('我的內容');await expect(page.getByRole('button',{name:'我的內容',exact:true})).toHaveCount(0);
    }
  },
  'private content late reads never cross same-user replacement account switch logout or expiry':async page=>{
    for(const boundary of ['replace','switch','logout','expiry']){
      await mountSharingFixture(page,'content');await fixture(page,f=>f.deferReads(true));await remount(page);
      await expect.poll(()=>fixture(page,f=>f.pendingReads.length)).toBe(1);
      if(boundary==='switch')await fixture(page,f=>f.session(f.other));
      else if(boundary==='replace')await fixture(page,f=>f.session(f.owner));
      else {await fixture(page,f=>f.session(null));await fixture(page,f=>f.session(f.owner));}
      await expect.poll(()=>fixture(page,f=>f.pendingReads.length)).toBe(2);
      await fixture(page,f=>f.resolveRead(0,{items:[{kind:'showcase',id:'old',title:'Late private title',status:'draft',version:1,visibility:'private',actions:[]}]}));
      await fixture(page,f=>f.resolveRead(1,{items:[]}));await expect(page.getByText('Late private title',{exact:true})).toHaveCount(0);
      await fixture(page,f=>{f.deferReads(false);f.content([{kind:'showcase',id:'old',title:'Visible private title',status:'draft',version:1,visibility:'private',actions:[]}]);});await remount(page);
      await expect(page.getByText('Visible private title',{exact:true})).toBeVisible();
      await fixture(page,f=>{f.content([]);f.session(f.other)});await expect(page.getByText('Visible private title',{exact:true})).toHaveCount(0);
    }
  },
  'resume private submission waits retries and fences replaced session':async page=>{
    await mountSharingFixture(page,'resume');await fixture(page,f=>{f.deferReads(true);f.resume('submission-one')});
    await expect(page.getByRole('region',{name:'載入私人投稿'})).toBeVisible();await expect(page.getByLabel('作品名稱',{exact:true})).toHaveCount(0);
    await fixture(page,f=>f.rejectRead(0));await page.getByRole('button',{name:'重試載入私人投稿'}).click();
    await fixture(page,f=>f.session(f.owner));await expect.poll(()=>fixture(page,f=>f.pendingReads.length)).toBe(3);
    await fixture(page,f=>f.resolveRead(1,{submission_id:'submission-one',status:'ready_for_review',payload:{title:'Late old title'}}));
    await fixture(page,f=>f.resolveRead(2,{submission_id:'submission-one',status:'ready_for_review',can_edit:true,aggregate_version:7,public_path:null,payload:{repository_url:'https://github.com/synthetic/repo',title:'Resumed title',description:'Saved description',use_notes:'Saved notes',demo_url:null,relationship:'curator'}}));
    await expect(page.getByRole('heading',{name:'確認這樣分享，好嗎？'})).toBeVisible();await expect(page.getByText('Late old title',{exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'修改內容',exact:true}).click();await expect(page.getByLabel('作品名稱',{exact:true})).toHaveValue('Resumed title');
    await page.getByText('補充使用說明與展示網址（選填）',{exact:true}).click();await expect(page.getByLabel('展示網址（選填）',{exact:true})).toHaveValue('');
    await page.getByLabel('作品名稱',{exact:true}).fill('Local resumed edit');await page.getByRole('button',{name:'預覽投稿',exact:true}).click();
    await page.getByLabel('我同意公開這份作品介紹與來源關係',{exact:true}).check();await page.getByRole('button',{name:'重試公開投稿',exact:true}).click();
    expect(await fixture(page,f=>({path:f.calls[0].path,version:f.calls[0].options.ifMatch,title:f.calls[0].body.title}))).toEqual({path:'/me/skill-submissions/submission-one/manual',version:7,title:'Local resumed edit'});
    await fixture(page,f=>f.reject(0));await expect(page.getByRole('heading',{name:'Local resumed edit'})).toBeVisible();
  },
  'community relations flag restores private controls only for enabled member':async page=>{
    await mountSharingFixture(page,'relations');await expect(page.getByRole('heading',{name:'我的書籤與追蹤'})).toBeVisible();
    await fixture(page,f=>f.enabled(false));await expect(page.getByRole('heading',{name:'我的書籤與追蹤'})).toHaveCount(0);
  },
  'stable mutation error setter does not loop a dependent Guilds-style load effect':async page=>{
    await mountSharingFixture(page,'identity');await expect(page.getByLabel('Load cycles')).toHaveText('1');
    await page.getByRole('button',{name:'Set error',exact:true}).click();await expect(page.getByLabel('Error value')).toHaveText('Synthetic error');
    await page.getByRole('button',{name:'Unrelated render 0',exact:true}).click();await expect(page.getByLabel('Load cycles')).toHaveText('1');
    await page.getByRole('button',{name:'Clear error',exact:true}).click();await expect(page.getByLabel('Error value')).toHaveText('none');await expect(page.getByLabel('Load cycles')).toHaveText('1');
  },
  'draft, pending and acknowledged success survive a real unmount':async page=>{
    await mountSharingFixture(page);await page.getByRole('textbox',{name:'Draft'}).fill('Unsent');await remount(page);
    await expect(page.getByRole('textbox',{name:'Draft'})).toHaveValue('Unsent');await page.getByRole('button',{name:'Send',exact:true}).click();await remount(page);
    await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();await fixture(page,f=>f.resolve(0,{id:'actual-receipt'}));
    await expect(page.getByLabel('Receipt')).toHaveText('actual-receipt');await remount(page);await expect(page.getByLabel('Receipt')).toHaveText('actual-receipt');
  },
  'unknown commit retries retain exact key body and version across remount':async page=>{
    await mountSharingFixture(page);await page.getByRole('textbox',{name:'Draft'}).fill('Committed once');await page.getByRole('button',{name:'Send',exact:true}).click();
    await fixture(page,f=>f.reject(0));await expect(page.getByLabel('State')).toHaveText('unknown');await remount(page);await expect(page.getByLabel('State')).toHaveText('unknown');
    await page.getByRole('button',{name:'Send',exact:true}).click();expect(await fixture(page,f=>JSON.stringify(f.calls[0])===JSON.stringify(f.calls[1]))).toBe(true);
    await fixture(page,f=>f.resolve(1,{id:'first-committed-object'}));await expect(page.getByLabel('Receipt')).toHaveText('first-committed-object');
    await page.getByRole('textbox',{name:'Draft'}).fill('Changed body');await page.getByRole('button',{name:'Send',exact:true}).click();
    expect(await fixture(page,f=>f.calls[1].options.idempotencyKey!==f.calls[2].options.idempotencyKey)).toBe(true);
  },
  'logout expiry switch and same-user replacement fence late results; same session retains draft':async page=>{
    for(const boundary of ['logout','expiry','switch','replace']){
      await mountSharingFixture(page);await page.getByRole('textbox',{name:'Draft'}).fill('Private input');
      await fixture(page,f=>f.session(f.owner,false));await expect(page.getByRole('textbox',{name:'Draft'})).toHaveValue('Private input');
      await page.getByRole('button',{name:'Send',exact:true}).click();
      if(boundary==='switch')await fixture(page,f=>f.session(f.other));
      else if(boundary==='replace')await fixture(page,f=>f.session(f.owner));
      else {await fixture(page,f=>f.session(null));await fixture(page,f=>f.session(f.owner));}
      await expect(page.getByRole('textbox',{name:'Draft'})).toHaveValue('');await fixture(page,f=>f.resolve(0,{id:'old-account-result'}));
      await expect(page.getByLabel('Receipt')).toHaveText('');await expect(page.getByLabel('State')).toHaveText('idle');
    }
  },
  'manual skill retry preserves draft edit contract and canonical publication link':async page=>{
    await mountSharingFixture(page,'skill');
    await page.getByLabel('GitHub 專案網址',{exact:true}).fill('https://github.com/synthetic/repo');await page.getByLabel('作品名稱',{exact:true}).fill('Original title');await page.getByLabel('一句話介紹',{exact:true}).fill('Synthetic description');
    await remount(page);await page.getByRole('button',{name:'預覽投稿',exact:true}).click();await page.getByLabel('我同意公開這份作品介紹與來源關係',{exact:true}).check();
    await page.getByRole('button',{name:'確認並公開',exact:true}).click();
    await fixture(page,f=>f.resolve(0,{submission_id:'10000000-0000-4000-8000-000000000099',status:'ready_for_review',can_edit:true,aggregate_version:1,payload:{...f.calls[0].body},public_path:null}));
    await expect.poll(()=>fixture(page,f=>f.calls.length)).toBe(2);await fixture(page,f=>f.reject(1,false));
    await page.getByRole('button',{name:'修改內容',exact:true}).click();await page.getByLabel('作品名稱',{exact:true}).fill('Edited title');await page.getByRole('button',{name:'預覽投稿',exact:true}).click();await page.getByLabel('我同意公開這份作品介紹與來源關係',{exact:true}).check();
    await page.getByRole('button',{name:'重試公開投稿',exact:true}).click();
    expect(await fixture(page,f=>({path:f.calls[2].path,version:f.calls[2].options.ifMatch,title:f.calls[2].body.title}))).toEqual({path:'/me/skill-submissions/10000000-0000-4000-8000-000000000099/manual',version:1,title:'Edited title'});
    await fixture(page,f=>f.resolve(2,{submission_id:'10000000-0000-4000-8000-000000000099',status:'ready_for_review',can_edit:true,aggregate_version:2,payload:{...f.calls[2].body},public_path:null}));
    await expect.poll(()=>fixture(page,f=>f.calls.length)).toBe(4);await remount(page);await expect(page.getByRole('button',{name:'正在確認公開來源與授權…'})).toBeDisabled();
    await fixture(page,f=>f.reject(3));await page.getByRole('button',{name:'重試公開投稿',exact:true}).click();expect(await fixture(page,f=>JSON.stringify(f.calls[3])===JSON.stringify(f.calls[4]))).toBe(true);
    await fixture(page,f=>f.resolve(4,{submission_id:'10000000-0000-4000-8000-000000000099',status:'published',aggregate_version:3,public_path:'/development/submissions/10000000-0000-4000-8000-000000000099'}));
    await expect(page.getByRole('link',{name:'閱讀已公開技能書 ↗'})).toHaveAttribute('href','/development/submissions/10000000-0000-4000-8000-000000000099');await remount(page);await expect(page.getByRole('link',{name:'前往技能書架'})).toBeVisible();
  },
  'late old-session manual create cannot trigger publication':async page=>{
    for(const replacement of ['switch','same-user']){
      await mountSharingFixture(page,'skill');await page.getByLabel('GitHub 專案網址',{exact:true}).fill('https://github.com/synthetic/repo');await page.getByLabel('作品名稱',{exact:true}).fill('Private');await page.getByLabel('一句話介紹',{exact:true}).fill('Private description');await page.getByRole('button',{name:'預覽投稿',exact:true}).click();await page.getByLabel('我同意公開這份作品介紹與來源關係',{exact:true}).check();await page.getByRole('button',{name:'確認並公開',exact:true}).click();
      await fixture(page,replacement==='switch'?f=>f.session(f.other):f=>f.session(f.owner));await fixture(page,f=>f.resolve(0,{submission_id:'late-draft',aggregate_version:1}));
      await expect(page.getByLabel('作品名稱',{exact:true})).toHaveValue('');expect(await fixture(page,f=>f.calls.length)).toBe(1);
    }
  },
  'existing blocking unknown failure keeps its retry key and original version':async page=>{
    await mountSharingFixture(page,'blocking');await page.getByRole('button',{name:'封鎖設定',exact:true}).click();await page.getByRole('button',{name:'確認封鎖',exact:true}).click();await fixture(page,f=>f.reject(0));
    await expect(page.getByText('結果尚未確認。請重試同一筆操作；原本的操作識別碼與版本會保留。')).toBeVisible();await page.getByRole('button',{name:'重試同一筆操作',exact:true}).click();
    expect(await fixture(page,f=>JSON.stringify(f.calls[0])===JSON.stringify(f.calls[1]))).toBe(true);await fixture(page,f=>{f.blocked(true);f.resolve(1,{updated:true})});await expect(page.getByRole('button',{name:'確認解除封鎖',exact:true})).toBeVisible();
  },
  'delayed co-creation success refreshes the currently mounted catalog':async page=>{
    await mountSharingFixture(page,'cooperation');await page.getByRole('button',{name:'發起共創邀請',exact:true}).click();await page.getByLabel('共創邀請名稱',{exact:true}).fill('Synthetic invitation');await page.getByLabel('這一輪想完成什麼',{exact:true}).fill('Bounded goal');await page.getByLabel('參與方式與注意事項',{exact:true}).fill('Review first');await page.locator('fieldset').filter({has:page.getByText('希望哪些夥伴加入？（可複選）',{exact:true})}).getByRole('checkbox').first().check();
    await page.getByRole('button',{name:'發布共創邀請',exact:true}).click();await remount(page);await expect(page.locator('.cocreation-panel')).toHaveAttribute('inert','');
    await fixture(page,f=>{const value={...f.calls[0].body,project_id:'new-invitation',repository_url:'https://github.com/synthetic/repo',repository_full_name:'synthetic/repo',coordinator_name:'Synthetic owner',source_kind:'member_project',aggregate_version:1};f.projects([value]);f.resolve(0,value)});
    await expect(page.locator('.cocreation-panel')).not.toHaveAttribute('inert','');await expect(page.getByText('共創邀請「Synthetic invitation」已發布。到專案的 GitHub 建立具體任務，就能邀請夥伴一起參與。')).toBeVisible();
    await expect(page.getByRole('heading',{name:'Synthetic invitation',exact:true})).toBeVisible();expect(await fixture(page,f=>f.reads.filter((p:string)=>p==='/co-creation/projects').length)).toBeGreaterThanOrEqual(3);
  },
  'work draft consent pending and real receipt survive remount; unknown retry is exact':async page=>{
    await mountSharingFixture(page,'showcase');await page.getByLabel('作品標題',{exact:true}).fill('Synthetic work');await page.getByLabel('一句話介紹',{exact:true}).fill('Synthetic description');await page.getByLabel('我同意以社群可見方式分享這件作品').check();await remount(page);
    await expect(page.getByLabel('作品標題',{exact:true})).toHaveValue('Synthetic work');await expect(page.getByLabel('我同意以社群可見方式分享這件作品')).toBeChecked();await page.getByRole('button',{name:'發布作品',exact:true}).click();await remount(page);await expect(page.getByLabel('作品標題',{exact:true})).toBeDisabled();
    await fixture(page,f=>f.reject(0));await page.getByRole('button',{name:'發布作品',exact:true}).click();expect(await fixture(page,f=>JSON.stringify(f.calls[0])===JSON.stringify(f.calls[1]))).toBe(true);
    await fixture(page,f=>f.resolve(1,{...f.calls[0].body,showcase_id:'synthetic-work',owner_ref:f.owner,owner_name:'Synthetic owner',artifact_ref:'artifact:synthetic'}));await expect(page.getByRole('region',{name:'作品發布成功'})).toBeVisible();await page.getByRole('button',{name:'查看剛分享的作品',exact:true}).click();await expect(page.locator('#showcase-synthetic-work')).toBeFocused();
  },
  'bilateral need preserves its retry and refreshes the actual saved reader after remount':async page=>{
    await mountSharingFixture(page,'showcase');await fixture(page,f=>f.showcases([{showcase_id:'synthetic-work',title:'Peer work',description:'Synthetic source',owner_ref:f.other,owner_name:'Synthetic peer',artifact_ref:'artifact:source'}]));await remount(page);
    await page.getByRole('button',{name:'我想找你合作',exact:true}).click();await page.getByRole('textbox',{name:'你的需求',exact:true}).fill('Synthetic bilateral request');await remount(page);await expect(page.getByRole('textbox',{name:'你的需求',exact:true})).toHaveValue('Synthetic bilateral request');await page.getByRole('button',{name:'送出合作需求',exact:true}).click();await remount(page);await expect(page.getByRole('textbox',{name:'你的需求',exact:true})).toBeDisabled();await fixture(page,f=>f.reject(0));await page.getByRole('button',{name:'送出合作需求',exact:true}).click();expect(await fixture(page,f=>JSON.stringify(f.calls[0])===JSON.stringify(f.calls[1]))).toBe(true);
    await fixture(page,f=>{const raw={...f.calls[0].body,opportunity_id:'saved-need',provider_ref:f.other,client_ref:f.owner,state:'open',aggregate_version:1};f.opportunities([{...raw,showcase_title:'Peer work',provider_name:'Synthetic peer',client_name:'Synthetic owner'}]);f.resolve(1,raw)});
    await expect(page.locator('#opportunity-saved-need')).toContainText('Synthetic bilateral request');await page.getByRole('button',{name:'查看這份合作需求',exact:true}).click();await expect(page.locator('#opportunity-saved-need')).toBeFocused();
  },
  'guided launcher defaults off; navigation is write-free and Escape restores focus':async page=>{
    await mountSharingFixture(page,'launcher');await page.setViewportSize({width:320,height:800});const trigger=page.getByRole('button',{name:'分享或提交',exact:true});await trigger.click();await expect(page.getByRole('button',{name:'找人合作',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
    await page.getByRole('button',{name:'Toggle guidance',exact:true}).click();await trigger.click();await expect(page.getByRole('dialog')).toHaveAccessibleName('你想分享什麼？');await page.getByRole('button',{name:'找人合作',exact:true}).click();await expect(page.getByLabel('Destination')).toHaveText('collaborate:showcase');
    await trigger.click();await page.getByRole('button',{name:'發起共創邀請',exact:true}).click();await expect(page.getByLabel('Destination')).toHaveText('cocreate:cocreation');await trigger.click();await page.getByRole('button',{name:'刊登商品',exact:true}).click();await page.getByRole('button',{name:'← 返回分享選單',exact:true}).click();await page.keyboard.press('Escape');await expect(trigger).toBeFocused();expect(await fixture(page,f=>f.calls.length)).toBe(0);await expect(page.getByRole('link',{name:'我的內容'})).toHaveCount(0);
  },
};
