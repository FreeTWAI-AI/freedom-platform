import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {transaction} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {communityCatalog} from '../community/catalog.js';
import {recordConfirmedStar,reconcileConfirmedStar} from '../community/discovery.js';
import {GitHubProviderError,GitHubSocialProvider,type GitHubSocialConfig,type GitHubTokens,type RepositorySnapshot} from './provider.js';
export type {GitHubSocialConfig} from './provider.js';

const HOUR=60*60*1000;
type MetricsRow={snapshot:RepositorySnapshot|null;checked_at:Date|null;retry_after:Date;last_error:string|null};
type Connection={user_id:string;community_id:string;github_user_id:string;github_login:string;encrypted_tokens:string};
export type GitHubSession={configured:boolean;connected:boolean;github_user:{id:string;login:string}|null};
export type GitHubMetrics={book_id:string;repository_url:string;stargazers_count:number|null;forks_count:number|null;open_issues_count:number|null;subscribers_count:number|null;pushed_at:string|null;language:string|null;archived:boolean|null;checked_at:string|null;stale:boolean;error:string|null};
const nullSnapshot={stargazers_count:null,forks_count:null,open_issues_count:null,subscribers_count:null,pushed_at:null,language:null,archived:null};
const poolState=new WeakMap<Pool,{inflight:Map<string,Promise<MetricsRow>>;providers:WeakMap<typeof fetch,GitHubSocialProvider>}>();
const identityTaken='這個 GitHub 帳號已連結另一個工坊帳號。請先從原本的工坊帳號解除連結，或改用其他 GitHub 帳號。';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function upstream(bookId:string){
  const book=communityCatalog.skill_books.find(item=>item.id===bookId);
  requireCondition(book,404,'skill_book_not_found','找不到這本技能書。');
  const url=new URL(book.upstream_url);
  requireCondition(url.protocol==='https:'&&url.hostname==='github.com'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname),422,'github_repository_unavailable','這本技能書沒有可連接的 GitHub 來源。');
  return {repository:url.pathname.replace(/^\//,'').replace(/\/$/,''),url:url.href};
}
function encode(key:Buffer,context:string,value:unknown){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(context));
  const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),data]).toString('base64');
}
function decode<T>(key:Buffer,context:string,value:string):T{
  try{const raw=Buffer.from(value,'base64');if(raw.length<29)throw new Error();const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAAD(Buffer.from(context));decipher.setAuthTag(raw.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8')) as T;}
  catch{throw new GitHubProviderError('github_reconnect_required',409);}
}

export class GitHubSocial {
  private key?:Buffer;
  private provider:GitHubSocialProvider;
  private inflight:Map<string,Promise<MetricsRow>>;
  constructor(private pool:Pool,private config?:GitHubSocialConfig,fetcher:typeof fetch=fetch){
    if(config){
      this.key=Buffer.from(config.tokenKey,'base64');
      const redirect=new URL(config.redirectUri);
      if(this.key.length!==32||this.key.toString('base64')!==config.tokenKey||!config.clientId||!config.clientSecret||redirect.username||redirect.password||redirect.search||redirect.hash||redirect.pathname!=='/github/callback'||(redirect.protocol!=='https:'&&!(redirect.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(redirect.hostname))))throw new Error('Invalid GitHub social configuration.');
    }
    let shared=poolState.get(pool);if(!shared){shared={inflight:new Map(),providers:new WeakMap()};poolState.set(pool,shared);}
    let provider=shared.providers.get(fetcher);if(!provider){provider=new GitHubSocialProvider(fetcher);shared.providers.set(fetcher,provider);}
    this.provider=provider;this.inflight=shared.inflight;
  }
  private configured(){requireCondition(this.config&&this.key,503,'github_not_configured','GitHub 連線尚未設定。');return this.config;}
  private context(actor:Actor,purpose:string){return `github-social/v1/${this.config?.clientId}/${actor.community_id}/${actor.user_id}/${purpose}`;}
  private async actorLock(q:PoolClient,actor:Actor){
    requireCondition((await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active FOR SHARE',[actor.user_id,actor.community_id])).rowCount===1,401,'session_expired','請重新登入。');
    requireCondition((await q.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[actor.session_hash,actor.user_id])).rowCount===1,401,'session_expired','請重新登入。');
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-social/${actor.user_id}`]);
  }
  private async member<T>(actor:Actor,run:(q:PoolClient)=>Promise<T>):Promise<T>{
    // Commit consumed OAuth states, attempt budgets and invalid-token removal even
    // when GitHub rejects a request. Unexpected database failures still roll back.
    const result=await transaction(this.pool,async q=>{
      await this.actorLock(q,actor);
      try{return {value:await run(q)};}catch(error){if(error instanceof Problem)return {error};throw error;}
    });
    if('error' in result)throw result.error;return result.value;
  }
  private async rate(q:PoolClient,actor:Actor,operation:string,limit:number,seconds=60){
    const row=(await q.query(`INSERT INTO github_social_rate_limits(user_id,operation,window_start,attempts) VALUES($1,$2,now(),1)
      ON CONFLICT(user_id,operation) DO UPDATE SET attempts=CASE WHEN github_social_rate_limits.window_start<now()-make_interval(secs=>$3) THEN 1 ELSE github_social_rate_limits.attempts+1 END,
      window_start=CASE WHEN github_social_rate_limits.window_start<now()-make_interval(secs=>$3) THEN now() ELSE github_social_rate_limits.window_start END RETURNING attempts`,[actor.user_id,operation,seconds])).rows[0];
    requireCondition(row.attempts<=limit,429,'github_rate_limited','GitHub 操作過於頻繁，請稍後再試。');
  }
  private async connection(q:PoolClient,actor:Actor):Promise<Connection|null>{return (await q.query('SELECT * FROM github_social_connections WHERE user_id=$1 AND community_id=$2',[actor.user_id,actor.community_id])).rows[0]??null;}
  private view(connection:Connection|null):GitHubSession{return {configured:!!this.config,connected:!!this.config&&!!connection,github_user:this.config&&connection?{id:connection.github_user_id,login:connection.github_login}:null};}
  async session(actor:Actor):Promise<GitHubSession>{return this.member(actor,async q=>this.view(await this.connection(q,actor)));}
  developmentApp(){
    const configured=Boolean(this.config?.appId&&this.config?.appSlug);
    return {configured,installation_url:configured?`https://github.com/apps/${this.config!.appSlug}/installations/new`:null};
  }
  // Caller already holds user -> member-guild locks; never open a nested transaction.
  async developmentEvidence(q:PoolClient,actor:Actor,target:string,working:string){
    this.configured();requireCondition(this.config?.appId,503,'github_development_not_configured','GitHub App 尚未完成開發連動設定。');
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-social/${actor.user_id}`]);
    const connection=await this.connection(q,actor);requireCondition(connection,409,'github_connect_required','請先連結 GitHub。');
    return this.withToken(q,actor,connection,async token=>{
      const identity=await this.provider.identity(token);
      requireCondition(identity.id===connection.github_user_id,409,'github_reconnect_required','GitHub 身分已變更，請重新連結。');
      return {...await this.provider.developmentAccess(target,working,this.config!.appId!,token),github_user_id:identity.id};
    });
  }
  async start(actor:Actor,returnTo='#guilds'){
    const config=this.configured();
    requireCondition(/^#[a-z][a-z0-9_-]{0,63}$/.test(returnTo)||communityCatalog.skill_books.some(book=>returnTo==='/development/skills/'+book.id),422,'github_return_to_invalid','請從工坊頁面重新連接 GitHub。');
    return this.member(actor,async q=>{
      await this.rate(q,actor,'oauth-start',5,600);
      const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),expires=new Date(Date.now()+10*60*1000);
      await q.query('DELETE FROM github_social_oauth_states WHERE user_id=$1 OR expires_at<now()',[actor.user_id]);
      await q.query(`INSERT INTO github_social_oauth_states(state_hash,user_id,community_id,session_hash,encrypted_verifier,return_to,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[hash(state),actor.user_id,actor.community_id,actor.session_hash,encode(this.key!,this.context(actor,`state/${hash(state)}/${actor.session_hash}`),verifier),returnTo,expires]);
      const authorization=new URL('https://github.com/login/oauth/authorize');
      authorization.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'select_account'}).toString();
      return {authorization_url:authorization.href,expires_at:expires.toISOString()};
    });
  }
  async complete(actor:Actor,state:string,code:string){
    const config=this.configured();
    requireCondition(/^[A-Za-z0-9_-]{43}$/.test(state)&&/^[A-Za-z0-9_-]{1,256}$/.test(code),422,'github_oauth_invalid','GitHub 授權資料不完整，請重新連接。');
    return this.member(actor,async q=>{
      await this.rate(q,actor,'oauth-complete',10,600);
      const row=(await q.query(`DELETE FROM github_social_oauth_states WHERE state_hash=$1 AND user_id=$2 AND community_id=$3 AND session_hash=$4 AND expires_at>now() RETURNING *`,[hash(state),actor.user_id,actor.community_id,actor.session_hash])).rows[0];
      requireCondition(row,409,'github_oauth_expired','GitHub 授權已到期或不是從這個登入工作階段發起，請重新連接。');
      const verifier=decode<string>(this.key!,this.context(actor,`state/${hash(state)}/${actor.session_hash}`),row.encrypted_verifier);
      const tokens=await this.provider.exchange(config,code,verifier),identity=await this.provider.identity(tokens.access_token);
      // One GitHub user ID links to one member. Serialize every callback for this
      // ID after the actor lock; a conflict keeps both members' rows untouched and
      // never revokes the provider grant, which may be the other member's token.
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-identity/${identity.id}`]);
      const taken=(await q.query('SELECT 1 FROM github_social_connections WHERE github_user_id=$1 AND user_id<>$2',[identity.id,actor.user_id])).rowCount;
      requireCondition(!taken,409,'github_identity_already_linked',identityTaken);
      // The unique constraint is the final guard (e.g. a direct database write).
      // Roll back only the insert so the consumed OAuth state still commits.
      await q.query('SAVEPOINT github_identity_link');
      let connected:Connection;
      try{
        connected=(await q.query(`INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(user_id) DO UPDATE SET community_id=$2,github_user_id=$3,github_login=$4,encrypted_tokens=$5,connected_at=now(),updated_at=now() RETURNING *`,[actor.user_id,actor.community_id,identity.id,identity.login,encode(this.key!,this.context(actor,'tokens'),tokens)])).rows[0];
      }catch(error){
        if((error as {code?:string;constraint?:string}).code!=='23505'||(error as {constraint?:string}).constraint!=='github_social_connections_github_user_unique')throw error;
        await q.query('ROLLBACK TO SAVEPOINT github_identity_link');
        throw new Problem(409,'github_identity_already_linked',identityTaken);
      }
      await q.query('RELEASE SAVEPOINT github_identity_link');
      return {...this.view(connected),return_to:row.return_to as string};
    });
  }
  private async access(q:PoolClient,actor:Actor,connection:Connection):Promise<string>{
    const config=this.configured();
    try{
      let tokens=decode<GitHubTokens>(this.key!,this.context(actor,'tokens'),connection.encrypted_tokens);
      if(tokens.expires_at!==null&&tokens.expires_at<Date.now()+60_000){
        requireCondition(tokens.refresh_token&&tokens.refresh_expires_at!==null&&tokens.refresh_expires_at>Date.now(),409,'github_reconnect_required','GitHub 連線已到期，請重新連接。');
        tokens=await this.provider.refresh(config,tokens.refresh_token);
        const identity=await this.provider.identity(tokens.access_token);
        requireCondition(identity.id===connection.github_user_id,409,'github_reconnect_required','GitHub 身分已變更，請重新連接。');
        await q.query('UPDATE github_social_connections SET github_login=$2,encrypted_tokens=$3,updated_at=now() WHERE user_id=$1',[actor.user_id,identity.login,encode(this.key!,this.context(actor,'tokens'),tokens)]);
      }
      return tokens.access_token;
    }catch(error){if(error instanceof Problem&&error.code==='github_reconnect_required')await q.query('DELETE FROM github_social_connections WHERE user_id=$1',[actor.user_id]);throw error;}
  }
  private async withToken<T>(q:PoolClient,actor:Actor,connection:Connection,run:(token:string)=>Promise<T>){
    try{return await run(await this.access(q,actor,connection));}
    catch(error){if(error instanceof Problem&&error.code==='github_reconnect_required')await q.query('DELETE FROM github_social_connections WHERE user_id=$1',[actor.user_id]);throw error;}
  }
  async starred(actor:Actor,bookId:string){
    const book=upstream(bookId);
    return this.member(actor,async q=>{
      const connection=await this.connection(q,actor);if(!this.config||!connection)return {book_id:bookId,connected:false,starred:null};
      await this.rate(q,actor,'star-read',90);
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-star/${connection.github_user_id}/${book.repository.toLowerCase()}`]);
      const starred=await this.withToken(q,actor,connection,token=>this.provider.starred(book.repository,token));
      await reconcileConfirmedStar(q,connection.github_user_id,book.repository,starred);
      return {book_id:bookId,connected:true,starred};
    });
  }
  async star(actor:Actor,bookId:string,desired:boolean){
    const book=upstream(bookId);z.boolean().parse(desired);this.configured();
    return this.member(actor,async q=>{
      await this.rate(q,actor,'star-write',30);
      const connection=await this.connection(q,actor);requireCondition(connection,409,'github_connect_required','請先連接自己的 GitHub 帳號。');
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-star/${connection.github_user_id}/${book.repository.toLowerCase()}`]);
      const token=await this.withToken(q,actor,connection,async token=>{await this.provider.star(book.repository,token,desired);return token;});
      await recordConfirmedStar(q,connection.github_user_id,book.repository,desired);
      // The star is already confirmed. Refresh public counts from GitHub itself;
      // never calculate +/-1 or turn a metrics failure into a failed star result.
      const key=book.repository.toLowerCase();
      // Public refreshes never acquire a user/session lock, so this ordering
      // cannot cycle. Waiting also prevents an older public fetch overwriting
      // the post-star snapshot or being mistaken for the new count.
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-metrics/${key}`]);
      try{await this.saveMetrics(q,key,await this.provider.metrics(book.repository,token));}
      catch(error){if(!(error instanceof GitHubProviderError))throw error;await this.failMetrics(q,key,error.code);}
      return {book_id:bookId,connected:true,starred:desired,confirmed:true};
    });
  }
  async disconnect(actor:Actor){
    return this.member(actor,async q=>{
      await this.rate(q,actor,'disconnect',10);
      const connection=await this.connection(q,actor);let providerRevoked:boolean|null=null;
      // Local removal succeeds even if GitHub is unavailable or the key rotated.
      await q.query('DELETE FROM github_social_connections WHERE user_id=$1 AND community_id=$2',[actor.user_id,actor.community_id]);
      await q.query('DELETE FROM github_social_oauth_states WHERE user_id=$1',[actor.user_id]);
      if(connection&&this.config&&this.key){try{const tokens=decode<GitHubTokens>(this.key,this.context(actor,'tokens'),connection.encrypted_tokens);await this.provider.revoke(this.config,tokens.access_token);providerRevoked=true;}catch{providerRevoked=false;}}
      return {...this.view(null),provider_revoked:providerRevoked};
    });
  }
  async metrics(bookId:string):Promise<GitHubMetrics>{
    const book=upstream(bookId),key=book.repository.toLowerCase();
    let pending=this.inflight.get(key);
    if(!pending){pending=this.loadMetrics(key,book.repository);this.inflight.set(key,pending);void pending.finally(()=>this.inflight.delete(key)).catch(()=>{});}
    return this.metricsView(bookId,book.url,await pending);
  }
  async cachedMetrics(bookId:string):Promise<GitHubMetrics>{
    const book=upstream(bookId),row=(await this.pool.query<MetricsRow>('SELECT snapshot,checked_at,retry_after,last_error FROM github_repository_metrics WHERE repository_key=$1',[book.repository.toLowerCase()])).rows[0];
    return this.metricsView(bookId,book.url,row??{snapshot:null,checked_at:null,retry_after:new Date(),last_error:null});
  }
  private metricsView(bookId:string,repositoryUrl:string,row:MetricsRow):GitHubMetrics{
    return {book_id:bookId,repository_url:repositoryUrl,...(row.snapshot??nullSnapshot),checked_at:row.checked_at?.toISOString()??null,stale:!row.checked_at||Date.now()-row.checked_at.getTime()>=HOUR||!!row.last_error,error:row.last_error};
  }
  private async saveMetrics(q:PoolClient,key:string,snapshot:RepositorySnapshot):Promise<MetricsRow>{
    return (await q.query<MetricsRow>(`INSERT INTO github_repository_metrics(repository_key,snapshot,checked_at,retry_after,last_error) VALUES($1,$2,now(),now()+interval '1 hour',NULL)
      ON CONFLICT(repository_key) DO UPDATE SET snapshot=$2,checked_at=now(),retry_after=now()+interval '1 hour',last_error=NULL RETURNING *`,[key,JSON.stringify(snapshot)])).rows[0];
  }
  private async failMetrics(q:PoolClient,key:string,code:string):Promise<MetricsRow>{
    return (await q.query<MetricsRow>(`INSERT INTO github_repository_metrics(repository_key,retry_after,last_error) VALUES($1,now()+interval '1 hour',$2)
      ON CONFLICT(repository_key) DO UPDATE SET retry_after=now()+interval '1 hour',last_error=$2 RETURNING *`,[key,code])).rows[0];
  }
  private async loadMetrics(key:string,repository:string):Promise<MetricsRow>{
    return transaction(this.pool,async q=>{
      const cached=()=>q.query<MetricsRow>('SELECT snapshot,checked_at,retry_after,last_error FROM github_repository_metrics WHERE repository_key=$1',[key]);
      let row=(await cached()).rows[0];if(row&&row.retry_after.getTime()>Date.now())return row;
      const locked=(await q.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`github-metrics/${key}`])).rows[0].acquired;
      if(!locked)return row??{snapshot:null,checked_at:null,retry_after:new Date(),last_error:'github_refresh_in_progress'};
      row=(await cached()).rows[0];if(row&&row.retry_after.getTime()>Date.now())return row;
      try{
        const snapshot=await this.provider.metrics(repository);
        return this.saveMetrics(q,key,snapshot);
      }catch(error){
        if(!(error instanceof GitHubProviderError))throw error;
        // One attempt per catalog repository/hour also bounds anonymous GitHub
        // quota use during outages; a failed refresh never invents zero counts.
        return this.failMetrics(q,key,error.code);
      }
    });
  }
}
