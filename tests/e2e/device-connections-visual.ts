// Frontend behavior fixtures only: actual PortalClient and built UI, mocked owner DTOs.
// Independent real TLS/SQL browser evidence covers installed backend authority.
import {createServer} from 'node:http';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Page,Route,Request} from '@playwright/test';
import {installVisualApi,visualOverview,visualIds} from './model-settings-visual.js';
export const deviceIds={authorization:visualIds.authorization,connection:visualIds.connection,runtime:visualIds.runtime};
export const deviceCode='12345-6789A';
export const deviceReview=()=>({authorizationId:deviceIds.authorization,requestDigest:'A'.repeat(43),clientId:'device-ui-fixture',clientDisplayName:'Synthetic owner device',environment:'local',runtimeKind:'agent-kit',keyThumbprint:'A'.repeat(43),scope:'bootstrap.status.read',expiresAt:new Date(Date.now()+120000).toISOString(),state:'pending',operational_authority:false});
export const deviceConnection=(version='7',state='active')=>({connectionId:deviceIds.connection,runtimeDeviceId:deviceIds.runtime,environment:'local',clientId:'device-ui-fixture',state,aggregateVersion:version,issuedAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),operational_authority:false});
export type DeviceWire={path:string;method:string;body:string|null;key:string|undefined;cas:string|undefined;csrf:string|undefined};
export async function installDeviceApi(page:Page,respond:(route:Route,request:Request,wire:DeviceWire)=>Promise<boolean|void>) {
  await installVisualApi(page,visualOverview);
  const calls:DeviceWire[]=[];
  await page.route('**/api/v1/me/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(!path.includes('/device-authorizations/')&&!path.includes('/agent-connections')){await route.fallback();return;}
    const headers=await request.allHeaders();const wire={path,method:request.method(),body:request.postData(),key:headers['idempotency-key'],cas:headers['if-match'],csrf:headers['x-csrf-token']};calls.push(wire);
    if(await respond(route,request,wire))return;
    if(path.endsWith('/agent-connections'))await route.fulfill({json:{items:[deviceConnection()],operational_authority:false}});
    else if(path.endsWith('/inspect'))await route.fulfill({json:deviceReview()});
    else if(path.endsWith('/decide')){const body=request.postDataJSON();await route.fulfill({json:{authorizationId:body.authorizationId,requestDigest:body.requestDigest,state:body.decision==='approve'?'approved':'denied',operational_authority:false}});}
    else await route.fulfill({json:deviceConnection()});
  });return calls;
}
export async function startDevicePortal(harness=false) {
  const directory=await mkdtemp(join(tmpdir(),'fp-device-ui-'));let root=resolve('apps/portal-web/dist');
  try {
    if(harness){
      const repo=resolve('.');await writeFile(join(directory,'index.html'),'<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');
      await writeFile(join(directory,'fixture.js'),`import React from ${JSON.stringify(join(repo,'node_modules/react/index.js'))};
import {createRoot} from ${JSON.stringify(join(repo,'node_modules/react-dom/client.js'))};
import {PortalClient} from ${JSON.stringify(join(repo,'apps/portal-web/src/api.ts'))};
import {DeviceConnections} from ${JSON.stringify(join(repo,'apps/portal-web/src/modules/DeviceConnections.tsx'))};
const first=new PortalClient(),second=new PortalClient();first.csrfToken='first-client-fixture';second.csrfToken='second-client-fixture';
function Fixture(){const [client,setClient]=React.useState(first),[changed,setChanged]=React.useState(0);return React.createElement(React.Fragment,null,
React.createElement('button',{onClick:()=>setClient(second)},'Replace client fixture'),React.createElement('output',{'aria-label':'Parent change count'},String(changed)),React.createElement(DeviceConnections,{client,onChanged:()=>setChanged(value=>value+1)}));}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));`);
      const {build}=await import('vite');root=join(directory,'dist');const previous=process.env.NODE_ENV;
      try{await build({configFile:false,root:directory,logLevel:'silent',resolve:{dedupe:['react','react-dom']},build:{outDir:root,emptyOutDir:true}});}
      finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
    }
    const server=createServer(async(req,res)=>{try{
      const path=resolve(root,'.'+new URL(req.url!,'http://fixture.invalid').pathname);if(path!==root&&!path.startsWith(root+'/')){res.writeHead(404);res.end();return;}
      const actual=extname(path)?path:join(root,'index.html');res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'} as Record<string,string>)[extname(actual)]??'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(await readFile(actual));
    }catch{res.writeHead(404);res.end();}});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    return {origin:'http://127.0.0.1:'+(server.address() as {port:number}).port,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}};
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
