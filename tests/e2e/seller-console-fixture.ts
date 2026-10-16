import {randomBytes,randomUUID} from 'node:crypto';
import {serve} from '@hono/node-server';
import {serveStatic} from '@hono/node-server/serve-static';
import {test as base,expect,type Page,type BrowserContext} from './fixtures.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {CommerceCredentialKeyring} from '../../modules/agent-commerce/payments/credentials.js';
import {FixtureEmailSender} from '../../modules/agent-commerce/operations/notifications/email-port.js';
import {createE2eEcpayFixture} from '../../scripts/e2e-ecpay-fixture.js';
import {readCommerceSettings} from '../../modules/agent-commerce/operations/runtime-settings.js';
import {e2eAuthorClaimAdminVerifier} from '../../packages/testing/e2e-admin.js';
import {TENANT_CURSOR_TEST_KEY} from '../runtime/tenant-cursor-fixture.js';
import {apiLogin,ownedSchema} from './hosted-order-fixture.js';
export * from './fixtures.js';
export const test=base.extend({baseURL:async({e2eAuthPool},use)=>{
 await ownedSchema(e2eAuthPool);let app:ReturnType<typeof createApp>|undefined,paymentFixture:ReturnType<typeof createE2eEcpayFixture>|undefined;
 const server=serve({hostname:'127.0.0.1',port:0,fetch:request=>['/__e2e/ecpay/','/__e2e/commerce/'].some(p=>new URL(request.url).pathname.startsWith(p))?paymentFixture?.routes.fetch(request)??new Response(null,{status:503}):app?.fetch(request)??new Response(null,{status:503})});
 try{if(!server.listening)await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});const address=server.address();if(!address||typeof address==='string')throw Error('No owned listener');const origin=`http://127.0.0.1:${address.port}`,ring=CommerceCredentialKeyring.parse('e2e:'+randomBytes(32).toString('base64'))!,emailSender=new FixtureEmailSender();
 paymentFixture=createE2eEcpayFixture({freedomEnv:'local',origin,pool:e2eAuthPool,keyring:ring,emailSender,forward:request=>Promise.resolve(app!.fetch(request))});
 app=createApp(e2eAuthPool,origin,'local',{guildLaunchpadEnabled:true,hostedReservationsEnabled:true,supplierConsoleEnabled:true,commerceQueryTransport:paymentFixture.transport,commercePayments:{gateway:paymentFixture.gateway,journal:paymentFixture.journal,profiles:paymentFixture.profiles},commerceEmailSender:emailSender,commercePorts:{shipping:paymentFixture.shipping},commerceCredentialKeyring:ring,commerceSettings:readCommerceSettings({FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true',FREEDOM_SUPPLIER_CONSOLE_ENABLED:'true',FREEDOM_COMMERCE_CONSOLE_ENABLED:'true',FREEDOM_COMMERCE_CHECKOUT_ENABLED:'true',FREEDOM_COMMERCE_EMAIL_ENABLED:'true',FREEDOM_COMMERCE_PROVIDER_PROFILES:paymentFixture.profiles.join(',')}),adminVerifier:e2eAuthorClaimAdminVerifier,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});
 app.use('/*',serveStatic({root:'./apps/portal-web/dist'}));app.get('*',serveStatic({path:'./apps/portal-web/dist/index.html'}));await use(origin);
 }finally{if('closeAllConnections' in server)server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}});
export async function openSeller(page:Page,origin:string,email:string,hash:string){await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await apiLogin(page.context(),origin,email);await page.goto('/'+hash);await expect(page.locator('.seller-console')).toBeVisible();await expect(page.locator('.seller-business-bar')).not.toContainText('商店資料');}
export async function command(context:BrowserContext,origin:string,csrf:string,path:string,body:unknown={},version?:string,method='POST'){
 const r=await context.request.fetch('/api/v1'+path,{method,data:body,headers:{Origin:origin,'X-CSRF-Token':csrf,'Idempotency-Key':randomUUID(),...(version?{'If-Match':`"${version}"`}:{})}});expect(r.ok(),await r.text()).toBeTruthy();return r.json();
}
export async function verifyPassword(page:Page,password:string){const dialog=page.getByRole('dialog',{name:'驗證身分'});await expect(dialog).toBeVisible();await dialog.getByLabel('密碼',{exact:true}).fill(password);await dialog.getByRole('button',{name:'驗證並繼續',exact:true}).click();}
export async function placeForStore(context:BrowserContext,origin:string,store:{slug:string;product:{sku:string}}){
 const r=await context.request.post('/api/v1/public/stores/'+store.slug+'/checkouts',{data:{publication_revision:'1',lines:[{sku:store.product.sku,quantity:1}],contact:{name:'合成測試買家',email:'synthetic-seller@example.test',phone:'0000000000'},delivery:{method:'synthetic',address:'合成測試地址'},invoice:null,consents:[]},headers:{Origin:origin,'Idempotency-Key':randomUUID()}});expect(r.status(),await r.text()).toBe(201);const checkout=await r.json();const placed=await context.request.post('/api/v1/public/stores/'+store.slug+'/checkouts/'+checkout.checkout_ref+'/orders',{data:{terms_sha256:checkout.terms_sha256,client_order_id:randomUUID()},headers:{Origin:origin}});expect(placed.status(),await placed.text()).toBe(201);return placed.json();
}

export function taipeiDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
