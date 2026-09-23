import pg from 'pg';
import { syncAdminAccess } from '../modules/platform-admin/access-sync.js';

// Run in a separate operational service with a private EnvironmentFile. Never
// import this entry point or its credentials into the web server.
const required=(name:string)=>{const value=process.env[name];if(!value)throw Error(`Missing ${name}.`);return value;};
let pool:pg.Pool|undefined;
try {
  const config={accountId:required('CF_ACCOUNT_ID'),appId:required('FREEDOM_ADMIN_SYNC_APP_ID'),policyId:required('FREEDOM_ADMIN_SYNC_POLICY_ID'),domain:required('FREEDOM_ADMIN_SYNC_DOMAIN'),token:required('CF_API_TOKEN')};
  pool=new pg.Pool({connectionString:required('DATABASE_URL'),max:1,connectionTimeoutMillis:5000});
  const result=await syncAdminAccess(pool,config,{force:process.argv.includes('--force')});
  if(result.checked)console.log(JSON.stringify(result));
}catch{
  // Provider payloads and connection strings may contain private details.
  console.error('Administrator access synchronization failed; pending changes will be retried.');
  process.exitCode=1;
}finally{await pool?.end();}
