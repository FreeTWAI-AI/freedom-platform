import {Pool} from 'pg';
import {pathToFileURL} from 'node:url';
import {validateInventoryTarget} from '../packages/media-migration/inventory.js';
import {planRestoredMediaAcl,lockdownRestoredMediaAcl,RestoreAclError} from '../packages/media-migration/restore-acl-lockdown.js';
/** Default plan does not read a database secret or open a connection. */
export async function runMediaRestoreAcl(args:string[],env:NodeJS.ProcessEnv){
 const failure=(code:string)=>({exitCode:2,report:{format:'freedom.media-restore-acl/v1',status:'unavailable',code,dataMoved:false,applicationInstalled:false,deploymentReady:false}});
 try{
  const flags:Record<string,string>={'--environment':'environment','--expected-database':'database','--schema':'schema','--expected-role':'role','--release-sha':'releaseSha','--runtime-role':'runtimeRole'},values:Record<string,string>={};let execute=false;
  for(let i=0;i<args.length;i++){const flag=args[i];if(flag==='--execute-lockdown'){if(execute)throw Error();execute=true;continue;}const field=flags[flag];if(!field||Object.hasOwn(values,field)||!args[i+1]||args[i+1].startsWith('--'))throw Error();values[field]=args[++i];}
  const {runtimeRole,...input}=values,target=validateInventoryTarget(input),options={target,runtimeRole};const plan=await planRestoredMediaAcl(options);if(!execute)return {exitCode:0,report:plan};
  const connectionString=env.FREEDOM_MEDIA_DATABASE_URL;if(!connectionString)return failure('database_configuration_required');
  const url=new URL(connectionString),entries=[...url.searchParams];if(!['postgres:','postgresql:'].includes(url.protocol)||url.hash||decodeURIComponent(url.pathname.slice(1))!==target.database||!(decodeURIComponent(url.username)===target.role||(target.environment!=='local'&&decodeURIComponent(url.username).startsWith(target.role+'.')&&/^[A-Za-z0-9_-]{1,80}$/.test(decodeURIComponent(url.username).slice(target.role.length+1))))||new Set(entries.map(([k])=>k)).size!==entries.length)return failure('database_target_mismatch');
  if(target.environment==='local'){
   if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||entries.some(([key])=>key!=='host'))return failure('database_target_mismatch');
   const socket=url.searchParams.get('host');if(socket!==null&&(!/^\/[a-zA-Z0-9_./-]+$/.test(socket)||socket.includes('/../')||socket.includes('/./')))return failure('database_target_mismatch');
  }else if(url.searchParams.get('sslmode')!=='verify-full'||entries.some(([key])=>key!=='sslmode'))return failure('database_target_mismatch');
  const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:5000,application_name:'freedom-media-restore-acl'});
  try{return {exitCode:0,report:await lockdownRestoredMediaAcl(pool,options)};}finally{await pool.end();}
 }catch(error){return failure(error instanceof RestoreAclError?error.code:'invalid_arguments');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=await runMediaRestoreAcl(process.argv.slice(2),process.env);process.stdout.write(JSON.stringify(result.report,null,2)+'\n');process.exitCode=result.exitCode;}
