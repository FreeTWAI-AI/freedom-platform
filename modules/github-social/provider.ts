import {z} from 'zod';
import {Problem} from '../../packages/shared/problem.js';

export type GitHubSocialConfig={clientId:string;clientSecret:string;tokenKey:string;redirectUri:string};
export type GitHubTokens={access_token:string;refresh_token?:string;expires_at:number|null;refresh_expires_at:number|null};
export type GitHubIdentity={id:string;login:string};
export type RepositorySnapshot={stargazers_count:number;forks_count:number;open_issues_count:number;subscribers_count:number;pushed_at:string|null;language:string|null;archived:boolean};
const counter=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const repositorySchema=z.object({stargazers_count:counter,forks_count:counter,open_issues_count:counter,subscribers_count:counter,pushed_at:z.iso.datetime().nullable(),language:z.string().max(100).nullable(),archived:z.boolean(),private:z.literal(false)});
const tokensSchema=z.object({access_token:z.string().regex(/^ghu_[A-Za-z0-9_]+$/).max(1024),token_type:z.literal('bearer'),scope:z.literal('').optional(),expires_in:z.number().int().positive().max(86400).optional(),refresh_token:z.string().regex(/^ghr_[A-Za-z0-9_]+$/).max(1024).optional(),refresh_token_expires_in:z.number().int().positive().max(366*86400).optional()});
const identitySchema=z.object({id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),login:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)});
const API='https://api.github.com';
const VERSION='2026-03-10';
const MAX_BODY=128*1024;
export class GitHubProviderError extends Problem {
  constructor(code='github_unavailable',status=502){super(status,code,code==='github_reconnect_required'?'GitHub 連線已失效，請重新連接。':code==='github_rate_limited'?'GitHub 請求過於頻繁，請稍後再試。':'GitHub 暫時無法回應，請稍後再試。');}
}

/** Only fixed GitHub endpoints; bounded concurrency, deadline and response size.
 * Never expose a provider response body: it may contain credentials or user data.
 */
export class GitHubSocialProvider {
  private active=0;
  private waiting:(()=>void)[]=[];
  constructor(private fetcher:typeof fetch=fetch){}
  private async request(url:string,init:RequestInit={},allowed=[200]):Promise<{status:number;body:unknown}>{
    if(this.active>=4){
      if(this.waiting.length>=32)throw new GitHubProviderError('github_busy',503);
      await new Promise<void>(resolve=>this.waiting.push(resolve));
    }else this.active++;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await this.fetcher(url,{...init,redirect:'error',signal:controller.signal,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':VERSION,'User-Agent':'Freedom-Workshop-GitHub-Social',...init.headers}});
      if(!allowed.includes(response.status)){
        await response.body?.cancel();
        if(response.status===401)throw new GitHubProviderError('github_reconnect_required',409);
        if(response.status===429||(response.status===403&&(response.headers.get('x-ratelimit-remaining')==='0'||response.headers.has('retry-after'))))throw new GitHubProviderError('github_rate_limited',429);
        throw new GitHubProviderError(response.status===403?'github_permission_required':response.status===404?'github_repository_unavailable':'github_unavailable',response.status===403?403:502);
      }
      if(response.status===204||response.status===404){await response.body?.cancel();return {status:response.status,body:null};}
      if(Number(response.headers.get('content-length'))>MAX_BODY){await response.body?.cancel();throw new GitHubProviderError('github_invalid_response');}
      const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
      if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>MAX_BODY){await reader.cancel();throw new GitHubProviderError('github_invalid_response');}chunks.push(chunk.value);}
      let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new GitHubProviderError('github_invalid_response');}
      return {status:response.status,body};
    }catch(error){if(error instanceof GitHubProviderError)throw error;throw new GitHubProviderError();}
    finally{clearTimeout(timer);const next=this.waiting.shift();if(next)next();else this.active--;}
  }
  async metrics(repository:string,token?:string):Promise<RepositorySnapshot>{
    const response=await this.request(`${API}/repos/${repository}`,token?{headers:{Authorization:`Bearer ${token}`}}:{}),parsed=repositorySchema.safeParse(response.body);
    if(!parsed.success)throw new GitHubProviderError('github_invalid_response');
    const {private:_private,...snapshot}=parsed.data;return snapshot;
  }
  private async token(config:GitHubSocialConfig,fields:Record<string,string>):Promise<GitHubTokens>{
    const {body}=await this.request('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,...fields})});
    const parsed=tokensSchema.safeParse(body);if(!parsed.success)throw new GitHubProviderError('github_reconnect_required',409);
    const result=parsed.data;
    if((result.expires_in!==undefined)&&(!result.refresh_token||!result.refresh_token_expires_in))throw new GitHubProviderError('github_invalid_response');
    return {access_token:result.access_token,...(result.refresh_token?{refresh_token:result.refresh_token}:{}),expires_at:result.expires_in?Date.now()+result.expires_in*1000:null,refresh_expires_at:result.refresh_token_expires_in?Date.now()+result.refresh_token_expires_in*1000:null};
  }
  exchange(config:GitHubSocialConfig,code:string,verifier:string){return this.token(config,{code,redirect_uri:config.redirectUri,code_verifier:verifier});}
  refresh(config:GitHubSocialConfig,refreshToken:string){return this.token(config,{grant_type:'refresh_token',refresh_token:refreshToken});}
  async identity(token:string):Promise<GitHubIdentity>{
    const {body}=await this.request(`${API}/user`,{headers:{Authorization:`Bearer ${token}`}}),parsed=identitySchema.safeParse(body);
    if(!parsed.success)throw new GitHubProviderError('github_invalid_response');
    return {id:String(parsed.data.id),login:parsed.data.login};
  }
  async starred(repository:string,token:string):Promise<boolean>{
    const response=await this.request(`${API}/user/starred/${repository}`,{headers:{Authorization:`Bearer ${token}`}},[204,404]);return response.status===204;
  }
  async star(repository:string,token:string,desired:boolean):Promise<void>{
    await this.request(`${API}/user/starred/${repository}`,{method:desired?'PUT':'DELETE',headers:{Authorization:`Bearer ${token}`,'Content-Length':'0'}},[204]);
  }
  async revoke(config:GitHubSocialConfig,token:string):Promise<void>{
    await this.request(`${API}/applications/${encodeURIComponent(config.clientId)}/token`,{method:'DELETE',headers:{Authorization:`Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,'Content-Type':'application/json'},body:JSON.stringify({access_token:token})},[204,404]);
  }
}
