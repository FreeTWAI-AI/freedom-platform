import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { InvitationView, MemberView, TenantView, WorkspaceView } from '../../../../contracts/guild-launchpad/v1/tenant';
import { ApiError, type PortalClient } from '../api';
import type { SessionPayload } from '../types';
import { TenantSelector, roleLabel } from './TenantSelector';
import './tenant-workspaces.css';

type Page<T> = { items: T[]; next_cursor: string | null; source_version: string };
type Attempt = { key: string; path: string; body: unknown; ifMatch?: string; tenantId: string | null; notice?: string };
type DirectoryPerson = { user_id: string; nickname: string };
const INVITE_ROLES = ['admin', 'operator', 'viewer'] as const;
const UNRESOLVED_ALERT = '上一個操作的結果還在確認。請先按「再確認一次」，或重新送出原本的操作。';

function attemptSlot(tenantId: string | null) { return tenantId ?? ''; }
function sameRequest(attempt: Attempt, path: string, body: unknown, ifMatch?: string) {
  return attempt.path === path && JSON.stringify(attempt.body) === JSON.stringify(body) && attempt.ifMatch === ifMatch;
}

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
  const unresolvedRef = useRef(new Map<string, Attempt>());
  const workspaceLock = useRef(false);
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

  function rememberUnresolved(attempt: Attempt) {
    const slot = attemptSlot(attempt.tenantId);
    // Occupied from the send until a definitive result. Same key stays; a different key is not replaced.
    if (unresolvedRef.current.has(slot)) return;
    unresolvedRef.current.set(slot, attempt);
  }
  function forgetUnresolved(attempt: Attempt) {
    const slot = attemptSlot(attempt.tenantId);
    if (unresolvedRef.current.get(slot)?.key === attempt.key) unresolvedRef.current.delete(slot);
  }
  // One unresolved attempt per slot. A different path, body, or If-Match stays unsent.
  function attemptFor(tenantId: string | null, path: string, body: unknown, ifMatch?: string, notice?: string): Attempt | null {
    const kept = unresolvedRef.current.get(attemptSlot(tenantId));
    if (kept) {
      if (sameRequest(kept, path, body, ifMatch)) return kept;
      setPending(kept);
      setAlertText(UNRESOLVED_ALERT);
      return null;
    }
    if (pending && pending.tenantId === tenantId && sameRequest(pending, path, body, ifMatch)) return pending;
    return { key: crypto.randomUUID(), path, body, ifMatch, tenantId, notice };
  }

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
    setNotice(''); setAlertText(''); setPeople([]);
    setPending(unresolvedRef.current.get(tenantId) ?? unresolvedRef.current.get('') ?? null);
    const { signal, live } = begin();
    setSelectedId(tenantId); setTenant(null); setMembers([]); setWorkspaceName(''); setLoading(true);
    void loadTenant(tenantId, signal, live).catch(error => { if (live()) setAlertText(error instanceof ApiError ? error.message : '需要處理'); }).finally(() => { if (live()) setLoading(false); });
  }

  async function run<T>(attempt: Attempt): Promise<T | null> {
    // This attempt keeps the signal it started with. A later switch replaces abortRef.
    const ticket = generation.current;
    const signal = abortRef.current?.signal;
    const live = () => generation.current === ticket && !signal?.aborted;
    const unknown = (error: unknown) => signal?.aborted === true || (error instanceof ApiError && (error.network || (error.status ?? 0) >= 500));
    rememberUnresolved(attempt);
    if (live()) { setAlertText(''); setNotice(''); }
    try {
      const value = await client.post<T>(attempt.path, attempt.body, { idempotencyKey: attempt.key, ifMatch: attempt.ifMatch, signal });
      if (!live()) { forgetUnresolved(attempt); return null; }
      forgetUnresolved(attempt);
      setPending(current => current?.key === attempt.key ? null : current);
      setAlertText(current => current === UNRESOLVED_ALERT ? '' : current);
      return value;
    } catch (error) {
      if (!live()) {
        if (unknown(error)) rememberUnresolved(attempt);
        else forgetUnresolved(attempt);
        return null;
      }
      if (error instanceof ApiError && error.status === 412) {
        forgetUnresolved(attempt);
        setPending(current => current?.key === attempt.key ? null : current);
        setAlertText('資料已更新。請重新載入後比對再操作。');
        return null;
      }
      if (error instanceof ApiError && error.status === 401) return null;
      if (unknown(error)) {
        rememberUnresolved(attempt);
        setPending(attempt);
        setAlertText('正在確認是否已儲存');
        return null;
      }
      forgetUnresolved(attempt);
      setPending(current => current?.key === attempt.key ? null : current);
      setAlertText(error instanceof ApiError ? error.message : '需要處理');
      return null;
    }
  }

  async function confirmAgain() {
    const attempt = pending;
    if (!attempt) return;
    if (attempt.tenantId !== null && attempt.tenantId !== selectedId) return;
    const value = await run<{ tenant?: TenantView }>(attempt);
    if (!value) return;
    if (attempt.notice) { setNotice(attempt.notice); setPeople([]); }
    await loadMine(attempt.path === '/tenants' ? value.tenant?.tenant_id : selectedId ?? undefined);
  }

  async function createTenant(event: FormEvent) {
    event.preventDefault();
    const body: { display_name: string; workspace_name?: string } = { display_name: createName.trim() };
    if (createWorkspace.trim()) body.workspace_name = createWorkspace.trim();
    const attempt = attemptFor(null, '/tenants', body);
    if (!attempt) return;
    const created = await run<{ tenant: TenantView; workspace: WorkspaceView }>(attempt);
    if (!created) return;
    setCreateName(''); setCreateWorkspace(''); setNotice(`已建立${created.tenant.display_name}。`);
    await loadMine(created.tenant.tenant_id);
  }

  async function saveTenant(event: FormEvent) {
    event.preventDefault();
    if (!tenant) return;
    const attempt = attemptFor(tenant.tenant_id, `/tenants/${tenant.tenant_id}/edit`, { display_name: editName.trim(), public_slug: slug.trim() || null }, tenant.version);
    if (!attempt) return;
    const saved = await run<TenantView>(attempt);
    if (!saved) return;
    setNotice('已儲存業務空間資料。'); await loadMine(saved.tenant_id);
  }

  async function addWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!tenant || workspaceLock.current) return;
    // The ref closes the gap before the disabled render, so one double-click sends one key.
    workspaceLock.current = true;
    try {
      const attempt = attemptFor(tenant.tenant_id, `/tenants/${tenant.tenant_id}/workspaces`, { name: newWorkspace.trim() });
      if (!attempt) return;
      const saved = await run<WorkspaceView>(attempt);
      if (!saved) return;
      setNewWorkspace(''); setNotice(`已建立工作區${saved.name}。`); await loadMine(tenant.tenant_id);
    } finally {
      workspaceLock.current = false;
    }
  }

  async function findPeople(event: FormEvent) {
    event.preventDefault();
    const term = search.trim();
    if (!term) return;
    const ticket = generation.current;
    const signal = abortRef.current?.signal;
    const live = () => generation.current === ticket && !signal?.aborted;
    setPeople([]); setAlertText('');
    try {
      const data = await client.get<{ items: DirectoryPerson[] }>(`/members?limit=20&sort=nickname&search=${encodeURIComponent(term)}`, { signal });
      if (!live()) return;
      setPeople(data.items.filter(person => person.user_id !== userId).map(person => ({ user_id: person.user_id, nickname: person.nickname })));
    } catch (error) {
      if (!live()) return;
      setAlertText(error instanceof ApiError ? error.message : '需要處理');
    }
  }

  async function invite(person: DirectoryPerson) {
    if (!tenant) return;
    const ticket = generation.current;
    const signal = abortRef.current?.signal;
    const live = () => generation.current === ticket && !signal?.aborted;
    const tenantId = tenant.tenant_id;
    let candidate: { principal_id: string; display_name: string };
    try {
      candidate = await client.get<{ principal_id: string; display_name: string }>(`/tenants/invite-candidates?user_id=${encodeURIComponent(person.user_id)}`, { signal });
    } catch (error) {
      if (!live()) return;
      setAlertText(error instanceof ApiError ? error.message : '需要處理');
      return;
    }
    if (!live()) return;
    const expires = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    const attempt = attemptFor(tenantId, `/tenants/${tenantId}/invitations`, { invitee_principal_id: candidate.principal_id, role: inviteRole, instance_capabilities: [], expires_at: expires }, undefined, `已邀請${candidate.display_name}。`);
    if (!attempt) return;
    const saved = await run<InvitationView>(attempt);
    if (!saved) return;
    setNotice(`已邀請${candidate.display_name}。`); setPeople([]);
  }

  async function respond(invitation: InvitationView, action: 'accept' | 'decline') {
    const path = `/tenants/${invitation.tenant_id}/invitations/${invitation.invitation_id}/${action}`;
    const attempt = action === 'accept'
      ? attemptFor(invitation.tenant_id, path, {}, invitation.version)
      : attemptFor(invitation.tenant_id, path, {});
    if (!attempt) return;
    const saved = await run<unknown>(attempt);
    if (!saved) return;
    setNotice(action === 'accept' ? `已加入${invitation.tenant_display_name}。` : `已婉拒${invitation.tenant_display_name}。`);
    await loadMine(action === 'accept' ? invitation.tenant_id : selectedId ?? undefined);
  }

  async function changeMember(member: MemberView, status: 'active' | 'revoked') {
    if (!tenant) return;
    const attempt = attemptFor(tenant.tenant_id, `/tenants/${tenant.tenant_id}/members/${member.principal_id}/change`, { role: member.role === 'owner' ? 'viewer' : member.role, status, instance_capabilities: [], reason: status === 'revoked' ? '撤銷成員資格' : '調整成員角色' }, member.version);
    if (!attempt) return;
    const saved = await run<MemberView>(attempt);
    if (!saved) return;
    setNotice(status === 'revoked' ? `已撤銷${member.display_name}。` : `已更新${member.display_name}的角色。`);
    await loadMine(tenant.tenant_id);
  }

  async function updateRole(member: MemberView, role: 'admin' | 'operator' | 'viewer') {
    await changeMember({ ...member, role }, member.status);
  }

  async function leave() {
    if (!tenant) return;
    const attempt = attemptFor(tenant.tenant_id, `/tenants/${tenant.tenant_id}/leave`, {}, tenant.my_membership.version);
    if (!attempt) return;
    const saved = await run<{ status: 'revoked'; version: string }>(attempt);
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
    {pending && (pending.tenantId === null || pending.tenantId === selectedId) && <div className="actions"><button type="button" className="btn btn-ghost" onClick={() => void confirmAgain()}>再確認一次</button></div>}
    {alertText.includes('請重新載入') && <div className="actions"><button type="button" className="btn btn-ghost" onClick={() => void loadMine(selectedId ?? undefined)}>重新載入</button></div>}

    <form className="card stack tenant-create" onSubmit={event => void createTenant(event)}>
      <h2>建立業務空間</h2>
      <label className="field">業務空間名稱<input value={createName} maxLength={120} required onChange={event => setCreateName(event.target.value)}/></label>
      <label className="field">工作區名稱（可略過）<input value={createWorkspace} maxLength={120} onChange={event => setCreateWorkspace(event.target.value)}/></label>
      <div className="actions"><button className="btn btn-primary" type="submit">建立業務空間</button></div>
    </form>

    <TenantSelector tenants={tenants} selectedId={selectedId} onSelect={selectTenant}/>

    {tenant && <section className="card stack" aria-label="目前業務空間">
      <p><strong>{tenant.display_name}／{workspaceName || '工作區讀取中'}</strong></p>
      <p>我的角色：{roleLabel(tenant.my_membership.role)}</p>
      {canEdit && <form className="stack" onSubmit={event => void saveTenant(event)}>
        <label className="field">顯示名稱<input value={editName} maxLength={120} required onChange={event => setEditName(event.target.value)}/></label>
        <label className="field">網址代號（可留空）<input value={slug} maxLength={64} onChange={event => setSlug(event.target.value)} spellCheck={false}/></label>
        <div className="actions"><button className="btn btn-ghost" type="submit">儲存</button></div>
      </form>}
      {canAddWorkspace && <form className="stack" onSubmit={event => void addWorkspace(event)}>
        <label className="field">新工作區名稱<input value={newWorkspace} maxLength={120} required onChange={event => setNewWorkspace(event.target.value)}/></label>
        <div className="actions"><button className="btn btn-ghost" type="submit">建立工作區</button></div>
      </form>}
      <section className="stack" aria-label="成員">
        <h2>成員</h2>
        <ul className="stack tenant-rows">{members.map(member => <li key={member.principal_id} className="tenant-row">
          <p>{member.display_name}・{roleLabel(member.role)}・{member.status === 'active' ? '使用中' : '已撤銷'}</p>
          {canManage && member.status === 'active' && member.role !== 'owner' && member.principal_id !== tenant.my_membership.principal_id && <div className="actions tenant-member-actions">
            <div className="field tenant-member-role">
              <label htmlFor={`tenant-member-role-${member.principal_id}`}>角色</label>
              <select id={`tenant-member-role-${member.principal_id}`} value={member.role} onChange={event => void updateRole(member, event.target.value as 'admin' | 'operator' | 'viewer')}>
                {inviteChoices.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}
              </select>
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => void changeMember(member, 'revoked')}>撤銷</button>
          </div>}
        </li>)}</ul>
      </section>
      {canInvite && <form className="stack" onSubmit={event => void findPeople(event)}>
        <h2>邀請成員</h2>
        <label className="field">搜尋夥伴<input type="search" value={search} maxLength={80} onChange={event => setSearch(event.target.value)}/></label>
        <label className="field">邀請角色<select value={inviteRole} onChange={event => setInviteRole(event.target.value as (typeof INVITE_ROLES)[number])}>
          {inviteChoices.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}
        </select></label>
        <div className="actions"><button className="btn btn-ghost" type="submit">搜尋</button></div>
        <ul className="stack">{people.map(person => <li key={person.user_id}>
          <div className="actions"><button type="button" className="btn btn-ghost" onClick={() => void invite(person)}>邀請{person.nickname}為{roleLabel(inviteRole)}</button></div>
        </li>)}</ul>
      </form>}
      <section className="stack" aria-label="離開業務空間">
        {lastOwner && <p className="field-hint">你是唯一使用中的擁有者，目前不能離開這個業務空間。</p>}
        <div className="actions">
          {lastOwner
            ? <button type="button" className="btn btn-ghost" disabled>離開這個業務空間</button>
            : <button type="button" className="btn btn-ghost" onClick={() => void leave()}>離開這個業務空間</button>}
        </div>
      </section>
    </section>}

    <section className="card stack" aria-label="我的邀請">
      <h2>我的邀請</h2>
      {invitations.filter(item => item.state === 'pending').length === 0 && <p className="field-hint">目前沒有待回覆的邀請。</p>}
      <ul className="stack tenant-rows">{invitations.filter(item => item.state === 'pending').map(invitation => <li key={invitation.invitation_id} className="tenant-row">
        <p>{invitation.tenant_display_name}・{roleLabel(invitation.role)}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => void respond(invitation, 'accept')}>接受{invitation.tenant_display_name}的邀請</button>
          <button type="button" className="btn btn-ghost" onClick={() => void respond(invitation, 'decline')}>婉拒{invitation.tenant_display_name}的邀請</button>
        </div>
      </li>)}</ul>
    </section>
  </div>;
}
