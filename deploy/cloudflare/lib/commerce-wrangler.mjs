import {lstatSync,readFileSync} from 'node:fs';
import {parseJsonc} from './wrangler.mjs';
const flags=new Set(['FREEDOM_COMMERCE_CHECKOUT_ENABLED','FREEDOM_COMMERCE_CONSOLE_ENABLED','FREEDOM_COMMERCE_EMAIL_ENABLED','FREEDOM_COMMERCE_QUARANTINE']);
/** Local declarations only. Fixed error names never copy config values or keys. */
export function checkCommerceWranglerConfig(path) {
  const errors=[],blockers=[];
  const report=()=>({schema:'freedom.commerce-worker-config/v1',structural:errors.length===0,errors,blockers,deployment_ready:false,provider_mutations:0});
  let config,stat;
  try {stat=lstatSync(path);}catch{blockers.push('config_unavailable');return report();}
  try {
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>262144)throw Error();
    config=parseJsonc(readFileSync(path,'utf8'));
    if(!config||typeof config!=='object'||Array.isArray(config))throw Error();
  }catch{errors.push('config_invalid_or_unsafe');return report();}
  if(config.env!==undefined&&(!config.env||typeof config.env!=='object'||Array.isArray(config.env)))errors.push('environments_invalid');
  const blocks=[config,...Object.values(config.env&&typeof config.env==='object'&&!Array.isArray(config.env)?config.env:{})];
  for(const block of blocks) {
    if(!block||typeof block!=='object'||Array.isArray(block)){errors.push('environment_invalid');continue;}
    if(block.vars!==undefined&&(!block.vars||typeof block.vars!=='object'||Array.isArray(block.vars))){errors.push('vars_invalid');continue;}
    const vars=block.vars??{};
    for(const flag of flags)if(vars[flag]!==undefined&&!['true','false'].includes(vars[flag]))errors.push('commerce_flag_invalid');
    if(Object.keys(vars).some(k=>k.startsWith('FREEDOM_COMMERCE_')&&!flags.has(k)&&k!=='FREEDOM_COMMERCE_PROVIDER_PROFILES'))errors.push('commerce_flag_unknown');
    const rawProfiles=vars.FREEDOM_COMMERCE_PROVIDER_PROFILES;
    if(rawProfiles!==undefined&&rawProfiles!==''){
      const implemented=new Set(['ecpay.aio.credit.v1','offline.bank_transfer.v1','offline.cash_on_meetup.v1']);
      const profiles=typeof rawProfiles==='string'?rawProfiles.split(','):[];
      if(typeof rawProfiles!=='string'||/\s/.test(rawProfiles)||!profiles.length||new Set(profiles).size!==profiles.length||profiles.some(p=>!implemented.has(p)))errors.push('commerce_provider_profiles_invalid');
      else if(profiles.some(p=>p.startsWith('ecpay.'))&&(!Array.isArray(block.r2_buckets)||!block.r2_buckets.some(b=>b&&typeof b==='object'&&b.binding==='COMMERCE_JOURNAL')))errors.push('commerce_journal_binding_required');
    }
    if(vars.FREEDOM_COMMERCE_EMAIL_ENABLED==='true'){
      if(!Array.isArray(block.send_email)||!block.send_email.some(e=>e&&typeof e==='object'&&e.name==='EMAIL'))errors.push('commerce_email_binding_required');
      if(!Array.isArray(block.r2_buckets)||!block.r2_buckets.some(b=>b&&typeof b==='object'&&b.binding==='COMMERCE_JOURNAL'))errors.push('commerce_journal_binding_required');
    }
    if(vars.FREEDOM_COMMERCE_CONSOLE_ENABLED==='true'&&vars.FREEDOM_GUILD_LAUNCHPAD_ENABLED!=='true')errors.push('commerce_launchpad_required');
    if(vars.FREEDOM_COMMERCE_CONSOLE_ENABLED==='true'&&vars.FREEDOM_SUPPLIER_CONSOLE_ENABLED!=='true')errors.push('commerce_supplier_console_required');
    if(vars.FREEDOM_COMMERCE_CHECKOUT_ENABLED==='true'&&vars.FREEDOM_COMMERCE_CONSOLE_ENABLED!=='true')errors.push('commerce_console_required');
  }
  // R2 declarations are environment-local; journal history must neither share
  // another environment's namespace nor enter any other binding's backup set.
  const buckets=blocks.flatMap((block,index)=>Array.isArray(block?.r2_buckets)
    ?block.r2_buckets.filter(b=>b&&typeof b==='object'&&typeof b.bucket_name==='string').map(b=>({...b,blockIndex:index})):[]);
  const journals=buckets.filter(b=>b.binding==='COMMERCE_JOURNAL');
  if(journals.some(j=>journals.some(other=>other.blockIndex!==j.blockIndex&&other.bucket_name===j.bucket_name)))errors.push('commerce_journal_bucket_reused');
  if(journals.some(j=>buckets.some(other=>other.binding!=='COMMERCE_JOURNAL'&&other.bucket_name===j.bucket_name)))errors.push('commerce_journal_bucket_shared');
  return report();
}
