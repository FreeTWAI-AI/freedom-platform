// UI-only fixtures: HTTPS static build plus mocked owner DTOs. No provider,
// authority, database or capture readiness is represented by these records.
import { createServer } from 'node:https';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import type { MemberModelSettingsOverview } from '../../contracts/execution/v2/member-model-settings.js';

export const visualIds = {user:'11111111-1111-4111-8111-111111111111',connection:'22222222-2222-4222-8222-222222222222',
  runtime:'33333333-3333-4333-8333-333333333333',family:'44444444-4444-4444-8444-444444444444',
  model:'55555555-5555-4555-8555-555555555555',replacement:'66666666-6666-4666-8666-666666666666',
  credential:'77777777-7777-4777-8777-777777777777',authorization:'88888888-8888-4888-8888-888888888888'};
export const visualSelection = {providerRef:'openai' as const,modelRef:'synthetic-ui-fixture',processingLocation:'provider_remote' as const,
  artifactCustody:'platform_asset' as const,credentialCustody:'platform_vault' as const,engineLocation:'platform' as const,billingSource:'user_byok' as const};
export const visualModel = (id=visualIds.model,version='1') => ({modelConnectionId:id,connectionId:visualIds.connection,
  runtimeDeviceId:visualIds.runtime,familyId:visualIds.family,environment:'local' as const,clientId:'settings-ui-fixture',selection:visualSelection,
  state:'unverified' as const,aggregateVersion:version,createdAt:new Date(Date.now()-10_000).toISOString(),operational_authority:false as const});
export const visualCredential = () => ({credentialId:visualIds.credential,modelConnectionId:visualIds.model,modelVersion:'1',generation:'1',aggregateVersion:'7',state:'active' as const,
  selection:visualSelection,recoveryGeneration:'1',issuedAt:new Date(Date.now()-10_000).toISOString(),expiresAt:new Date(Date.now()+120_000).toISOString(),
  terminalAt:null,replacementCredentialId:null,operational_authority:false as const});
export function visualOverview():MemberModelSettingsOverview {return {profile:'member-model-settings/v1',connections:[{connectionId:visualIds.connection,
  runtimeDeviceId:visualIds.runtime,state:'active',aggregateVersion:'3',expiresAt:new Date(Date.now()+120_000).toISOString()}],
  models:[visualModel()],credentials:[],selectionOptions:[visualSelection],setup:{state:'installed',setupOrigin:'https://broker.example.test'},limit:50,operational_authority:false};}
export const visualHandoff = () => ({authorizationRef:visualIds.authorization,nonce:'A'.repeat(43),assertion:'QUlVSUZpeHR1cmU.QXNzZXJ0aW9u.VGVzdE9ubHk',
  setupOrigin:'https://broker.example.test',expiresAt:new Date(Date.now()+45_000).toISOString(),operational_authority:false});
export async function startVisualPortal(clientHarness=false) {
  const directory=await mkdtemp(join(tmpdir(),'fp-settings-ui-'));let root=resolve('apps/portal-web/dist');
  try {
    if(clientHarness){
      const appRoot=resolve('.'),source=join(directory,'fixture.js');
      await writeFile(join(directory,'index.html'),'<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');
      await writeFile(source,`import React from ${JSON.stringify(join(appRoot,'node_modules/react/index.js'))};
import {createRoot} from ${JSON.stringify(join(appRoot,'node_modules/react-dom/client.js'))};
import {PortalClient} from ${JSON.stringify(join(appRoot,'apps/portal-web/src/api.ts'))};
import {ModelSettings} from ${JSON.stringify(join(appRoot,'apps/portal-web/src/modules/ModelSettings.tsx'))};
const first=new PortalClient(),second=new PortalClient();first.csrfToken='first-client-fixture';second.csrfToken='second-client-fixture';
function Fixture(){const [client,setClient]=React.useState(first);return React.createElement(React.Fragment,null,
React.createElement('button',{onClick:()=>setClient(second)},'Replace client fixture'),React.createElement(ModelSettings,{client}));}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));`);
      const {build}=await import('vite');root=join(directory,'dist');
      const nodeEnv=process.env.NODE_ENV;
      try {await build({configFile:false,root:directory,logLevel:'silent',resolve:{dedupe:['react','react-dom']},
        build:{outDir:root,emptyOutDir:true}});}
      finally {if(nodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=nodeEnv;}
    }
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'});
    const server=createServer({key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},async(req,res)=>{
      try {const path=resolve(root,'.'+new URL(req.url!,'https://local.test').pathname);
        if(path!==root&&!path.startsWith(root+'/')){res.writeHead(404);res.end();return;}
        const actual=extname(path)?path:join(root,'index.html'),bytes=await readFile(actual);
        res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp'} as Record<string,string>)[extname(actual)]??'application/octet-stream');
        // This fixture policy sends only the origin. Actual platform HTML policy
        // and broker Origin enforcement are covered by the independent suite.
        res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','strict-origin');res.end(bytes);
      }catch {res.writeHead(404);res.end();}
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    return {origin:'https://127.0.0.1:'+(server.address() as {port:number}).port,
      async close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}};
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
export async function installVisualApi(page:Page,read:()=>MemberModelSettingsOverview) {
  await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname;let json:unknown,status=200;
    if(path==='/api/v1/session')json={user:{user_id:visualIds.user,display_name:'視覺測試會員',email:'visual@local.test',profession_membership_ref:'fixture'},csrf_token:'fixture-csrf'};
    else if(path==='/api/v1/site')json={registration_enabled:false,demo_accounts_enabled:false,public_mode:false};
    else if(path==='/api/v1/me/onboarding')json={required:false,completed:true};
    else if(path==='/api/v1/guild-workspace')json={managed_guilds:[],managed_books:[],can_discuss:false};
    else if(path==='/api/v1/me/private-work')json={items:[]};
    else if(path==='/api/v1/me/model-settings')json=read();
    else if(path==='/api/v1/me/model-credentials/'+visualIds.credential)json=read().credentials.find(value=>value.credentialId===visualIds.credential);
    else if(path.startsWith('/api/v1/me/credential-ingests/'))json={authorizationRef:visualIds.authorization,operation:'create',state:'issued',credential:null,operational_authority:false};
    else {status=503;json={code:'visual_fixture_unavailable'};}
    await route.fulfill({status,json});
  });
}
