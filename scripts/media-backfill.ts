import {
  pathToFileURL
} from 'node:url';
import {
  planOperatorBackfill,type OperatorBackfillPlan
} from '../packages/media-migration/operator-backfill.js';
/** An installation supplies a trusted host; neither arguments nor environment
 * can construct an ObjectStore, credentials, a member session or approval. */
export async function runMediaBackfill(args:string[],_env:NodeJS.ProcessEnv,installed?:{
  execute(plan:OperatorBackfillPlan):Promise<unknown>
}){
  try{
    const values:Record<string,string>={
    };
    let execute=false;
    const flags:Record<string,string>={
      '--environment':'environment','--expected-database':'database','--schema':'schema','--expected-role':'role','--release-sha':'releaseSha','--job-id':'jobId','--store-binding-id':'storeBindingId','--migration-id':'migrationId','--max-rows':'maxRows','--max-bytes':'maxBytes','--lease-seconds':'leaseSeconds','--purpose':'purpose'
    };
    for(let i=0;
    i<args.length;
    i++){
      if(args[i]==='--execute'){
        if(execute)throw Error();
        execute=true;
        continue;
      }const field=flags[args[i]];
      if(!field||Object.hasOwn(values,field)||!args[i+1]||args[i+1].startsWith('--'))throw Error();
      values[field]=args[++i];
    }const {
      environment,database,schema,role,releaseSha,jobId,storeBindingId,migrationId,maxRows,maxBytes,leaseSeconds,purpose
    }=values;
    const plan=planOperatorBackfill({
      target:{
        environment,database,schema,role,releaseSha
      },jobId,storeBindingId,migrationId,maxRows:Number(maxRows),maxBytes:Number(maxBytes),leaseSeconds:Number(leaseSeconds),purpose:purpose??'member.service-cover',logicalStore:'MEDIA'
    });
    if(!execute)return {
      exitCode:0,report:{
        format:'freedom.media-backfill-plan/v1',execution:'not_run',dataMoved:false,plan,approvalRequired:true,sourcePreserved:true
      }
    };
    if(!installed)return {
      exitCode:2,report:{
        status:'unavailable',code:'trusted_backfill_host_not_installed',dataMoved:false
      }
    };
    const result=await installed.execute(plan);
    return {
      exitCode:0,report:{
        format:'freedom.media-backfill-result/v1',result
      }
    };
  }catch{
    return {
      exitCode:2,report:{
        status:'unavailable',code:'operator_backfill_unavailable'
      }
    };
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await runMediaBackfill(process.argv.slice(2),process.env);
  console.log(JSON.stringify(result.report));
  process.exitCode=result.exitCode;
}
