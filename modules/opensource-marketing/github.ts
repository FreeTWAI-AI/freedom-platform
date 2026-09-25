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

export async function publicJson(path:string,signal:AbortSignal,fetcher:typeof fetch,missingLicense=false,maxBytes=196608):Promise<unknown> {
  let response:Response;
  try {
    response=await fetcher(`https://api.github.com${path}`,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Freedom-Platform-public-registry'},redirect:'manual',signal});
    if(response.type==='opaqueredirect'||(response.status>=300&&response.status<400))throw Error('redirect');
  } catch { throw new Problem(503,'github_unavailable','暫時無法讀取 GitHub，已保留原本資料。請稍後重新嘗試。'); }
  if(response.status===404 && missingLicense)return null;
  if(response.status===404)throw new Problem(422,'github_repository_unavailable','找不到公開儲存庫或可讀取的版本；請檢查網址與公開設定。');
  if(response.status===403 || response.status===429)throw new Problem(503,'github_rate_limited','GitHub 暫時限制查詢，請稍後重試。');
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

export async function inspectGitHubRepository(repositoryUrl:string,fetcher:typeof fetch=globalThis.fetch) {
  const requested=githubCoordinate(repositoryUrl),signal=AbortSignal.timeout(8000);
  const repoRaw=await publicJson(`/repos/${requested}`,signal,fetcher);
  const repo=repoSchema.safeParse(repoRaw);
  requireCondition(repo.success,422,'github_repository_unavailable','只能匯入可驗證的公開 GitHub 儲存庫。');
  const fullName=repo.data.full_name;
  const commit=commitSchema.safeParse(await publicJson(`/repos/${fullName}/commits/${encodeURIComponent(repo.data.default_branch)}`,signal,fetcher));
  requireCondition(commit.success,503,'github_invalid_response','GitHub 尚未回傳可固定的版本，請稍後重試。');
  const licenseRaw=await publicJson(`/repos/${fullName}/license?ref=${commit.data.sha}`,signal,fetcher,true);
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
