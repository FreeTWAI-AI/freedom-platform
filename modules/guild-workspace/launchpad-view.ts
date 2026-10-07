import type {Pool, PoolClient} from 'pg';
import {transaction} from '../../packages/db/index.js';
import {assertCurrentSessionClock} from '../../packages/db/member-session.js';
import {requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {communityCatalog, skillBooksForGuild, type SkillBook} from '../community/catalog.js';
import {ConfigValidationError, assertStoredVersion, publicSafeConfig, type ConfigView} from '../../contracts/guild-launchpad/v1/config.js';
import {applicationsForGuild, availableReleaseRefs} from '../module-registry/catalog.js';
import {
  activeMember, assertDelegatedViewerDeadline, listDelegationCandidates, listDelegations, listRevisionMeta, loadCatalog, platformDefaultView,
  readPointerVersion, readSolePublicRevision, readStoredRevision, refreshDelegateAccess, requireGuildMember, resolvePublishedView,
  tryView, viewerAccess, type CatalogGuild, type ConfigProblem,
} from './launchpad-config.js';

type BookRef = {book_id: string; title: string; introduction_url: string | null; upstream_url: string};
type AnnouncementRef = {announcement_id: string; title: string; body: string; published_at: string | null};

function bookRef(book: SkillBook): BookRef {
  return {book_id: book.id, title: book.title, introduction_url: book.introduction_url ?? null, upstream_url: book.upstream_url};
}
function catalogBook(id: string): SkillBook | undefined {
  return communityCatalog.skill_books.find(book => book.id === id);
}
async function bookRefs(q: PoolClient, guildKey: string, communityId: string | null): Promise<BookRef[]> {
  const seen = new Set<string>();
  const refs: BookRef[] = [];
  const add = (book: SkillBook | undefined) => {
    if (!book || seen.has(book.id)) return;
    seen.add(book.id);
    refs.push(bookRef(book));
  };
  for (const book of skillBooksForGuild(guildKey)) add(book);
  if (!communityId) {
    const bound = (await q.query('SELECT community_id, book_id FROM guild_skill_book_bindings WHERE guild_key=$1', [guildKey])).rows;
    const communities = new Set(bound.map(row => row.community_id as string));
    if (communities.size === 1) for (const row of bound) add(catalogBook(row.book_id));
    return refs;
  }
  const bound = (await q.query('SELECT book_id FROM guild_skill_book_bindings WHERE community_id=$1 AND guild_key=$2 ORDER BY book_id', [communityId, guildKey])).rows;
  for (const row of bound) add(catalogBook(row.book_id));
  return refs;
}
async function announcements(q: PoolClient, communityId: string, guildKey: string): Promise<AnnouncementRef[]> {
  const rows = (await q.query(`SELECT announcement_id, title, body, updated_at FROM guild_announcements
    WHERE community_id=$1 AND guild_key=$2 AND state='published'
    ORDER BY updated_at DESC, announcement_id LIMIT 50`, [communityId, guildKey])).rows;
  return rows.map(row => ({announcement_id: row.announcement_id as string, title: row.title as string, body: row.body as string, published_at: new Date(row.updated_at).toISOString()}));
}
function memberGuildDto(guild: CatalogGuild) {
  return {guild_key: guild.guild_key, name: guild.name, purpose: guild.purpose};
}
function publicGuildDto(guild: CatalogGuild) {
  return {...memberGuildDto(guild), category: null as null};
}

export async function publicLaunchpad(pool: Pool, guildKey: string) {
  return transaction(pool, async q => {
    const guild = await loadCatalog(q, guildKey);
    const stored = await readSolePublicRevision(q, guildKey);
    const resolved = stored
      ? await resolvePublishedView(q, guild, stored.community_id, '1')
      : {view: platformDefaultView(guild, '1'), problem: null as ConfigProblem};
    const view = resolved.view;
    const communityId = stored && view.source === 'guild_editor' ? stored.community_id : null;
    const allowed = await availableReleaseRefs(q, guildKey);
    return {
      guild: publicGuildDto(guild),
      config: {revision: view.revision, body: publicSafeConfig(view.body, allowed)},
      config_problem: resolved.problem,
      announcements: [] as AnnouncementRef[],
      skill_books: await bookRefs(q, guildKey, communityId),
      public_results: [] as {result_id: string; title: string; public_url: string}[],
    };
  });
}

export async function memberLaunchpad(pool: Pool, actor: Actor, guildKey: string) {
  return transaction(pool, async q => {
    await activeMember(q, actor);
    const guild = await loadCatalog(q, guildKey);
    await requireGuildMember(q, actor, guildKey);
    const membership = (await q.query("SELECT state, member_tier FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active'", [actor.community_id, actor.user_id, guildKey])).rows[0];
    requireCondition(membership, 403, 'guild_member_required', '加入公會後可閱讀公告。');
    const access = await viewerAccess(q, actor, guildKey);
    const pointerVersion = await readPointerVersion(q, actor.community_id, guildKey);
    const resolved = await resolvePublishedView(q, guild, actor.community_id, pointerVersion);
    const announcementRows = await announcements(q, actor.community_id, guildKey);
    const books = await bookRefs(q, guildKey, actor.community_id);
    const applications = await applicationsForGuild(q, actor, guildKey);
    const fresh = await refreshDelegateAccess(q, actor, guildKey, access);
    await assertCurrentSessionClock(q, actor);
    return {
      guild: memberGuildDto(guild),
      config: resolved.view,
      config_problem: resolved.problem,
      membership: {state: membership.state as string, member_tier: membership.member_tier as string},
      announcements: announcementRows,
      skill_books: books,
      applications,
      community_tasks: [] as {work_item_id: string; title: string; state: string}[],
      viewer_can_edit_config: fresh.edit,
      viewer_can_preview_config: fresh.preview,
      viewer_can_publish_config: fresh.publish,
      viewer_can_manage_delegations: fresh.leader,
    };
  });
}

export async function leaderLaunchpadConfig(pool: Pool, actor: Actor, guildKey: string, revision: string | undefined) {
  if (revision !== undefined) assertStoredVersion(revision, 'revision');
  return transaction(pool, async q => {
    await activeMember(q, actor);
    const guild = await loadCatalog(q, guildKey);
    const access = await viewerAccess(q, actor, guildKey);
    requireCondition(access.edit || access.preview || access.publish, 403, 'guild_leader_required', '此操作限目前在任的公會長。');
    const pointerVersion = await readPointerVersion(q, actor.community_id, guildKey);
    let config: ConfigView;
    let problem: ConfigProblem = null;
    if (revision) {
      const row = await readStoredRevision(q, actor.community_id, guildKey, revision);
      requireCondition(row, 404, 'config_revision_not_found', '找不到這個啟動台版本。');
      const parsed = tryView(row, guildKey, pointerVersion);
      if (!parsed) throw new ConfigValidationError([{code: 'schema_version_invalid', path: 'body'}]);
      config = parsed;
    } else {
      const draft = tryView(await readStoredRevision(q, actor.community_id, guildKey), guildKey, pointerVersion);
      if (draft) config = draft;
      else {
        const resolved = await resolvePublishedView(q, guild, actor.community_id, pointerVersion);
        config = resolved.view;
        problem = resolved.problem;
      }
    }
    const leader = access.leader;
    const revisions = await listRevisionMeta(q, actor.community_id, guildKey);
    const delegations = leader ? await listDelegations(q, actor.community_id, guildKey) : undefined;
    const delegationCandidates = leader ? await listDelegationCandidates(q, actor.community_id, guildKey) : undefined;
    await assertCurrentSessionClock(q, actor);
    await assertDelegatedViewerDeadline(q, actor, guildKey, access);
    return {
      ...config,
      config_problem: problem,
      viewer_can_edit_config: access.edit,
      viewer_can_preview_config: access.preview,
      viewer_can_publish_config: access.publish,
      viewer_can_manage_delegations: leader,
      revisions,
      ...(leader ? {delegations, delegation_candidates: delegationCandidates} : {}),
    };
  });
}
