import type {PoolClient} from 'pg';
import {requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {lockMemberGuilds} from '../positioning/onboarding.js';

/** Guilds whose current active membership is a prerequisite for development work. */
export const developmentGuilds={skill:['guild_ai_vibe','guild_ai_field'],platform:['guild_platform_engineering']};
export type Capability=keyof typeof developmentGuilds;

/**
 * Current active eligible guild keys. Takes the same advisory lock as guild
 * join/leave first, so a caller in a transaction either sees a committed leave
 * or holds the lock until its own commit. Callers must already hold the
 * users/sessions row locks (same order as `command`).
 */
export async function activeDevelopmentGuilds(q:PoolClient,actor:Pick<Actor,'community_id'|'user_id'>,capability:Capability){
 await lockMemberGuilds(q,actor);
 return (await q.query(`SELECT guild_key FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND state='active' AND guild_key=ANY($3::text[]) ORDER BY guild_key FOR SHARE`,[actor.community_id,actor.user_id,developmentGuilds[capability]])).rows.map(row=>row.guild_key as string);
}
/** Skill editing needs the named book appointment AND a current AI guild membership (from `activeDevelopmentGuilds`). */
export function requireSkillEditorGuild(guilds:string[]){
 requireCondition(guilds.length>0,403,'skill_editor_guild_required','技能書編輯需要目前加入「AI 開發公會」或「AI 導入與驗證公會」其中之一。');
}
