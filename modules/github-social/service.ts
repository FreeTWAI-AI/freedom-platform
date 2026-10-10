import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {transaction} from '../../packages/db/index.js';
import {assertCurrentSessionClock} from '../../packages/db/member-session.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {communityCatalog} from '../community/catalog.js';
import {recordConfirmedStar,reconcileConfirmedStar} from '../community/discovery.js';
import {GitHubProviderError,GitHubSocialProvider,type GitHubSocialConfig,type GitHubTokens,type RepositorySnapshot} from './provider.js';
import {DESIGN_CLAIM_MARKER,issuePageMarker,PLATFORM_REPOSITORY} from '../development/page-github.js';
export type {GitHubSocialConfig} from './provider.js';

const HOUR=60*60*1000;
type MetricsRow={snapshot:RepositorySnapshot|null;checked_at:Date|null;retry_after:Date;last_error:string|null};
type Connection={user_id:string;community_id:string;github_user_id:string;github_login:string;encrypted_tokens:string};
export type GitHubSession={configured:boolean;connected:boolean;github_user:{id:string;login:string}|null};
export type GitHubMetrics={book_id:string;repository_url:string;stargazers_count:number|null;forks_count:number|null;open_issues_count:number|null;subscribers_count:number|null;pushed_at:string|null;language:string|null;archived:boolean|null;checked_at:string|null;stale:boolean;error:string|null};
const nullSnapshot={stargazers_count:null,forks_count:null,open_issues_count:null,subscribers_count:null,pushed_at:null,language:null,archived:null};
const poolState=new WeakMap<Pool,{providers:WeakMap<typeof fetch,GitHubSocialProvider>}>();
const identityTaken='這個 GitHub 帳號已連結另一個工坊帳號。請先從原本的工坊帳號解除連結，或改用其他 GitHub 帳號。';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
// Serializes every change to one member's GitHub connection (connect, reconnect,
// refresh, disconnect) with every read that authorizes from it. Lock order:
// user -> member-guild -> github-social -> grant rows. Re-entrant per transaction.
export async function lockGitHubSocialMember(q:PoolClient,userId:string){
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-social/${userId}`]);
}
function upstream(bookId:string){
  const book=communityCatalog.skill_books.find(item=>item.id===bookId);
  requireCondition(book,404,'skill_book_not_found','找不到這本技能書。');
  const url=new URL(book.upstream_url);
  requireCondition(url.protocol==='https:'&&url.hostname==='github.com'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname),422,'github_repository_unavailable','這本技能書沒有可連接的 GitHub 來源。');
  return {repository:url.pathname.replace(/^\//,'').replace(/\/$/,''),url:url.href};
}
export type CatalogMetricTarget={key:string;repository:string};
/** Catalog books whose public counts `metrics()` serves. One row per repository. */
export function catalogMetricTargets():CatalogMetricTarget[]{
  const seen=new Set<string>(),targets:CatalogMetricTarget[]=[];
  for(const book of communityCatalog.skill_books){
    let source:{repository:string};
    try{source=upstream(book.id);}catch{continue;}
    const key=source.repository.toLowerCase();
    if(seen.has(key))continue;
    seen.add(key);targets.push({key,repository:source.repository});
  }
  return targets;
}
export async function saveRepositoryMetrics(q:Pool|PoolClient,key:string,snapshot:RepositorySnapshot):Promise<MetricsRow>{
  return (await q.query<MetricsRow>(`INSERT INTO github_repository_metrics(repository_key,snapshot,checked_at,retry_after,last_error) VALUES($1,$2,now(),now()+interval '1 hour',NULL)
    ON CONFLICT(repository_key) DO UPDATE SET snapshot=$2,checked_at=now(),retry_after=now()+interval '1 hour',last_error=NULL RETURNING snapshot,checked_at,retry_after,last_error`,[key,JSON.stringify(snapshot)])).rows[0];
}
export async function failRepositoryMetrics(q:Pool|PoolClient,key:string,code:string):Promise<MetricsRow>{
  const safe=/^[a-z0-9_]{1,80}$/.test(code)?code:'github_unavailable';
  return (await q.query<MetricsRow>(`INSERT INTO github_repository_metrics(repository_key,retry_after,last_error) VALUES($1,now()+interval '1 hour',$2)
    ON CONFLICT(repository_key) DO UPDATE SET retry_after=now()+interval '1 hour',last_error=$2 RETURNING snapshot,checked_at,retry_after,last_error`,[key,safe])).rows[0];
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
  constructor(private pool:Pool,private config?:GitHubSocialConfig,fetcher:typeof fetch=fetch,_metricsToken?:string){
    if(config){
      this.key=Buffer.from(config.tokenKey,'base64');
      const redirect=new URL(config.redirectUri);
      if(this.key.length!==32||this.key.toString('base64')!==config.tokenKey||!config.clientId||!config.clientSecret||redirect.username||redirect.password||redirect.search||redirect.hash||redirect.pathname!=='/github/callback'||(redirect.protocol!=='https:'&&!(redirect.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(redirect.hostname))))throw new Error('Invalid GitHub social configuration.');
    }
    let shared=poolState.get(pool);if(!shared){shared={providers:new WeakMap()};poolState.set(pool,shared);}
    let provider=shared.providers.get(fetcher);if(!provider){provider=new GitHubSocialProvider(fetcher);shared.providers.set(fetcher,provider);}
    this.provider=provider;
  }
  private configured(){requireCondition(this.config&&this.key,503,'github_not_configured','GitHub 連線尚未設定。');return this.config;}
  private context(actor:Pick<Actor,'community_id'|'user_id'>,purpose:string){return `github-social/v1/${this.config?.clientId}/${actor.community_id}/${actor.user_id}/${purpose}`;}
  private async actorLock(q:PoolClient,actor:Actor){
    requireCondition((await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active FOR SHARE',[actor.user_id,actor.community_id])).rowCount===1,401,'session_expired','請重新登入。');
    requireCondition((await q.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[actor.session_hash,actor.user_id])).rowCount===1,401,'session_expired','請重新登入。');
    await lockGitHubSocialMember(q,actor.user_id);
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
  private async rate(q:PoolClient,actor:Pick<Actor,'community_id'|'user_id'>,operation:string,limit:number,seconds=60){
    const row=(await q.query(`INSERT INTO github_social_rate_limits(user_id,operation,window_start,attempts) VALUES($1,$2,now(),1)
      ON CONFLICT(user_id,operation) DO UPDATE SET attempts=CASE WHEN github_social_rate_limits.window_start<now()-make_interval(secs=>$3) THEN 1 ELSE github_social_rate_limits.attempts+1 END,
      window_start=CASE WHEN github_social_rate_limits.window_start<now()-make_interval(secs=>$3) THEN now() ELSE github_social_rate_limits.window_start END RETURNING attempts`,[actor.user_id,operation,seconds])).rows[0];
    requireCondition(row.attempts<=limit,429,'github_rate_limited','GitHub 操作過於頻繁，請稍後再試。');
  }
  private async connection(q:PoolClient,actor:Pick<Actor,'community_id'|'user_id'>):Promise<Connection|null>{return (await q.query('SELECT * FROM github_social_connections WHERE user_id=$1 AND community_id=$2',[actor.user_id,actor.community_id])).rows[0]??null;}
  private view(connection:Connection|null):GitHubSession{return {configured:!!this.config,connected:!!this.config&&!!connection,github_user:this.config&&connection?{id:connection.github_user_id,login:connection.github_login}:null};}
  async session(actor:Actor):Promise<GitHubSession>{return this.member(actor,async q=>this.view(await this.connection(q,actor)));}
  developmentApp(){
    const configured=Boolean(this.config?.appId&&this.config?.appSlug);
    return {configured,installation_url:configured?`https://github.com/apps/${this.config!.appSlug}/installations/new`:null};
  }
  // Caller already holds user -> member-guild locks; never open a nested transaction.
  async developmentEvidence(q:PoolClient,actor:Actor,target:string,working:string){
    this.configured();requireCondition(this.config?.appId,503,'github_development_not_configured','GitHub App 尚未完成開發連動設定。');
    await lockGitHubSocialMember(q,actor.user_id);
    const connection=await this.connection(q,actor);requireCondition(connection,409,'github_connect_required','請先連結 GitHub。');
    return this.withToken(q,actor,connection,async token=>{
      const identity=await this.provider.identity(token);
      requireCondition(identity.id===connection.github_user_id,409,'github_reconnect_required','GitHub 身分已變更，請重新連結。');
      return {...await this.provider.developmentAccess(target,working,this.config!.appId!,token),github_user_id:identity.id};
    });
  }
  async repositoryManager(q:PoolClient,actor:Actor,repository:string,repositoryId:string):Promise<boolean>{
    // Caller holds user/session locks. Commit credential lifecycle separately,
    // including rotation on provider denial, before the project can roll back.
    const result=await transaction(this.pool,async credential=>{
      await lockGitHubSocialMember(credential,actor.user_id);
      const connection=await this.connection(credential,actor);
      if(!this.config||!connection)return {allowed:false};
      try{
        const allowed=await this.withToken(credential,actor,connection,async token=>{
          const identity=await this.provider.identity(token);
          requireCondition(identity.id===connection.github_user_id,409,'github_reconnect_required','GitHub 身分已變更，請重新連結。');
          return this.provider.repositoryManager(repository,repositoryId,token);
        });
        return {allowed,connection:await this.connection(credential,actor)};
      }catch(error){if(error instanceof Problem)return {error};throw error;}
    });
    if('error' in result)throw result.error;
    if(!result.allowed)return false;
    // Hold the lock through project/receipt commit and reject a disconnect or
    // replacement that won the gap between the two transactions.
    await lockGitHubSocialMember(q,actor.user_id);
    const connection=await this.connection(q,actor);
    return !!connection&&connection.encrypted_tokens===result.connection?.encrypted_tokens;
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
  private async access(q:PoolClient,actor:Pick<Actor,'community_id'|'user_id'>,connection:Connection):Promise<string>{
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
  private async withToken<T>(q:PoolClient,actor:Pick<Actor,'community_id'|'user_id'>,connection:Connection,run:(token:string)=>Promise<T>){
    try{return await run(await this.access(q,actor,connection));}
    catch(error){if(error instanceof Problem&&error.code==='github_reconnect_required')await q.query('DELETE FROM github_social_connections WHERE user_id=$1',[actor.user_id]);throw error;}
  }
  /** No business transaction is held while loading/refreshing provider credentials. */
  async prepareBookStars(actor:Pick<Actor,'community_id'|'user_id'>,bookIds:string[]):Promise<(q:PoolClient,books:string[])=>Promise<void>>{
    this.configured();
    const books=new Set(bookIds);
    const starRevision=async(q:PoolClient)=>JSON.stringify((await q.query("SELECT window_start::text,attempts FROM github_social_rate_limits WHERE user_id=$1 AND operation='star-write'",[actor.user_id])).rows[0]??null);
    const result=await transaction(this.pool,async q=>{
      requireCondition((await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active FOR SHARE',[actor.user_id,actor.community_id])).rowCount===1,401,'session_expired','請重新登入。');
      await lockGitHubSocialMember(q,actor.user_id);
      try{
        const connection=await this.connection(q,actor);
        requireCondition(connection,409,'github_connect_required','領取技能書或晉升前，請先連結本人的 GitHub，再為公會指定的原作 Repo 加星。');
        await this.rate(q,actor,'skill-book-star-check',30);
        await this.withToken(q,actor,connection,async token=>{
          const identity=await this.provider.identity(token);
          requireCondition(identity.id===connection.github_user_id,409,'github_reconnect_required','GitHub 身分已變更，請重新連結。');
          const repositories=new Set<string>();
          for(const bookId of books){
            const book=upstream(bookId);
            if(repositories.has(book.repository.toLowerCase()))continue;
            repositories.add(book.repository.toLowerCase());
            await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-star/${connection.github_user_id}/${book.repository.toLowerCase()}`]);
            const starred=await this.provider.starred(book.repository,token);
            requireCondition(starred,409,'skill_book_star_required',`領取技能書或晉升前，請先為 ${book.repository} 加星。可在公會技能書的 Star 按鈕一鍵加星，再重試；不會自動替你加星。`);
          }
        });
        return {connection:await this.connection(q,actor),revision:await starRevision(q)};
      }catch(error){
        // Rejected checks still consume attempts. Provider-side token rotation
        // or invalid-token deletion cannot be undone with a later guild rollback.
        if(error instanceof Problem)return {error};
        throw error;
      }
    });
    if('error' in result)throw result.error;
    return async(q,currentBooks)=>{
      await lockGitHubSocialMember(q,actor.user_id);
      const current=await this.connection(q,actor);
      requireCondition(current&&current.github_user_id===result.connection?.github_user_id
        &&current.encrypted_tokens===result.connection?.encrypted_tokens
        &&await starRevision(q)===result.revision&&currentBooks.every(book=>books.has(book)),
        409,'skill_book_star_check_changed','公會技能書或 GitHub 連線已變更，請重試。');
    };
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
  async following(actor:Actor,username:string){
    z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/).parse(username);
    return this.member(actor,async q=>{
      const connection=await this.connection(q,actor);
      if(!this.config||!connection)return {username,connected:false,following:null};
      await this.rate(q,actor,'follow-read',90);
      const following=await this.withToken(q,actor,connection,async token=>{await assertCurrentSessionClock(q,actor);return this.provider.following(username,token,()=>assertCurrentSessionClock(q,actor));});
      await assertCurrentSessionClock(q,actor);
      return {username,connected:true,following};
    });
  }
  async follow(actor:Actor,username:string,desired:boolean){
    z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/).parse(username);z.boolean().parse(desired);this.configured();
    return this.member(actor,async q=>{
      await this.rate(q,actor,'follow-write',30);
      const connection=await this.connection(q,actor);requireCondition(connection,409,'github_connect_required','請先連接自己的 GitHub 帳號。');
      await this.withToken(q,actor,connection,async token=>{
        // Refresh the decision clock after connection-lock/token-refresh waits.
        await assertCurrentSessionClock(q,actor);
        await this.provider.follow(username,token,desired,()=>assertCurrentSessionClock(q,actor));
      });
      return {username,connected:true,following:desired,confirmed:true};
    });
  }
  async createPageIssue(actor:Actor,pageId:string,title:string,description:string,operationKey:string){
    const marker=issuePageMarker(pageId),cleanTitle=title.trim(),cleanDescription=description.trim();
    requireCondition(cleanTitle.length>=3&&cleanTitle.length<=120&&cleanDescription.length>=10&&cleanDescription.length<=2000,422,'github_issue_invalid','請填寫 3–120 字標題及 10–2000 字的想法。');
    requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(operationKey),400,'idempotency_key_invalid','請重新載入頁面再試。');
    this.configured();
    const requestHash=hash(JSON.stringify([pageId,cleanTitle,cleanDescription]));
    const issueBody=`${cleanDescription}\n\n頁面標記：page:${pageId}\n\n${marker}`;
    return this.member(actor,async q=>{
      const prior=(await q.query('SELECT * FROM github_page_issue_submissions WHERE user_id=$1 AND (operation_key=$2 OR (request_hash=$3 AND created_at>now()-interval \'24 hours\' AND state<>\'denied\')) ORDER BY created_at DESC LIMIT 1',[actor.user_id,operationKey,requestHash])).rows[0];
      if(prior){
        requireCondition(prior.request_hash===requestHash,409,'github_issue_key_reused','這次操作已用於不同內容，請重新填寫。');
        requireCondition(prior.state==='confirmed',409,'github_issue_unconfirmed','GitHub 發布結果尚未確認。請先到 GitHub 查詢，避免重複提出。');
        return {confirmed:true,issue_number:prior.issue_number,issue_url:`${PLATFORM_REPOSITORY}/issues/${prior.issue_number}`};
      }
      await this.rate(q,actor,'page-issue-write',5,600);
      const connection=await this.connection(q,actor);
      requireCondition(connection,409,'github_connect_required','請先連結自己的 GitHub 帳號。');
      await q.query('INSERT INTO github_page_issue_submissions(user_id,operation_key,request_hash,page_id,issue_title,state) VALUES($1,$2,$3,$4,$5,\'pending\')',[actor.user_id,operationKey,requestHash,pageId,cleanTitle]);
      try{
        const result=await this.withToken(q,actor,connection,async token=>{
          const identity=await this.provider.identity(token);
          requireCondition(identity.id===connection.github_user_id,409,'github_reconnect_required','GitHub 身分已變更，請重新連結。');
          return this.provider.createPlatformIssue(token,cleanTitle,issueBody,`page:${pageId}`,this.config?.appId);
        });
        requireCondition(result.authorId===connection.github_user_id,502,'github_issue_unconfirmed','GitHub 發布結果尚未確認，請到 GitHub 核對。');
        await q.query('UPDATE github_page_issue_submissions SET state=\'confirmed\',issue_number=$3,updated_at=now() WHERE user_id=$1 AND operation_key=$2',[actor.user_id,operationKey,result.number]);
        return {confirmed:true,issue_number:result.number,issue_url:`${PLATFORM_REPOSITORY}/issues/${result.number}`};
      }catch(error){
        if(error instanceof Problem&&['github_permission_required','github_installation_required','github_repository_unavailable','github_reconnect_required'].includes(error.code))await q.query('UPDATE github_page_issue_submissions SET state=\'denied\',updated_at=now() WHERE user_id=$1 AND operation_key=$2',[actor.user_id,operationKey]);
        throw error;
      }
    });
  }
  async pageIssueSubmissions(actor:Actor,pageId:string){
    issuePageMarker(pageId);
    return this.member(actor,async q=>{
      const rows=(await q.query('SELECT operation_key,state,issue_number,issue_title,created_at FROM github_page_issue_submissions WHERE user_id=$1 AND page_id=$2 ORDER BY created_at DESC LIMIT 20',[actor.user_id,pageId])).rows;
      // Older confirmed submissions predate the title column. Resolve a few per
      // read from GitHub so they regain their real titles without a data guess.
      const missing=rows.filter(row=>row.state==='confirmed'&&row.issue_number&&!row.issue_title).slice(0,5);
      if(missing.length&&this.config){
        const connection=await this.connection(q,actor);
        if(connection){
          try{
            const token=await this.access(q,actor,connection);
            for(const row of missing){
              try{
                const issue=await this.provider.platformIssue(token,row.issue_number);
                if(issue.isPull)continue;
                row.issue_title=issue.title;
                await q.query('UPDATE github_page_issue_submissions SET issue_title=$3 WHERE user_id=$1 AND operation_key=$2',[actor.user_id,row.operation_key,issue.title]);
              }catch{/* GitHub sync is optional; retain the issue link and number. */}
            }
          }catch{/* A missing or expired GitHub connection cannot hide prior submissions. */}
        }
      }
      return {items:rows.map(row=>({operation_key:row.operation_key,state:row.state,issue_number:row.issue_number,title:row.issue_title,issue_url:row.state==='confirmed'?`${PLATFORM_REPOSITORY}/issues/${row.issue_number}`:null,created_at:row.created_at}))};
    });
  }
  async createDesignClaim(actor:Actor,pageId:string,issueNumber:number,message:string,operationKey:string){
    const marker=issuePageMarker(pageId),cleanMessage=message.trim();
    requireCondition(Number.isSafeInteger(issueNumber)&&issueNumber>0,422,'github_issue_invalid','Issue 編號無效。');
    requireCondition(cleanMessage.length>=10&&cleanMessage.length<=700&&!cleanMessage.includes(DESIGN_CLAIM_MARKER),422,'github_claim_invalid','請填寫 10–700 字的認領內容。');
    requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(operationKey),400,'idempotency_key_invalid','請重新載入頁面再試。');
    this.configured();
    const requestHash=hash(JSON.stringify([pageId,issueNumber,cleanMessage]));
    return this.member(actor,async q=>{
      const prior=(await q.query(`SELECT * FROM github_design_claim_submissions WHERE user_id=$1 AND (operation_key=$2 OR (issue_number=$3 AND state<>'denied')) ORDER BY (operation_key=$2) DESC,created_at DESC LIMIT 1`,[actor.user_id,operationKey,issueNumber])).rows[0];
      if(prior){
        requireCondition(prior.operation_key!==operationKey||prior.request_hash===requestHash,409,'github_claim_key_reused','這次操作已用於不同內容，請重新填寫。');
        requireCondition(prior.state==='confirmed',409,'github_claim_unconfirmed','GitHub 留言結果尚未確認。請先到 Issue 核對，避免重複留言。');
        return {confirmed:true,issue_number:issueNumber,comment_url:`${PLATFORM_REPOSITORY}/issues/${issueNumber}#issuecomment-${prior.comment_id}`};
      }
      await this.rate(q,actor,'design-claim-write',5,600);
      const connection=await this.connection(q,actor);
      requireCondition(connection,409,'github_connect_required','請先連結自己的 GitHub 帳號。');
      const token=await this.withToken(q,actor,connection,async token=>{
        const identity=await this.provider.identity(token);
        requireCondition(identity.id===connection.github_user_id,409,'github_reconnect_required','GitHub 身分已變更，請重新連結。');
        const issue=await this.provider.platformIssue(token,issueNumber);
        requireCondition(issue.open&&!issue.isPull&&(issue.labels.includes(`page:${pageId}`)||issue.body.includes(marker)),422,'github_claim_issue_invalid','這則 Issue 已關閉或不屬於這個頁面，請重新同步。');
        return token;
      });
      await q.query('INSERT INTO github_design_claim_submissions(user_id,operation_key,request_hash,page_id,issue_number,state) VALUES($1,$2,$3,$4,$5,\'pending\')',[actor.user_id,operationKey,requestHash,pageId,issueNumber]);
      try{
        const result=await this.provider.createPlatformIssueComment(token,issueNumber,`${cleanMessage}\n\n${DESIGN_CLAIM_MARKER}`);
        requireCondition(result.authorId===connection.github_user_id,502,'github_claim_unconfirmed','GitHub 留言結果尚未確認，請到 Issue 核對。');
        await q.query('UPDATE github_design_claim_submissions SET state=\'confirmed\',comment_id=$3,updated_at=now() WHERE user_id=$1 AND operation_key=$2',[actor.user_id,operationKey,result.id]);
        return {confirmed:true,issue_number:issueNumber,comment_url:result.url};
      }catch(error){
        if(error instanceof Problem&&['github_permission_required','github_installation_required','github_repository_unavailable','github_reconnect_required'].includes(error.code))await q.query('UPDATE github_design_claim_submissions SET state=\'denied\',updated_at=now() WHERE user_id=$1 AND operation_key=$2',[actor.user_id,operationKey]);
        throw error;
      }
    });
  }
  async designClaimSubmissions(actor:Actor,pageId:string){
    issuePageMarker(pageId);
    return this.member(actor,async q=>{
      const rows=(await q.query(`SELECT operation_key,state,issue_number,comment_id,created_at FROM github_design_claim_submissions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,[actor.user_id])).rows;
      return {items:rows.map(row=>({operation_key:row.operation_key,state:row.state,issue_number:row.issue_number,comment_url:row.state==='confirmed'?`${PLATFORM_REPOSITORY}/issues/${row.issue_number}#issuecomment-${row.comment_id}`:null,created_at:row.created_at}))};
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
  async metrics(bookId:string):Promise<GitHubMetrics>{return this.cachedMetrics(bookId);}
  async cachedMetrics(bookId:string):Promise<GitHubMetrics>{
    const book=upstream(bookId),row=(await this.pool.query<MetricsRow>('SELECT snapshot,checked_at,retry_after,last_error FROM github_repository_metrics WHERE repository_key=$1',[book.repository.toLowerCase()])).rows[0];
    return this.metricsView(bookId,book.url,row??{snapshot:null,checked_at:null,retry_after:new Date(),last_error:null});
  }
  private metricsView(bookId:string,repositoryUrl:string,row:MetricsRow):GitHubMetrics{
    const checked=row.checked_at?new Date(row.checked_at):null;
    return {book_id:bookId,repository_url:repositoryUrl,...(row.snapshot??nullSnapshot),checked_at:checked?.toISOString()??null,stale:!checked||Date.now()-checked.getTime()>=HOUR||!!row.last_error,error:row.last_error};
  }
  private saveMetrics(q:PoolClient,key:string,snapshot:RepositorySnapshot){return saveRepositoryMetrics(q,key,snapshot);}
  private failMetrics(q:PoolClient,key:string,code:string){return failRepositoryMetrics(q,key,code);}
}
