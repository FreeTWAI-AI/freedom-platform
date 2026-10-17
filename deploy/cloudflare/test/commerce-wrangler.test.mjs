import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run} from '../preflight.mjs';
import {checkCommerceWranglerConfig} from '../lib/commerce-wrangler.mjs';
function check(config,setup) {
  const dir=mkdtempSync(join(tmpdir(),'commerce-wrangler-')),path=join(dir,'wrangler.jsonc');
  try{writeFileSync(path,JSON.stringify(config));return checkCommerceWranglerConfig(setup?.(dir,path)??path);}finally{rmSync(dir,{recursive:true,force:true});}
}
test('commerce declarations default off in every environment',()=>{assert.equal(check({env:{next:{},'staging-next':{vars:{FREEDOM_COMMERCE_QUARANTINE:'false'}}}}).structural,true);});
for(const flag of ['FREEDOM_COMMERCE_CHECKOUT_ENABLED','FREEDOM_COMMERCE_CONSOLE_ENABLED','FREEDOM_COMMERCE_EMAIL_ENABLED','FREEDOM_COMMERCE_QUARANTINE'])for(const value of [true,false,'TRUE',' true','false ',1,null]) {
  test(`${flag} rejects invalid flag type/value ${JSON.stringify(value)}`,()=>{
    const result=check({env:{next:{vars:{[flag]:value}}}});assert.equal(result.structural,false);assert(result.errors.includes('commerce_flag_invalid'));
  });
}
test('console requires launchpad in the same environment, not an inherited declaration',()=>{
  assert.equal(check({vars:{FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true'},env:{next:{vars:{FREEDOM_COMMERCE_CONSOLE_ENABLED:'true'}}}}).structural,false);
  assert.equal(check({env:{next:{vars:{FREEDOM_COMMERCE_CONSOLE_ENABLED:'true',FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true',FREEDOM_SUPPLIER_CONSOLE_ENABLED:'true'}}}}).structural,true);
});
test('console requires the supplier console in the same environment, not an inherited declaration',()=>{
  for(const value of [undefined,'false','TRUE'])assert(check({env:{next:{vars:{FREEDOM_COMMERCE_CONSOLE_ENABLED:'true',FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true',...(value===undefined?{}:{FREEDOM_SUPPLIER_CONSOLE_ENABLED:value})}}}}).errors.includes('commerce_supplier_console_required'));
  assert(check({vars:{FREEDOM_SUPPLIER_CONSOLE_ENABLED:'true'},env:{next:{vars:{FREEDOM_COMMERCE_CONSOLE_ENABLED:'true',FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true'}}}}).errors.includes('commerce_supplier_console_required'));
});
test('unknown commerce variables and unsafe declarations fail without copying names or values',()=>{
  const secret='synthetic-secret';const result=check({vars:{FREEDOM_COMMERCE_secret:secret}});assert.equal(result.structural,false);assert(!JSON.stringify(result).includes(secret));assert(!JSON.stringify(result).includes('FREEDOM_COMMERCE_secret'));
  for(const config of [null,[],{env:[]},{env:{next:null}},{vars:[]},{vars:null}])assert.equal(check(config).structural,false);
  assert.equal(check({},(dir,path)=>{const link=join(dir,'link');symlinkSync(path,link);return link;}).structural,false);
  assert.equal(check({},(dir,path)=>{linkSync(path,join(dir,'hard'));return path;}).structural,false);
  const absent=checkCommerceWranglerConfig('/does-not-exist');assert.equal(absent.structural,true);assert.deepEqual(absent.errors,[]);assert.deepEqual(absent.blockers,['config_unavailable']);
});

test('missing worker config is unavailable without failing preflight run',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'commerce-missing-'));
  try {
    const result=await run(['wrangler','--config',join(dir,'absent.jsonc')]);assert.equal(result.code,0);
    const report=JSON.parse(result.output);assert.equal(report.commerce_wrangler.structural,true);assert.deepEqual(report.commerce_wrangler.blockers,['config_unavailable']);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

for(const value of [undefined,''])test(`provider profiles disabled with ${String(value)}`,()=>{
  assert.equal(check({vars:{FREEDOM_COMMERCE_PROVIDER_PROFILES:value}}).structural,true);
});
for(const value of [true,null,1,' ', 'ecpay.aio.credit.v1,',',ecpay.aio.credit.v1','ecpay.aio.credit.v1,ecpay.aio.credit.v1','ecpay.aio.credit.v1,unknown','ecpay.aio.credit.v1\n','unknown'])test(`provider profiles reject ${JSON.stringify(value)} without echoing`,()=>{
  const result=check({vars:{FREEDOM_COMMERCE_PROVIDER_PROFILES:value}});assert.equal(result.structural,false);assert(result.errors.includes('commerce_provider_profiles_invalid'));
  if(typeof value==='string'&&value.length>2)assert(!JSON.stringify(result).includes(value));
});
test('offline-only provider profiles need no journal binding',()=>{
  for(const value of ['offline.bank_transfer.v1','offline.cash_on_meetup.v1','offline.bank_transfer.v1,offline.cash_on_meetup.v1']){
    const result=check({vars:{FREEDOM_COMMERCE_PROVIDER_PROFILES:value}});
    assert.equal(result.structural,true,JSON.stringify(result.errors));
    assert.deepEqual(result.errors,[]);
  }
  const mixed={vars:{FREEDOM_COMMERCE_PROVIDER_PROFILES:'ecpay.aio.credit.v1,offline.bank_transfer.v1'}};
  assert(check(mixed).errors.includes('commerce_journal_binding_required'));
  assert.equal(check({...mixed,r2_buckets:[{binding:'COMMERCE_JOURNAL',bucket_name:'synthetic-journal'}]}).structural,true);
});
test('each environment with provider profiles must declare its own journal binding',()=>{
  const vars={FREEDOM_COMMERCE_PROVIDER_PROFILES:'ecpay.aio.credit.v1'},r2_buckets=[{binding:'COMMERCE_JOURNAL',bucket_name:'synthetic-journal'}];
  assert.equal(check({vars,r2_buckets}).structural,true);
  for(const declaration of [{vars},{vars,r2_buckets:[]},{vars,r2_buckets:[{binding:'MEDIA'}]},{vars,r2_buckets:{}},{r2_buckets,env:{next:{vars}}}])assert(check(declaration).errors.includes('commerce_journal_binding_required'));
  assert.equal(check({env:{next:{vars,r2_buckets}}}).structural,true);
});
test('each environment with commerce email enabled must declare its own EMAIL send_email and COMMERCE_JOURNAL bindings',()=>{
  const vars={FREEDOM_COMMERCE_EMAIL_ENABLED:'true'},send_email=[{name:'EMAIL'}],r2_buckets=[{binding:'COMMERCE_JOURNAL',bucket_name:'synthetic-journal'}];
  assert.equal(check({vars,send_email,r2_buckets}).structural,true);
  assert.equal(check({env:{next:{vars,send_email,r2_buckets}}}).structural,true);
  for(const declaration of [{vars,r2_buckets},{vars,send_email:[],r2_buckets},{vars,send_email:[{name:'OTHER'}],r2_buckets},{vars,send_email:{},r2_buckets},{send_email,r2_buckets,env:{next:{vars,r2_buckets}}}]){
    const result=check(declaration);assert.equal(result.structural,false);assert(result.errors.includes('commerce_email_binding_required'));
  }
  for(const declaration of [{vars,send_email},{vars,send_email,r2_buckets:[]},{r2_buckets,env:{next:{vars,send_email}}}]){
    const result=check(declaration);assert.equal(result.structural,false);assert(result.errors.includes('commerce_journal_binding_required'));
  }
});


const paymentBlock = bucket => ({ vars: { FREEDOM_COMMERCE_PROVIDER_PROFILES: 'ecpay.aio.credit.v1' }, r2_buckets: [{ binding: 'COMMERCE_JOURNAL', bucket_name: bucket }] });
test('review 15: journal buckets cannot repeat across environment blocks', () => {
  for (const config of [
    { env: { staging: paymentBlock('synthetic-shared-journal'), public: paymentBlock('synthetic-shared-journal') } },
    { ...paymentBlock('synthetic-shared-journal'), env: { staging: paymentBlock('synthetic-shared-journal') } }
  ]) {
    const result = check(config);
    assert.equal(result.structural, false);
    assert(result.errors.includes('commerce_journal_bucket_reused'));
    assert(!JSON.stringify(result).includes('synthetic-shared-journal'));
  }
});
test('review 15: journal buckets cannot be any other R2 binding bucket in any block', () => {
  for (const sameBlock of [false, true]) {
    const config = { env: { staging: paymentBlock('synthetic-journal'), public: paymentBlock('synthetic-public-journal') } };
    const block = sameBlock ? config.env.staging : config.env.public;
    block.r2_buckets.push({ binding: 'MEDIA', bucket_name: 'synthetic-journal' });
    const result = check(config);
    assert.equal(result.structural, false);
    assert(result.errors.includes('commerce_journal_bucket_shared'));
    assert(!JSON.stringify(result).includes('synthetic-journal'));
  }
});
test('review 15: distinct journal buckets and media buckets pass across environments', () => {
  const config = { ...paymentBlock('synthetic-local-journal'), env: { staging: paymentBlock('synthetic-staging-journal'), public: paymentBlock('synthetic-public-journal') } };
  config.r2_buckets.push({ binding: 'MEDIA', bucket_name: 'synthetic-local-media' });
  config.env.staging.r2_buckets.push({ binding: 'MEDIA', bucket_name: 'synthetic-staging-media' });
  config.env.public.r2_buckets.push({ binding: 'MEDIA', bucket_name: 'synthetic-public-media' });
  assert.deepEqual(check(config).errors, []);
});

test('checkout requires console in its own environment',()=>{
  assert(check({vars:{FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true',FREEDOM_COMMERCE_CHECKOUT_ENABLED:'true'}}).errors.includes('commerce_console_required'));
  assert(check({vars:{FREEDOM_COMMERCE_CONSOLE_ENABLED:'true',FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true'},env:{next:{vars:{FREEDOM_COMMERCE_CHECKOUT_ENABLED:'true'}}}}).errors.includes('commerce_console_required'));
  assert.equal(check({vars:{FREEDOM_GUILD_LAUNCHPAD_ENABLED:'true',FREEDOM_SUPPLIER_CONSOLE_ENABLED:'true',FREEDOM_COMMERCE_CONSOLE_ENABLED:'true',FREEDOM_COMMERCE_CHECKOUT_ENABLED:'true'}}).structural,true);
});
