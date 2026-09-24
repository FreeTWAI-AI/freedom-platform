import {randomBytes,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {transaction,digest,journal,type Command} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import {tokenHash,type Actor} from '../identity-membership/service.js';
import {lockMemberGuilds} from '../positioning/onboarding.js';
import {communityCatalog} from '../community/catalog.js';
import {developmentPages} from '../development/pages.js';
import {githubCoordinate} from '../opensource-marketing/github.js';
import type {GitHubSocial} from '../github-social/service.js';

export const DEVELOPMENT_POLICY='development-proposal-v1';
export const developmentGuilds={skill:['guild_ai_vibe','guild_ai_field'],platform:['guild_platform_engineering']};
export type Capability=keyof typeof developmentGuilds;
const kind=z.enum(['skill','platform']);
const empty=z.object({}).strict();
const proposalInput=z.object({title:z.string().trim().min(1).max(150),summary:z.string().trim().min(1).max(8000),pr_url:z.string().max(500).nullable().default(null)}).strict();
const ready='active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)';
const grantColumns='grant_id,capability,target_key,target_repository,working_repository,guild_sources,policy_version,checked_at,expires_at,revoked_at,revoke_reason';
function targetFor(capability:Capability,targetKey:string){
  if(capability==='skill'){
    const book=communityCatalog.skill_books.find(value=>value.id===targetKey);
    requireCondition(book,404,'development_target_not_found','找不到這本技能書。');
    return {key:targetKey,title:book.title,repository:githubCoordinate(book.upstream_url),guide_url:`/development/skills/${book.id}/SKILL.md`};
  }
  const page=developmentPages.find(value=>value.id===targetKey);
  requireCondition(page,404,'development_target_not_found','找不到這一頁的開發指引。');
  return {key:targetKey,title:page.title,repository:'FreeTWAI-AI/freedom-platform',guide_url:`/development/${page.id}/SKILL.md`};
}
export class DevelopmentAccess {
  constructor(private pool:Pool,private social:GitHubSocial){}
  private async member<T>(actor:Actor,run:(q:PoolClient)=>Promise<T>,browser=true):Promise<T>{
    const result=await transaction(this.pool,async q=>{
      requireCondition((await q.query(`SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND ${ready} FOR SHARE`,[actor.user_id,actor.community_id])).rowCount===1,403,'development_member_required','請先完成會員定位。');
      if(browser)requireCondition((await q.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[actor.session_hash,actor.user_id])).rowCount===1,401,'session_expired','請重新登入。');
      await lockMemberGuilds(q,actor);
      // Persist definitive revocations even when an operation is refused.
      try{return {value:await run(q)};}catch(error){if(error instanceof Problem)return {error};throw error;}
    });
    if('error' in result)throw result.error;return result.value;
  }
  private async sources(q:PoolClient,actor:Actor,capability:Capability){
    return (await q.query(`SELECT guild_key FROM positioning_profession_memberships WHERE user_id=$1 AND community_id=$2 AND state='active' AND guild_key=ANY($3::text[]) ORDER BY guild_key`,[actor.user_id,actor.community_id,developmentGuilds[capability]])).rows.map(row=>row.guild_key as string);
  }
  private async prerequisites(q:PoolClient,actor:Actor,capability:Capability){
    const sources=await this.sources(q,actor,capability);
    requireCondition(sources.length,403,'development_guild_required','請先加入適用的開發公會。');
    requireCondition((await q.query('SELECT 1 FROM development_consents WHERE user_id=$1 AND community_id=$2 AND capability=$3 AND policy_version=$4 AND withdrawn_at IS NULL',[actor.user_id,actor.community_id,capability,DEVELOPMENT_POLICY])).rowCount,403,'development_consent_required','請確認本次開發協作規則。');
    return sources;
  }
  private async receipt<T>(q:PoolClient,input:Command,run:()=>Promise<T>):Promise<T>{
    requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(input.key),400,'idempotency_required','請提供 Idempotency-Key。');
    const hash=digest(input.body),prior=(await q.query('SELECT * FROM command_receipts WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3',[input.actor.user_id,input.operation,input.key])).rows[0];
    if(prior){
      requireCondition(prior.request_sha256===hash,409,'idempotency_conflict','同一操作識別碼不可搭配不同內容。');
      if(prior.response.grant_id)requireCondition((await q.query('SELECT 1 FROM development_grants WHERE grant_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',[prior.response.grant_id,input.actor.user_id])).rowCount,403,'development_grant_required','舊授權已撤銷，請重新啟用。');
      return prior.response;
    }
    const value=await run();
    await q.query('INSERT INTO command_receipts(user_id,operation,idempotency_key,request_sha256,response) VALUES($1,$2,$3,$4,$5)',[input.actor.user_id,input.operation,input.key,hash,JSON.stringify(value)]);
    return value;
  }
  async status(actor:Actor,rawKind:string,targetKey:string){
    const capability=kind.parse(rawKind),target=targetFor(capability,targetKey);
    return this.member(actor,async q=>{
      const guilds=(await q.query(`SELECT g.guild_key,g.name,m.state,m.aggregate_version FROM positioning_guild_catalog g LEFT JOIN positioning_profession_memberships m ON m.guild_key=g.guild_key AND m.user_id=$1 AND m.community_id=$2 WHERE g.guild_key=ANY($3::text[]) ORDER BY g.guild_key`,[actor.user_id,actor.community_id,developmentGuilds[capability]])).rows;
      const connection=(await q.query('SELECT github_user_id,github_login FROM github_social_connections WHERE user_id=$1 AND community_id=$2',[actor.user_id,actor.community_id])).rows[0];
      const consent=(await q.query('SELECT 1 FROM development_consents WHERE user_id=$1 AND community_id=$2 AND capability=$3 AND policy_version=$4 AND withdrawn_at IS NULL',[actor.user_id,actor.community_id,capability,DEVELOPMENT_POLICY])).rowCount===1;
      const grant=(await q.query(`SELECT ${grantColumns} FROM development_grants WHERE user_id=$1 AND community_id=$2 AND capability=$3 AND target_key=$4 ORDER BY created_at DESC LIMIT 1`,[actor.user_id,actor.community_id,capability,targetKey])).rows[0]??null;
      const eligible=guilds.some(guild=>guild.state==='active');
      const keys=(await q.query(`SELECT k.key_id,k.source_grant_id,k.scope,k.expires_at,k.revoked_at FROM development_keys k JOIN development_grants g ON g.grant_id=k.source_grant_id WHERE g.user_id=$1 AND g.community_id=$2 AND g.capability=$3 AND g.target_key=$4 ORDER BY k.created_at DESC LIMIT 20`,[actor.user_id,actor.community_id,capability,targetKey])).rows;
      const proposals=(await q.query('SELECT proposal_id,title,summary,pr_url,created_at FROM development_proposals WHERE user_id=$1 AND community_id=$2 AND capability=$3 AND target_key=$4 ORDER BY created_at DESC LIMIT 20',[actor.user_id,actor.community_id,capability,targetKey])).rows;
      return {capability,target,guilds,eligible,github:connection?{id:connection.github_user_id,login:connection.github_login}:null,app:this.social.developmentApp(),policy_version:DEVELOPMENT_POLICY,consent,grant,
        enabled:Boolean(this.social.developmentApp().configured&&eligible&&consent&&connection&&grant&&grant.policy_version===DEVELOPMENT_POLICY&&!grant.revoked_at&&new Date(grant.expires_at)>new Date()),keys,proposals};
    });
  }
  async consent(input:Command,rawKind:string,targetKey:string){
    const capability=kind.parse(rawKind);targetFor(capability,targetKey);
    const body=z.object({policy_version:z.literal(DEVELOPMENT_POLICY),accepted:z.boolean()}).strict().parse(input.body);
    return this.member(input.actor,q=>this.receipt(q,input,async()=>{
      await q.query(`INSERT INTO development_consents(community_id,user_id,capability,policy_version,withdrawn_at) VALUES($1,$2,$3,$4,CASE WHEN $5 THEN NULL ELSE now() END)
        ON CONFLICT(community_id,user_id,capability) DO UPDATE SET policy_version=$4,accepted_at=now(),withdrawn_at=CASE WHEN $5 THEN NULL ELSE now() END`,[input.actor.community_id,input.actor.user_id,capability,DEVELOPMENT_POLICY,body.accepted]);
      if(!body.accepted)await q.query("UPDATE development_grants SET revoked_at=now(),revoke_reason='consent_withdrawn' WHERE user_id=$1 AND community_id=$2 AND capability=$3 AND revoked_at IS NULL",[input.actor.user_id,input.actor.community_id,capability]);
      return {accepted:body.accepted};
    }));
  }
  async activate(input:Command,rawKind:string,targetKey:string){
    const capability=kind.parse(rawKind),target=targetFor(capability,targetKey);
    const body=z.object({working_repository_url:z.string().max(300)}).strict().parse(input.body),working=githubCoordinate(body.working_repository_url);
    return this.member(input.actor,async q=>{
      const sources=await this.prerequisites(q,input.actor,capability);
      const evidence=await this.social.developmentEvidence(q,input.actor,target.repository,working);
      return this.receipt(q,input,async()=>{
        await q.query("UPDATE development_grants SET revoked_at=now(),revoke_reason='grant_replaced' WHERE user_id=$1 AND community_id=$2 AND capability=$3 AND target_key=$4 AND revoked_at IS NULL",[input.actor.user_id,input.actor.community_id,capability,targetKey]);
        const id=randomUUID();
        await q.query(`INSERT INTO development_grants(grant_id,community_id,user_id,capability,target_key,target_repository,target_repository_id,working_repository,working_repository_id,github_user_id,installation_id,app_id,guild_sources,policy_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,input.actor.community_id,input.actor.user_id,capability,targetKey,target.repository,evidence.target_repository_id,working,evidence.working_repository_id,evidence.github_user_id,evidence.installation_id,evidence.app_id,sources,DEVELOPMENT_POLICY]);
        await journal(q,input.actor,'development_grant',id,1,'activate',{capability,target_key:targetKey,policy_version:DEVELOPMENT_POLICY});
        return {grant_id:id};
      });
    });
  }
  private async authorizeGrant(q:PoolClient,actor:Actor,capability:Capability,targetKey:string,grantId?:string){
    const target=targetFor(capability,targetKey);await this.prerequisites(q,actor,capability);
    const row=(await q.query(`SELECT * FROM development_grants WHERE user_id=$1 AND community_id=$2 AND capability=$3 AND target_key=$4 AND revoked_at IS NULL AND expires_at>now() ${grantId?'AND grant_id=$5':''}`,grantId?[actor.user_id,actor.community_id,capability,targetKey,grantId]:[actor.user_id,actor.community_id,capability,targetKey])).rows[0];
    requireCondition(row&&row.policy_version===DEVELOPMENT_POLICY&&row.target_repository===target.repository,403,'development_grant_required','開發授權已失效，請重新完成設定。');
    try{
      const evidence=await this.social.developmentEvidence(q,actor,target.repository,row.working_repository);
      for(const field of ['target_repository_id','working_repository_id','github_user_id','installation_id','app_id'] as const)requireCondition(evidence[field]===row[field],403,'development_binding_changed','GitHub 連動已變更，請重新啟用。');
      await q.query('UPDATE development_grants SET checked_at=now() WHERE grant_id=$1',[row.grant_id]);
    }catch(error){
      if(error instanceof Problem&&([403,409].includes(error.status)||error.code==='github_repository_unavailable'))await q.query('UPDATE development_grants SET revoked_at=now(),revoke_reason=$2 WHERE grant_id=$1',[row.grant_id,error.code]);
      throw error;
    }
    return row;
  }
  async issueKey(input:Command,rawKind:string,targetKey:string){
    empty.parse(input.body);const capability=kind.parse(rawKind);let secret:string|null=null;
    const result=await this.member(input.actor,async q=>{
      const grant=await this.authorizeGrant(q,input.actor,capability,targetKey);
      return this.receipt(q,input,async()=>{
        requireCondition(Number((await q.query('SELECT count(*) FROM development_keys WHERE source_grant_id=$1 AND revoked_at IS NULL AND expires_at>now()',[grant.grant_id])).rows[0].count)<5,409,'development_key_limit','請先撤銷不再使用的開發憑證。');
        secret='fpd_'+randomBytes(32).toString('base64url');
        return {...(await q.query(`INSERT INTO development_keys(key_id,source_grant_id,secret_hash,expires_at) VALUES($1,$2,$3,LEAST(now()+interval '60 minutes',$4)) RETURNING key_id,source_grant_id,scope,expires_at`,[randomUUID(),grant.grant_id,tokenHash(secret),grant.expires_at])).rows[0],working_repository:grant.working_repository,target_repository:grant.target_repository};
      });
    });
    return {...result,token:secret};
  }
  async revoke(input:Command,rawKind:string,targetKey:string){
    const capability=kind.parse(rawKind);targetFor(capability,targetKey);
    const body=z.object({key_id:z.uuid().optional()}).strict().parse(input.body);
    return this.member(input.actor,q=>this.receipt(q,input,async()=>{
      if(body.key_id)await q.query('UPDATE development_keys k SET revoked_at=COALESCE(k.revoked_at,now()) FROM development_grants g WHERE k.source_grant_id=g.grant_id AND g.user_id=$1 AND g.community_id=$2 AND g.capability=$3 AND g.target_key=$4 AND k.key_id=$5',[input.actor.user_id,input.actor.community_id,capability,targetKey,body.key_id]);
      else await q.query("UPDATE development_grants SET revoked_at=now(),revoke_reason='owner_revoked' WHERE user_id=$1 AND community_id=$2 AND capability=$3 AND target_key=$4 AND revoked_at IS NULL",[input.actor.user_id,input.actor.community_id,capability,targetKey]);
      return {revoked:true};
    }));
  }
  private async proposal(q:PoolClient,input:Command,grant:any){
    const body=proposalInput.parse(input.body);
    if(body.pr_url)requireCondition(new RegExp('^https://github\\.com/'+grant.target_repository.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/pull/[1-9][0-9]*$','i').test(body.pr_url),422,'development_pr_target','PR 連結必須指向本次原作 repo。');
    return this.receipt(q,input,async()=>{
      const row=(await q.query('INSERT INTO development_proposals(proposal_id,source_grant_id,community_id,user_id,capability,target_key,title,summary,pr_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING proposal_id,title,summary,pr_url,created_at',[randomUUID(),grant.grant_id,input.actor.community_id,input.actor.user_id,grant.capability,grant.target_key,body.title,body.summary,body.pr_url])).rows[0];
      await journal(q,input.actor,'development_proposal',row.proposal_id,1,'save_private_proposal',{source_grant_id:grant.grant_id});return row;
    });
  }
  async saveProposal(input:Command,rawKind:string,targetKey:string){
    proposalInput.parse(input.body);const capability=kind.parse(rawKind);
    return this.member(input.actor,async q=>this.proposal(q,input,await this.authorizeGrant(q,input.actor,capability,targetKey)));
  }
  async agent(authorization:string|undefined,body:unknown,key:string){
    requireCondition(authorization&&/^Bearer fpd_[A-Za-z0-9_-]{43}$/.test(authorization),401,'development_key_required','請提供有效的開發憑證。');
    proposalInput.parse(body);
    const stored=(await this.pool.query('SELECT k.key_id,g.user_id,g.community_id,g.capability,g.target_key,g.grant_id FROM development_keys k JOIN development_grants g ON g.grant_id=k.source_grant_id WHERE k.secret_hash=$1',[tokenHash(authorization.slice(7))])).rows[0];
    requireCondition(stored,401,'development_key_required','開發憑證無效。');
    const actor={user_id:stored.user_id,community_id:stored.community_id} as Actor;
    return this.member(actor,async q=>{
      requireCondition((await q.query('SELECT 1 FROM development_keys WHERE key_id=$1 AND revoked_at IS NULL AND expires_at>now()',[stored.key_id])).rowCount,403,'development_key_revoked','開發憑證已到期或撤銷。');
      const grant=await this.authorizeGrant(q,actor,stored.capability,stored.target_key,stored.grant_id);
      return this.proposal(q,{actor,operation:`agent-development/${stored.key_id}`,body,key},grant);
    },false);
  }
}
