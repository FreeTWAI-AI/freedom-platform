import {developmentPages} from '../modules/development/pages.js';

const repository='FreeTWAI-AI/freedom-platform';
const pageIds=new Set(developmentPages.map(page=>page.id));
const marker=/<!--\s*freedom-page:([a-z0-9-]+)\s*-->/g;
type Issue={body?:string|null;pull_request?:unknown;labels?:Array<string|{name:string}>};
export function pageLabelForIssue(issue:Issue|null):string|null{
  if(!issue||typeof issue.body!=='string'||issue.pull_request)return null;
  const ids=[...issue.body.matchAll(marker)].map(match=>match[1]);
  return ids.length===1&&pageIds.has(ids[0])?`page:${ids[0]}`:null;
}
export async function labelIssue({fetcher=fetch,token,number,repo=repository}:{fetcher?:typeof fetch;token?:string;number:number;repo?:string}):Promise<{status:string;label?:string}>{
  if(repo!==repository||!Number.isSafeInteger(number)||number<1||!token)throw Error('Invalid page issue labeling input');
  const url=`https://api.github.com/repos/${repository}`;
  const headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Freedom-Platform-page-labeler',Authorization:`Bearer ${token}`};
  const request=async(path:string,init:RequestInit={}):Promise<any>=>{
    const response=await fetcher(`${url}${path}`,{...init,headers:{...headers,...init.headers}});
    if(!response.ok)throw Error(`GitHub page labeling failed: ${response.status}`);
    return response.json();
  };
  const issue=await request(`/issues/${number}`) as Issue;
  const label=pageLabelForIssue(issue);
  if(!label)return {status:'skipped'};
  if((issue.labels??[]).some(value=>(typeof value==='string'?value:value.name)===label))return {status:'already-labeled',label};
  const existing=await fetcher(`${url}/labels/${encodeURIComponent(label)}`,{headers});
  if(existing.status===404){
    await existing.body?.cancel();
    await request('/labels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:label,color:'1f6feb',description:`Freedom Platform page ${label.slice(5)}`})});
  }else if(!existing.ok){await existing.body?.cancel();throw Error(`GitHub label lookup failed: ${existing.status}`)}
  else await existing.body?.cancel();
  const labels=await request(`/issues/${number}/labels`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({labels:[label]})});
  if(!Array.isArray(labels)||!labels.some((value:unknown)=>typeof value==='object'&&value!==null&&'name' in value&&value.name===label))throw Error('GitHub did not confirm the page label');
  return {status:'labeled',label};
}
if(import.meta.url===new URL(`file://${process.argv[1]}`).href){
  const result=await labelIssue({token:process.env.GH_TOKEN,number:Number(process.env.ISSUE_NUMBER),repo:process.env.GITHUB_REPOSITORY});
  console.log(result.status,result.label??'');
}
