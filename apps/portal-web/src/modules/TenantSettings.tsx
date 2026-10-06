import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { InvitationView, MemberView, TenantView, WorkspaceView } from '../../../../contracts/guild-launchpad/v1/tenant';
import { ApiError, type PortalClient } from '../api';
import type { SessionPayload } from '../types';
import { TenantSelector, roleLabel } from './TenantSelector';
import './tenant-workspaces.css';

type Page<T> = { items: T[]; next_cursor: string | null; source_version: string };
type Attempt = { key: string; path: string; body: unknown; ifMatch?: string };
type DirectoryPerson = { user_id: string; nickname: string };
const INVITE_ROLES = ['admin', 'operator', 'viewer'] as const;

function storedKey(userId: string) { return `freedom-acting-tenant:${userId}`; }
function readStored(userId: string): string | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storedKey(userId)) ?? '') as { tenant_id?: unknown };
    return typeof parsed.tenant_id === 'string' ? parsed.tenant_id : null;
  } catch { return null; }
}
function remember(userId: string, tenantId: string, workspaceId: string) {
  try { sessionStorage.setItem(storedKey(userId), JSON.stringify({ tenant_id: tenantId, workspace_id: workspaceId })); } catch { /* The screen still shows the current choice. */ }
}
function allows(tenant: TenantView, key: string) {
  return tenant.capabilities.some(grant => grant.instance_id === null && grant.keys.includes(key));
}
function sameGeneration(ticket: number, generation: { current: number }, signal: AbortSignal) {
  return generation.current === ticket && !signal.aborted;
}

export function TenantSettings({ client, session, enabled }: { client: PortalClient; session: SessionPayload; enabled: boolean | null }) {
  const userId = session.user.user_id;
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [tenants, setTenants] = useState<TenantView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tenant, setTenant] = useState<TenantView | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [members, setMembers] = useState<MemberView[]>([]);
  const [membersComplete, setMembersComplete] = useState(true);
  const [invitations, setInvitations] = useState<InvitationView[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [alertText, setAlertText] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null);
  const [createName, setCreateName] = useState('');
  const [createWorkspace, setCreateWorkspace] = useState('');
  const [editName, setEditName] = useState('');
  const [newWorkspace, setNewWorkspace] = useState('');
  const [slug, setSlug] = useState('');
  const [search, setSearch] = useState('');
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [inviteRole, setInviteRole] = useState<(typeof INVITE_ROLES)[number]>('viewer');

  function begin() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const ticket = ++generation.current;
    return { signal: controller.signal, live: () => sameGeneration(ticket, generation, controller.signal) };
  }

  async function loadMine(prefer?: string) {
    const { signal, live } = begin();
    setLoading(true); setTenant(null); setMembers([]); setWorkspaceName(''); setPending(null);
    try {
      const [page, inbox] = await Promise.all([
        client.get<Page<TenantView>>('/tenants?limit=100', { signal }),
        client.get<Page<InvitationView>>('/me/tenant-invitations?limit=100', { signal }),
      ]);
      if (!live()) return;
      setTenants(page.items); setInvitations(inbox.items);
      const stored = prefer ?? readStored(userId);
      const next = page.items.find(item => item.tenant_id === stored)?.tenant_id ?? page.items[0]?.tenant_id ?? null;
      setSelectedId(next);
      if (next) await loadTenant(next, signal, live);
    } catch (error) {
      if (!live()) return;
      setAlertText(error instanceof ApiError ? error.message : '需要處理');
    } finally { if (live()) setLoading(false); }
  }

  async function loadTenant(tenantId: string, signal: AbortSignal, live: () => boolean) {
    const [view, spaces, peoplePage] = await Promise.all([
      client.get<TenantView>(`/tenants/${tenantId}`, { signal }),
      client.get<Page<WorkspaceView>>(`/tenants/${tenantId}/workspaces?limit=100`, { signal }),
      client.get<Page<MemberView>>(`/tenants/${tenantId}/members?limit=100`, { signal }),
    ]);
    if (!live()) return;
    const space = spaces.items.find(item => item.workspace_id === view.default_workspace_id) ?? spaces.items[0];
    setTenant(view); setMembers(peoplePage.items); setMembersComplete(peoplePage.next_cursor === null);
    setWorkspaceName(space?.name ?? ''); setEditName(view.display_name); setSlug(view.public_slug ?? '');
    setSelectedId(view.tenant_id);
    if (space) remember(userId, view.tenant_id, space.workspace_id);
  }

  useEffect(() => {
    if (enabled !== true) return;
    void loadMine();
    return () => abortRef.current?.abort();
    // The acting tenant is re-read when the signed-in member changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId]);

  function selectTenant(tenantId: string) {
    if (tenantId === selectedId && tenant) return;
    setNotice(''); setAlertText(''); setPending(null); setPeople([]);
    const { signal, live } = begin();
    setSelectedId(tenantId); setTenant(null); setMembers([]); setWorkspaceName(''); setLoading(true);
    void loadTenant(tenantId, signal, live).catch(error => { if (live()) setAlertText(error instanceof ApiError ? error.message : '需要處理'); }).finally(() => { if (live()) setLoading(false); });
  }

  async function run<T>(attempt: Attempt): Promise<T | null> {
    setAlertText(''); setNotice('');
    try {
      const value = await client.post<T>(attempt.path, attempt.body, { idempotencyKey: attempt.key, ifMatch: attempt.ifMatch, signal: abortRef.current?.signal });
      setPending(null);
      return value;
    } catch (error) {
      if (abortRef.current?.signal.aborted) return null;
      if (error instanceof ApiError && error.status === 412) {
        setPending(null); setAlertText('資料已更新。請重新載入後比對再操作。'); return null;
      }
      if (error instanceof ApiError && error.status === 401) return null;
      if (error instanceof ApiError && (error.network || (error.status ?? 0) >= 500)) {
        setPending(attempt); setAlertText('正在確認是否已儲存'); return null;
      }
      setPending(null); setAlertText(error instanceof ApiError ? error.message : '需要處理'); return null;
    }
  }

  async function confirmAgain() {
    const attempt = pending;
    if (!attempt) return;
    const value = await run<{ tenant?: TenantView }>(attempt);
    if (!value) return;
    await loadMine(attempt.path === '/tenants' ? value.tenant?.tenant_id : selectedId ?? undefined);
  }

  async function createTenant(event: FormEvent) {
    event.preventDefault();
    const body: { display_name: string; workspace_name?: string } = { display_name: createName.trim() };
    if (createWorkspace.trim()) body.workspace_name = createWorkspace.trim();
    const created = await run<{ tenant: TenantView; workspace: WorkspaceView }>(pending?.path === '/tenants' ? pending : { key: crypto.randomUUID(), path: '/tenants', body });
    if (!created) return;
    setCreateName(''); setCreateWorkspace(''); setNotice(`已建立${created.tenant.display_name}。`);
    await loadMine(created.tenant.tenant_id);
  }

  async function saveTenant(event: FormEvent) {
    event.preventDefault();
    if (!tenant) return;
    const saved = await run<TenantView>({ key: crypto.randomUUID(), path: `/tenants/${tenant.tenant_id}/edit`, ifMatch: tenant.version, body: { display_name: editName.trim(), public_slug: slug.trim() || null } });
    if (!saved) return;
    setNotice('已儲存業務空間資料。'); await loadMine(saved.tenant_id);
  }

  async function addWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!tenant) return;
    const name = newWorkspace.trim();
    const saved = await run<WorkspaceView>({ key: crypto.randomUUID(), path: `/tenants/${tenant.tenant_id}/workspaces`, body: { name } });
    if (!saved) return;
    setNewWorkspace(''); setNotice(`已建立工作區${saved.name}。`); await loadMine(tenant.tenant_id);
  }

  async function findPeople(event: FormEvent) {
    event.preventDefault();
    const term = search.trim();
    if (!term) return;
    setPeople([]); setAlertText('');
    try {
      const data = await client.get<{ items: DirectoryPerson[] }>(`/members?limit=20&sort=nickname&search=${encodeURIComponent(term)}`, { signal: abortRef.current?.signal });
      setPeople(data.items.filter(person => person.user_id !== userId).map(person => ({ user_id: person.user_id, nickname: person.nickname })));
    } catch (error) {
      if (abortRef.current?.signal.aborted) return;
      setAlertText(error instanceof ApiError ? error.message : '需要處理');
    }
  }

  async function invite(person: DirectoryPerson) {
    if (!tenant) return;
    const candidate = await client.get<{ principal_id: string; display_name: string }>(`/tenants/invite-candidates?user_id=${encodeURIComponent(person.user_id)}`, { signal: abortRef.current?.signal });
    const expires = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const saved = await run<InvitationView>({
      key: crypto.randomUUID(), path: `/tenants/${tenant.tenant_id}/invitations`,
      body: { invitee_principal_id: candidate.principal_id, role: inviteRole, instance_capabilities: [], expires_at: expires },
    });
    if (!saved) return;
    setNotice(`已邀請${candidate.display_name}。`); setPeople([]);
  }

  async function respond(invitation: InvitationView, action: 'accept' | 'decline') {
    const path = `/tenants/${invitation.tenant_id}/invitations/${invitation.invitation_id}/${action}`;
    const saved = await run<unknown>(action === 'accept'
      ? { key: crypto.randomUUID(), path, ifMatch: invitation.version, body: {} }
      : { key: crypto.randomUUID(), path, body: {} });
    if (!saved) return;
    setNotice(action === 'accept' ? `已加入${invitation.tenant_display_name}。` : `已婉拒${invitation.tenant_display_name}。`);
    await loadMine(action === 'accept' ? invitation.tenant_id : selectedId ?? undefined);
  }

  async function changeMember(member: MemberView, status: 'active' | 'revoked') {
    if (!tenant) return;
    const saved = await run<MemberView>({
      key: crypto.randomUUID(), path: `/tenants/${tenant.tenant_id}/members/${member.principal_id}/change`, ifMatch: member.version,
      body: { role: member.role === 'owner' ? 'viewer' : member.role, status, instance_capabilities: [], reason: status === 'revoked' ? '撤銷成員資格' : '調整成員角色' },
    });
    if (!saved) return;
    setNotice(status === 'revoked' ? `已撤銷${member.display_name}。` : `已更新${member.display_name}的角色。`);
    await loadMine(tenant.tenant_id);
  }

  async function updateRole(member: MemberView, role: 'admin' | 'operator' | 'viewer') {
    await changeMember({ ...member, role }, member.status);
  }

  async function leave() {
    if (!tenant) return;
    const saved = await run<{ status: 'revoked'; version: string }>({ key: crypto.randomUUID(), path: `/tenants/${tenant.tenant_id}/leave`, ifMatch: tenant.my_membership.version, body: {} });
    if (!saved) return;
    setNotice('已離開這個業務空間。'); await loadMine();
  }

  if (enabled === null) return <p role="status">正在讀取這個頁面。</p>;
  if (enabled === false) return <p className="banner" role="status">這個頁面目前未開放。</p>;

  const canEdit = tenant ? allows(tenant, 'tenant.metadata.edit') : false;
  const canInvite = tenant ? allows(tenant, 'tenant.member.invite') : false;
  const canManage = tenant ? allows(tenant, 'tenant.member.manage') : false;
  const canAddWorkspace = tenant ? allows(tenant, 'tenant.workspace.create') : false;
  const inviteChoices = tenant?.my_membership.role === 'owner' ? INVITE_ROLES : INVITE_ROLES.filter(role => role !== 'admin');
  const activeOwners = members.filter(member => member.role === 'owner' && member.status === 'active').length;
  const lastOwner = tenant?.my_membership.role === 'owner' && membersComplete && activeOwners <= 1;

  return <div className="module-panel stack tenant-workspace">
    <p role="status" aria-live="polite">{loading ? '結果確認中' : notice}</p>
    {alertText && <p className="banner" role="alert">{alertText}</p>}
    {pending && <button type="button" className="btn btn-ghost" onClick={() => void confirmAgain()}>再確認一次</button>}
    {alertText.includes('請重新載入') && <button type="button" className="btn btn-ghost" onClick={() => void loadMine(selectedId ?? undefined)}>重新載入</button>}

    <form className="stack tenant-create" onSubmit={event => void createTenant(event)}>
      <h2>建立業務空間</h2>
      <label className="field">業務空間名稱<input value={createName} maxLength={120} required onChange={event => setCreateName(event.target.value)}/></label>
      <label className="field">工作區名稱（可略過）<input value={createWorkspace} maxLength={120} onChange={event => setCreateWorkspace(event.target.value)}/></label>
      <button className="btn btn-primary" type="submit">建立業務空間</button>
    </form>

    <TenantSelector tenants={tenants} selectedId={selectedId} onSelect={selectTenant}/>

    {tenant && <section className="stack" aria-label="目前業務空間">
      <p><strong>{tenant.display_name}／{workspaceName || '工作區讀取中'}</strong></p>
      <p>我的角色：{roleLabel(tenant.my_membership.role)}</p>
      {canEdit && <form className="stack" onSubmit={event => void saveTenant(event)}>
        <label className="field">顯示名稱<input value={editName} maxLength={120} required onChange={event => setEditName(event.target.value)}/></label>
        <label className="field">網址代號（可留空）<input value={slug} maxLength={64} onChange={event => setSlug(event.target.value)} spellCheck={false}/></label>
        <button className="btn btn-ghost" type="submit">儲存</button>
      </form>}
      {canAddWorkspace && <form className="stack" onSubmit={event => void addWorkspace(event)}>
        <label className="field">新工作區名稱<input value={newWorkspace} maxLength={120} required onChange={event => setNewWorkspace(event.target.value)}/></label>
        <button className="btn btn-ghost" type="submit">建立工作區</button>
      </form>}
      <section className="stack" aria-label="成員">
        <h2>成員</h2>
        <ul className="stack">{members.map(member => <li key={member.principal_id} className="card">
          <p>{member.display_name}・{roleLabel(member.role)}・{member.status === 'active' ? '使用中' : '已撤銷'}</p>
          {canManage && member.role !== 'owner' && member.principal_id !== tenant.my_membership.principal_id && <div className="stack">
            <label className="field">角色<select value={member.role} onChange={event => void updateRole(member, event.target.value as 'admin' | 'operator' | 'viewer')}>
              {inviteChoices.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}
            </select></label>
            {member.status === 'active'
              ? <button type="button" className="btn btn-ghost" onClick={() => void changeMember(member, 'revoked')}>撤銷</button>
              : <button type="button" className="btn btn-ghost" onClick={() => void changeMember(member, 'active')}>恢復</button>}
          </div>}
        </li>)}</ul>
      </section>
      {canInvite && <form className="stack" onSubmit={event => void findPeople(event)}>
        <h2>邀請成員</h2>
        <label className="field">搜尋夥伴<input type="search" value={search} maxLength={80} onChange={event => setSearch(event.target.value)}/></label>
        <label className="field">邀請角色<select value={inviteRole} onChange={event => setInviteRole(event.target.value as (typeof INVITE_ROLES)[number])}>
          {inviteChoices.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}
        </select></label>
        <button className="btn btn-ghost" type="submit">搜尋</button>
        <ul className="stack">{people.map(person => <li key={person.user_id}>
          <button type="button" className="btn btn-ghost" onClick={() => void invite(person)}>邀請{person.nickname}為{roleLabel(inviteRole)}</button>
        </li>)}</ul>
      </form>}
      <section className="stack" aria-label="離開業務空間">
        {lastOwner
          ? <p className="field-hint">業務空間至少要有一位使用中的擁有者。請先完成所有權移交後再離開。</p>
          : <button type="button" className="btn btn-ghost" onClick={() => void leave()}>離開這個業務空間</button>}
        {lastOwner && <button type="button" className="btn btn-ghost" disabled>離開這個業務空間</button>}
      </section>
    </section>}

    <section className="stack" aria-label="我的邀請">
      <h2>我的邀請</h2>
      {invitations.filter(item => item.state === 'pending').length === 0 && <p className="field-hint">目前沒有待回覆的邀請。</p>}
      <ul className="stack">{invitations.filter(item => item.state === 'pending').map(invitation => <li key={invitation.invitation_id} className="card">
        <p>{invitation.tenant_display_name}・{roleLabel(invitation.role)}</p>
        <button type="button" className="btn btn-primary" onClick={() => void respond(invitation, 'accept')}>接受{invitation.tenant_display_name}的邀請</button>
        <button type="button" className="btn btn-ghost" onClick={() => void respond(invitation, 'decline')}>婉拒{invitation.tenant_display_name}的邀請</button>
      </li>)}</ul>
    </section>
  </div>;
}
