import {ApiError,PortalClient} from '../api';

export type GitHubMetrics={book_id:string;repository_url:string;stargazers_count:number|null;forks_count:number|null;open_issues_count:number|null;subscribers_count:number|null;pushed_at:string|null;language:string|null;archived:boolean|null;checked_at:string|null;stale:boolean;error:string|null};
export type GitHubConnection={configured:boolean;connected:boolean;github_user:{id:string;login:string}|null};
export type GitHubStarState={book_id:string;starred:boolean|null;connected:boolean};
type Entry<T>={value?:T;loading:boolean;error:string;received:number};
const entry=<T>():Entry<T>=>({loading:false,error:'',received:0});
const message=(cause:unknown)=>cause instanceof Error?cause.message:'目前無法讀取 GitHub，請稍後重試。';

/** A provider owns each member's private state; only public metrics may outlive it. */
export class GitHubSocialStore {
  private revision=0;
  private listeners=new Set<()=>void>();
  private requests=new Map<string,Promise<void>>();
  private metrics=new Map<string,Entry<GitHubMetrics>>();
  private stars=new Map<string,Entry<GitHubStarState>&{saving:boolean}>();
  readonly account=entry<GitHubConnection>();
  constructor(private client:PortalClient,readonly member:boolean){}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  snapshot=()=>this.revision;
  private emit(){this.revision++;this.listeners.forEach(listener=>listener());}
  metric(bookId:string){if(!this.metrics.has(bookId))this.metrics.set(bookId,entry());return this.metrics.get(bookId)!;}
  star(bookId:string){if(!this.stars.has(bookId))this.stars.set(bookId,{...entry<GitHubStarState>(),saving:false});return this.stars.get(bookId)!;}
  private async read<T>(key:string,target:Entry<T>,path:string,ttl:number,force=false){
    const pending=this.requests.get(key);if(pending)return pending;
    if(!force&&target.received&&Date.now()-target.received<ttl)return;
    target.loading=true;target.error='';this.emit();
    let request!:Promise<void>;
    request=(async()=>{
      try{const value=await this.client.get<T>(path,{skipAuthHandler:true});if(this.requests.get(key)===request){target.value=value;target.received=Date.now();}}
      catch(cause){if(this.requests.get(key)===request){target.error=message(cause);target.received=Date.now();}}
      finally{if(this.requests.get(key)===request){target.loading=false;this.requests.delete(key);this.emit();}}
    })();
    this.requests.set(key,request);return request;
  }
  loadMetrics(bookId:string,force=false){return this.read(`metrics:${bookId}`,this.metric(bookId),`/github/books/${encodeURIComponent(bookId)}/metrics`,5*60_000,force);}
  loadAccount(force=false){if(!this.member)return Promise.resolve();return this.read('account',this.account,'/me/github',30_000,force);}
  loadStar(bookId:string,force=false){if(!this.member||!this.account.value?.connected)return Promise.resolve();return this.read(`star:${bookId}`,this.star(bookId),`/me/github/books/${encodeURIComponent(bookId)}/star`,30_000,force);}
  async refreshConnection(){
    for(const key of this.requests.keys())if(key==='account'||key.startsWith('star:'))this.requests.delete(key);
    this.account.value=undefined;this.account.received=0;this.stars.clear();this.emit();
    await this.loadAccount(true);
  }
  async toggleStar(bookId:string){
    const state=this.star(bookId);
    if(state.saving||typeof state.value?.starred!=='boolean'||!this.account.value?.connected)return;
    const desired=!state.value.starred;state.saving=true;state.error='';this.emit();
    try{
      const result=await this.client.post<GitHubStarState>(`/me/github/books/${encodeURIComponent(bookId)}/star`,{starred:desired,confirmed:true},{skipAuthHandler:true});
      state.value=result;state.received=Date.now();
      if(!result.connected||typeof result.starred!=='boolean')state.error='GitHub 連結已變更，請重新連結後再試。';
      // Public counters are independently cached by the server. Never add or subtract locally.
      await this.loadMetrics(bookId,true);
    }catch(cause){
      state.value=undefined;state.received=0;
      await this.loadStar(bookId,true);
      state.error=`Star 操作未確認。${message(cause)}`;
      if(cause instanceof ApiError&&(cause.status===401||cause.status===403))await this.loadAccount(true);
    }finally{state.saving=false;this.emit();}
  }
  async connect(returnTo:string){
    if(!this.member||!this.account.value?.configured)throw Error('GitHub 連結尚未啟用。');
    const value=await this.client.post<{authorization_url:string}>('/me/github/connect',{return_to:returnTo},{skipAuthHandler:true});
    const url=new URL(value.authorization_url);
    if(url.protocol!=='https:'||url.hostname!=='github.com'||url.pathname!=='/login/oauth/authorize'||url.username||url.password||url.port)throw Error('GitHub 連結網址無法確認，請重試。');
    return url.href;
  }
  async disconnect(){
    const result=await this.client.post<{provider_revoked:boolean|null}>('/me/github/disconnect',{},{skipAuthHandler:true});
    await this.refreshConnection();
    if(this.account.error||!this.account.value||this.account.value.connected)throw Error('解除連結結果待確認，請重新讀取 GitHub 連結狀態。');
    return result;
  }
}
