import { z } from 'zod';
import { Problem, requireCondition } from '../../packages/shared/problem.js';

// A repository coordinate, never an arbitrary URL for the server to fetch.
const coordinate = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
export function githubCoordinate(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Problem(422,'invalid_github_url','請填入公開 GitHub 儲存庫網址。'); }
  const name=url.pathname.replace(/^\//,'').replace(/\/$/,'').replace(/\.git$/,'');
  requireCondition(url.protocol==='https:' && url.hostname==='github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && coordinate.test(name) && !name.split('/').some(part=>part==='.'||part==='..'),422,'invalid_github_url','請使用 https://github.com/擁有者/儲存庫；不接受其他網站或檔案網址。');
  return name;
}

// These URLs are displayed as external links only. They are never fetched or embedded.
export function externalHttpsUrl(value: string): string {
  let url: URL;
  try { url=new URL(value); } catch { throw new Problem(422,'invalid_external_url','請使用完整 HTTPS 網址。'); }
  requireCondition(url.protocol==='https:' && !url.username && !url.password && !url.port && url.hostname.includes('.') && !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[)/i.test(url.hostname) && !/\.(localhost|local|internal|test|invalid)$/i.test(url.hostname),422,'invalid_external_url','請使用公開 HTTPS 網址，不要放私人或本機位址。');
  return url.href;
}
export const externalLink = z.string().trim().min(1).max(2000).transform(externalHttpsUrl);
const repoSchema=z.object({id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),full_name:z.string().regex(coordinate),private:z.literal(false),visibility:z.literal('public'),default_branch:z.string().min(1).max(255),fork:z.boolean(),archived:z.boolean()});
const commitSchema=z.object({sha:z.string().regex(/^[a-f0-9]{40}$/)});
const licenseSchema=z.object({license:z.object({spdx_id:z.string().min(1).max(100)}).nullable(),path:z.string().min(1).max(500)});

function retryAfterSeconds(header:string|null):number|undefined {
  if(!header)return undefined;
  const trimmed=header.trim();
  if(/^\d+$/.test(trimmed)){const value=Number(trimmed);return value>86400?undefined:value;}
  const parsed=Date.parse(trimmed);
  if(!Number.isFinite(parsed))return undefined;
  const delta=Math.ceil((parsed-Date.now())/1000);
  return delta<0||delta>86400?undefined:delta;
}
const PUBLIC_REPO_MISSING='找不到公開儲存庫或可讀取的版本；請檢查網址與公開設定。';
// A token that can see a private or internal repo must look exactly like a missing public repo.
export function concealedRepository(raw:unknown):boolean {
  if(!raw||typeof raw!=='object')return false;
  const value=raw as {private?:unknown;visibility?:unknown};
  if(value.private===true)return true;
  return typeof value.visibility==='string'&&value.visibility!=='public';
}
export function retryAnonymousGitHubRead(error:unknown):error is Problem {
  return error instanceof Problem&&(error.code==='github_rate_limited'||error.code==='github_token_rejected');
}
async function responseSnippet(response:Response,max=2048):Promise<string> {
  const reader=response.body?.getReader();
  if(!reader)return '';
  const chunks:Uint8Array[]=[];let size=0;
  try {
    while(size<max){
      const {done,value}=await reader.read();
      if(done||!value)break;
      const slice=value.byteLength>max-size?value.subarray(0,max-size):value;
      chunks.push(slice);size+=slice.byteLength;
      if(slice.byteLength<value.byteLength)break;
    }
  } catch { /* Classification only; the status is already final. */ }
  try{await reader.cancel();}catch{/* already closed */ }
  return Buffer.concat(chunks).toString('utf8');
}
export type GitHubRead = {
  status: number;
  etag: string | null;
  retryAfter: string | null;
  rateRemaining: string | null;
  rateReset: string | null;
  pollInterval: string | null;
  /** Parsed JSON on 200. Raw text on other statuses so the caller can classify the body. Null when there is no body. */
  body: unknown;
};

const githubHeaders = {'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Freedom-Platform-public-registry'};

/** Header-aware GitHub GET. Does not follow redirects. HTTP statuses, including 3xx other than 304, are returned. An opaque redirect is rejected. */
export async function readGitHub(path:string,signal:AbortSignal,fetcher:typeof fetch,maxBytes=4194304,token?:string,ifNoneMatch?:string):Promise<GitHubRead> {
  let response:Response;
  try {
    response=await fetcher(`https://api.github.com${path}`,{headers:{...githubHeaders,...(token?{Authorization:`Bearer ${token}`}:{}),...(ifNoneMatch?{'If-None-Match':ifNoneMatch}:{})},redirect:'manual',signal});
  } catch { throw new Problem(503,'github_unavailable','暫時無法讀取 GitHub，已保留原本資料。請稍後重新嘗試。'); }
  const meta = {
    etag: response.headers.get('etag'),
    retryAfter: response.headers.get('retry-after'),
    rateRemaining: response.headers.get('x-ratelimit-remaining'),
    rateReset: response.headers.get('x-ratelimit-reset'),
    pollInterval: response.headers.get('x-poll-interval'),
  };
  if (response.status>=300&&response.status<400&&response.status!==304) {
    try { await response.body?.cancel(); } catch { /* The status is already final. */ }
    return {status:response.status,...meta,body:null};
  }
  if (response.type==='opaqueredirect') {
    try { await response.body?.cancel(); } catch { /* The status is already final. */ }
    throw new Problem(503,'github_unavailable','暫時無法讀取 GitHub，已保留原本資料。請稍後重新嘗試。');
  }
  if (response.status===304) {
    try { await response.body?.cancel(); } catch { /* A 304 has no payload. */ }
    return {status:304,...meta,body:null};
  }
  const reader=response.body?.getReader();
  if (!reader) return {status:response.status,...meta,body:null};
  const chunks:Uint8Array[]=[];let size=0;
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      size+=value.byteLength;
      if (size>maxBytes) { await reader.cancel(); throw new Problem(503,'github_response_too_large','GitHub 回應過大，這次未匯入。'); }
      chunks.push(value);
    }
  } catch (error) { if (error instanceof Problem) throw error; throw new Problem(503,'github_invalid_response','GitHub 回應不完整，請稍後重試。'); }
  const text=Buffer.concat(chunks).toString('utf8');
  if (response.status!==200) return {status:response.status,...meta,body:text};
  try { return {status:200,...meta,body:text?JSON.parse(text):null}; }
  catch { throw new Problem(503,'github_invalid_response','GitHub 回應不完整，請稍後重試。'); }
}

export async function publicJson(path:string,signal:AbortSignal,fetcher:typeof fetch,missingLicense=false,maxBytes=196608,token?:string):Promise<unknown> {
  let response:Response;
  try {
    response=await fetcher(`https://api.github.com${path}`,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Freedom-Platform-public-registry',...(token?{Authorization:`Bearer ${token}`}:{})},redirect:'manual',signal});
    if(response.type==='opaqueredirect'||(response.status>=300&&response.status<400))throw Error('redirect');
  } catch { throw new Problem(503,'github_unavailable','暫時無法讀取 GitHub，已保留原本資料。請稍後重新嘗試。'); }
  if(response.status===404 && missingLicense)return null;
  if(response.status===404)throw new Problem(422,'github_repository_unavailable',PUBLIC_REPO_MISSING);
  if(response.status===401 || response.status===403 || response.status===429){
    const remaining=response.headers.get('x-ratelimit-remaining')?.trim()??'';
    const snippet=response.status===403?await responseSnippet(response):'';
    if(response.status!==403){try{await response.body?.cancel();}catch{/* The status is already final. */}}
    const retry=retryAfterSeconds(response.headers.get('retry-after'));
    const rateLimited=response.status===429||remaining==='0'||/rate limit/i.test(snippet);
    // Anonymous 403 stays a rate limit. Only an authenticated rejection is distinct, and it is never logged with the token.
    if(token&&(response.status===401||(response.status===403&&!rateLimited)))throw new Problem(503,'github_token_rejected','GitHub 拒絕這次查詢，請稍後重試。',retry);
    if(response.status===403||response.status===429)throw new Problem(503,'github_rate_limited','GitHub 暫時限制查詢，請稍後重試。',retry);
  }
  requireCondition(response.ok,503,'github_unavailable','GitHub 暫時無法回覆，請稍後重新嘗試。');
  const reader=response.body?.getReader();
  requireCondition(reader,503,'github_invalid_response','GitHub 回應不完整，請稍後重試。');
  const chunks:Uint8Array[]=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw new Problem(503,'github_response_too_large','GitHub 回應過大，這次未匯入。');}chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch(error){if(error instanceof Problem)throw error;throw new Problem(503,'github_invalid_response','GitHub 回應不完整，請稍後重試。');}
}

// One anonymous retry on the same AbortSignal. Callers that already retry must keep calling publicJson directly.
export async function publicRepositoryJson(path:string,signal:AbortSignal,fetcher:typeof fetch,missingLicense=false,maxBytes=196608,token?:string):Promise<unknown> {
  if(!token)return publicJson(path,signal,fetcher,missingLicense,maxBytes);
  try { return await publicJson(path,signal,fetcher,missingLicense,maxBytes,token); }
  catch(error) {
    if(!retryAnonymousGitHubRead(error))throw error;
    try { return await publicJson(path,signal,fetcher,missingLicense,maxBytes); }
    catch(second) {
      if(second instanceof Problem&&error.retryAfterSeconds!==undefined&&second.retryAfterSeconds===undefined)second.retryAfterSeconds=error.retryAfterSeconds;
      throw second;
    }
  }
}
export async function inspectGitHubRepository(repositoryUrl:string,fetcher:typeof fetch=globalThis.fetch,token?:string) {
  const requested=githubCoordinate(repositoryUrl),signal=AbortSignal.timeout(8000);
  const repoRaw=await publicRepositoryJson(`/repos/${requested}`,signal,fetcher,false,196608,token);
  if(concealedRepository(repoRaw))throw new Problem(422,'github_repository_unavailable',PUBLIC_REPO_MISSING);
  const repo=repoSchema.safeParse(repoRaw);
  requireCondition(repo.success,422,'github_repository_unavailable','只能匯入可驗證的公開 GitHub 儲存庫。');
  const fullName=repo.data.full_name;
  const commit=commitSchema.safeParse(await publicRepositoryJson(`/repos/${fullName}/commits/${encodeURIComponent(repo.data.default_branch)}`,signal,fetcher,false,196608,token));
  requireCondition(commit.success,503,'github_invalid_response','GitHub 尚未回傳可固定的版本，請稍後重試。');
  const licenseRaw=await publicRepositoryJson(`/repos/${fullName}/license?ref=${commit.data.sha}`,signal,fetcher,true,196608,token);
  const license=licenseRaw===null?null:licenseSchema.safeParse(licenseRaw);
  requireCondition(license===null || license.success,503,'github_invalid_response','GitHub 授權資料不完整，請稍後重試。');
  const repository_url=`https://github.com/${fullName}`;
  return {
    repository_id:String(repo.data.id),repository_full_name:fullName,repository_url,
    commit_sha:commit.data.sha,default_branch:repo.data.default_branch,
    readme_url:`${repository_url}/tree/${commit.data.sha}#readme`,
    license_spdx:license?.data?.license?.spdx_id??'NOASSERTION',
    license_evidence_url:license?.data?`${repository_url}/blob/${commit.data.sha}/${license.data.path.split('/').map(encodeURIComponent).join('/')}`:null,
    is_fork:repo.data.fork,archived:repo.data.archived,inspected_at:new Date().toISOString(),
    provider:'github_public_api' as const,
  };
}
