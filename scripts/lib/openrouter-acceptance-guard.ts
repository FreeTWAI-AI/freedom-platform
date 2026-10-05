import {constants} from 'node:fs';
import {open,lstat,mkdir,readdir,readFile,rmdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';

const fail=():never=>{throw Error('acceptance_guard_unavailable');};
/** No overwrites, symlinks, permissive directories, or raw diagnostic payloads. */
export async function privateDirectory(path:string) {
  const stat=await lstat(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())fail();
}
export async function durableCreate(path:string,value:unknown) {
  await privateDirectory(dirname(path));
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
  const parent=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY);
  try{await parent.sync();}finally{await parent.close();}
}
export async function privateKeyBytes(path:string) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await file.stat();
    if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size<16||stat.size>1024)fail();
    const bytes=await file.readFile();
    // Raw bytes only: no JSON credential stores, shell syntax, or silent trimming.
    if(!/^sk-or-v1-[A-Za-z0-9_-]+$/.test(bytes.toString('utf8'))){bytes.fill(0);fail();}
    return bytes;
  }finally{await file.close();}
}
export interface AcceptanceBudget {model:string;expiresAt:string;maxUsd:number}
export function validateBudget(value:AcceptanceBudget,now=Date.now()) {
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.model)
    ||!Number.isFinite(value.maxUsd)||value.maxUsd<=0||value.maxUsd>10
    ||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=now
    ||Date.parse(value.expiresAt)>now+24*60*60*1000)fail();
}
/** One shared private session ledger, including earlier root-only calls. Keep
 * every $0.10 reservation even after a response: usage reporting can lag, and a
 * process crash/timeout must never return unknown spend to the available budget. */
export async function reserveSessionBudget(directory:string,runId:string,budget:AcceptanceBudget) {
  await privateDirectory(directory);validateBudget(budget);
  if(!/^[a-f0-9-]{36}$/.test(runId))fail();
  const lock=join(directory,'reservation.lock');await mkdir(lock,{mode:0o700});
  try {
    const session=JSON.parse(await readFile(join(directory,'session.json'),'utf8'));
    if(session.profile!=='private-ai.provider-session-ledger/v1'||session.maxUsd!==budget.maxUsd
      ||session.expiresAt!==budget.expiresAt||!Number.isFinite(session.priorReservedUsd)||session.priorReservedUsd<0.10
      ||!Number.isFinite(session.priorKnownCostUsd)||session.priorKnownCostUsd<0||session.priorKnownCostUsd>session.priorReservedUsd)fail();
    let reserved=session.priorReservedUsd;
    for(const name of await readdir(directory)) {
      if(!/^reservation-[a-f0-9-]{36}\.json$/.test(name))continue;
      const entry=JSON.parse(await readFile(join(directory,name),'utf8'));
      if(entry.profile!=='private-ai.provider-budget-reservation/v1'||entry.reservedUsd!==0.10)fail();
      reserved+=entry.reservedUsd;
    }
    if(reserved+0.10>budget.maxUsd+Number.EPSILON)fail();
    await durableCreate(join(directory,'reservation-'+runId+'.json'),{profile:'private-ai.provider-budget-reservation/v1',runId,
      reservedUsd:0.10,at:new Date().toISOString(),unknownSpendNeverReleased:true});
    return {reservedUsd:0.10,sessionReservedUsd:Number((reserved+0.10).toFixed(8)),priorKnownCostUsd:session.priorKnownCostUsd};
  }finally{await rmdir(lock);}
}
/** Real HTTPS forwarding, never synthetic provider responses. The supplied
 * transport exists only for hermetic guard tests; the CLI passes global fetch.
 * Requests/bodies/auth headers never enter receipts or diagnostics. */
export function createAcceptanceEgress(budget:AcceptanceBudget,directory:string,transport:typeof fetch) {
  validateBudget(budget);
  let posts=0,gets=0,lastStatus:number|null=null,usageBefore:number|null=null,keyCheckedAt=0;
  let dispatchUnknown=false,maxRunUsd:number|null=null,reportedCostUsd:number|null=null;
  const summary=()=>({posts,gets,lastStatus,usageBefore,maxRunUsd,reportedCostUsd,dispatchUnknown});
  async function forward(request:Request):Promise<Response> {
    try {
      validateBudget(budget);
      const url=new URL(request.url),isKey=url.pathname==='/api/v1/key';
      if(url.origin!=='https://openrouter.ai'||url.search||url.hash||url.username||url.password)fail();
      if(request.method==='GET') {
        if(!isKey&&url.pathname!=='/api/v1/model/'+budget.model)fail();
        if(++gets>12)fail();
      } else if(request.method==='POST'&&url.pathname==='/api/v1/chat/completions') {
        if(posts!==0||usageBefore===null||Date.now()-keyCheckedAt>60000||usageBefore>=budget.maxUsd||maxRunUsd===null||usageBefore+maxRunUsd>budget.maxUsd)fail();
        const bytes=new Uint8Array(await request.clone().arrayBuffer());
        try {
          if(bytes.byteLength>16384)fail();
          const body=JSON.parse(new TextDecoder().decode(bytes));
          if(body.model!==budget.model||body.max_completion_tokens!==128||body.stream===true
            ||body.models!==undefined||body.route!==undefined||body.tools?.length||body.provider?.allow_fallbacks!==false)fail();
        }finally{bytes.fill(0);}
        // Set the in-memory gate before any await, then fsync a permanent fence
        // before network dispatch. This directory cannot be used for a rerun.
        posts=1;dispatchUnknown=true;
        await durableCreate(join(directory,'dispatch-intent.json'),{profile:'private-ai.real-provider-dispatch/v1',at:new Date().toISOString(),model:budget.model,maxOutputTokens:128,maxPosts:1});
      }else fail();
      const body=request.method==='POST'?await request.arrayBuffer():undefined;
      let response:Response;
      try {response=await transport(url.href,{method:request.method,headers:request.headers,body,redirect:'error',signal:AbortSignal.timeout(20000)});}
      finally{if(body)new Uint8Array(body).fill(0);}
      lastStatus=response.status;
      if(request.method==='POST'&&response.ok) {
        const usage=(await response.clone().json()).usage;
        if(typeof usage?.cost==='number'&&Number.isFinite(usage.cost)&&usage.cost>=0)reportedCostUsd=usage.cost;
      }
      if(isKey&&response.ok) {
        const data=(await response.clone().json()).data;
        if(!data||typeof data.limit!=='number'||data.limit<=0||data.limit>budget.maxUsd
          ||typeof data.usage!=='number'||!Number.isFinite(data.usage)||data.usage<0||data.usage>=data.limit
          ||typeof data.expires_at!=='string'
          ||!Number.isFinite(Date.parse(data.expires_at))||Date.parse(data.expires_at)<=Date.now()||Date.parse(data.expires_at)>Date.parse(budget.expiresAt))fail();
        usageBefore=data.usage;keyCheckedAt=Date.now();
      }
      if(request.method==='GET'&&!isKey&&response.ok) {
        const data=(await response.clone().json()).data;
        const price=(value:unknown)=>typeof value==='string'&&/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)?Number(value):NaN;
        const prompt=price(data?.pricing?.prompt),completion=price(data?.pricing?.completion),requestFee=price(data?.pricing?.request??'0');
        // Byte bound dominates text token count; reserve extra protocol tokens.
        const estimate=17408*prompt+128*completion+requestFee;
        if(data?.id!==budget.model||!Number.isFinite(estimate)||estimate<0||estimate>0.10)fail();
        maxRunUsd=estimate;
      }
      // A returned HTTP response alone does not prove a committed private Result.
      return response;
    }catch {return Response.json({error:'acceptance_egress_unavailable'},{status:503});}
  }
  return {forward,summary,markResultCommitted(){dispatchUnknown=false;}};
}
