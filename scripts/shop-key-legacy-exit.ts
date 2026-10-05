import {open,constants} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createShopWriterObserver,connectShopExitTarget,planShopKeyLegacyExit,type ShopExitBinding,type ShopExitTarget} from '../modules/agent-commerce/key-exit.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
/** No default connection, credential discovery, mutation, key stamping or rollout.
 * The operator must select this reviewed tool and its private target/source file.
 * The file supplies expectations, never installed-policy observations; the
 * adapter must independently GET each selected health endpoint and query SQL. */
export async function runShopKeyExit(argv:readonly string[]){
 if(argv.length===0||(argv.length===1&&argv[0]==='--plan'))return {format:'freedom.shop-key-exit-plan/v1',status:'plan_only',mutations:0,
  database_reads:0,network_requests:0,deployment_authority:false,checks:['explicit private operator target bindings','actual database/schema/session role/read-only identity',
   'HTTPS health exact approved source and explicit observed shop issuer profile/policy before and after SQL','bounded active legacy/bound-key inventory','cross-environment active hash reuse'],
  required_environment:['FREEDOM_SHOP_EXIT_PUBLIC_DATABASE_URL','FREEDOM_SHOP_EXIT_STAGING_DATABASE_URL']};
 if(argv.length!==3||argv[0]!=='--execute-readonly'||argv[1]!=='--host-bindings')throw Error('shop_exit_arguments_invalid');
 const path=resolve(argv[2]),rel=relative(ROOT,path);
 if(rel===''||(!rel.startsWith('..'+ '/')&&!isAbsolute(rel)))throw Error('shop_exit_host_file_invalid');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bindings:ShopExitBinding[];
 try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>16384||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('shop_exit_host_file_invalid');
  bindings=JSON.parse(await file.readFile('utf8'));if(!Array.isArray(bindings))throw Error('shop_exit_host_file_invalid');
 }finally{await file.close();}
 // Validates exact public expectation fields before reading connection secrets.
 const observer=createShopWriterObserver(bindings),targets:ShopExitTarget[]=[];
 try{
  for(const binding of bindings){
   const name=binding.environment==='public'?'FREEDOM_SHOP_EXIT_PUBLIC_DATABASE_URL':'FREEDOM_SHOP_EXIT_STAGING_DATABASE_URL';
   const configured=process.env[name];if(!configured)throw Error('shop_exit_connection_unavailable');
   targets.push(connectShopExitTarget(binding,configured));
  }
  return await planShopKeyLegacyExit(targets,observer);
 }finally{await Promise.all(targets.map(target=>target.close()));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const result=await runShopKeyExit(process.argv.slice(2));console.log(JSON.stringify(result));if(result.status!=='plan_only'&&result.status!=='eligible_for_review')process.exitCode=2;}
 catch{console.error(JSON.stringify({format:'freedom.shop-key-exit/v1',status:'unavailable',mutations:0,deployment_authority:false,code:'shop_exit_unavailable'}));process.exitCode=2;}
}
