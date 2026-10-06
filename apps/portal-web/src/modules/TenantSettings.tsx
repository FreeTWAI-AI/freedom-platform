import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { InvitationView, MemberView, RecoveryCaseView, TenantView, TransferView, WorkspaceView } from '../../../../contracts/guild-launchpad/v1/tenant';
import { ApiError, type PortalClient } from '../api';
import type { SessionPayload } from '../types';
import { TenantSelector, roleLabel } from './TenantSelector';
import './tenant-workspaces.css';

type Page<T> = { items: T[]; next_cursor: string | null; source_version: string };
type Attempt = { key: string; path: string; body: unknown; ifMatch?: string };
type DirectoryPerson = { user_id: string; nickname: string };
type AfterRole = TransferView['from_role_after'];
type Bag = { tenant_id?: string; workspace_id?: string; ownership_transfer_id?: string };
const INVITE_ROLES = ['admin', 'operator', 'viewer'] as const;
const AFTER_ROLES = ['admin', 'operator', 'viewer', 'revoked'] as const;
const AFTER_LABEL: Record<AfterRole, string> = { admin: '管理員', operator: '操作者', viewer: '檢視者', revoked: '已撤銷' };
const TRANSFER_HOURS = [1, 6, 24] as const;

function storedKey(userId: string) { return `freedom-acting-tenant:${userId}`; }
function readBag(userId: string): Bag {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storedKey(userId)) ?? '') as Record<string, unknown>;
    return {
      tenant_id: typeof parsed.tenant_id === 'string' ? parsed.tenant_id : undefined,
      workspace_id: typeof parsed.workspace_id === 'string' ? parsed.workspace_id : undefined,
      ownership_transfer_id: typeof parsed.ownership_transfer_id === 'string' ? parsed.ownership_transfer_id : undefined,
    };
  } catch { return {}; }
}
function writeBag(userId: string, bag: Bag) {
  try { sessionStorage.setItem(storedKey(userId), JSON.stringify(bag)); } catch { /* The screen still shows the current choice. */ }
}
function readStored(userId: string): string | null {
  return readBag(userId).tenant_id ?? null;
}
function remember(userId: string, tenantId: string, workspaceId: string) {
  const previous = readBag(userId);
  writeBag(userId, {
    tenant_id: tenantId,
    workspace_id: workspaceId,
    ...(previous.tenant_id === tenantId && previous.ownership_transfer_id ? { ownership_transfer_id: previous.ownership_transfer_id } : {}),
  });
}
function rememberTransfer(userId: string, tenantId: string, transferId: string | null) {
  const bag = readBag(userId);
  if (bag.tenant_id !== tenantId) return;
  writeBag(userId, {
    tenant_id: bag.tenant_id,
    workspace_id: bag.workspace_id,
    ...(transferId ? { ownership_transfer_id: transferId } : {}),
  });
}
function allows(tenant: TenantView, key: string) {
  return tenant.capabilities.some(grant => grant.instance_id === null && grant.keys.includes(key));
}
function sameGeneration(ticket: number, generation: { current: number }, signal: AbortSignal) {
  return generation.current === ticket && !signal.aborted;
}
function networkFailure(error: unknown) {
  return error instanceof ApiError && (error.network || (error.status ?? 0) >= 500);
}

export function TenantSettings({ client, session, enabled }: { client: PortalClient; session: SessionPayload; enabled: boolean | null }) {
  const userId = session.user.user_id;
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const actionPurpose = useRef<'tenant.ownership.propose' | 'tenant.ownership.accept' | 'tenant.recovery.accept' | null>(null);
  const actionTenant = useRef<string | null>(null);
  const dialogTitle = useId();
  const [tenants, setTenants] = useState<TenantView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tenant, setTenant] = useState<TenantView | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [members, setMembers] = useState<MemberView[]>([]);
  const [membersComplete, setMembersComplete] = useState(true);
  const [invitations, setInvitations] = useState<InvitationView[]>([]);
  const [incomingTransfers, setIncomingTransfers] = useState<TransferView[]>([]);
  const [recoveryCases, setRecoveryCases] = useState<RecoveryCaseView[]>([]);
  const [outgoing, setOutgoing] = useState<TransferView | null>(null);
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
  const [recipientQuery, setRecipientQuery] = useState('');
  const [recipientPeople, setRecipientPeople] = useState<DirectoryPerson[]>([]);
  const [recipient, setRecipient] = useState<DirectoryPerson | null>(null);
  const [afterRole, setAfterRole] = useState<AfterRole>('admin');
  const [transferHours, setTransferHours] = useState<(typeof TRANSFER_HOURS)[number]>(24);
  const [transferReason, setTransferReason] = useState('');
  const [transferPreview, setTransferPreview] = useState<{ principalId: string; displayName: string; expiresAt: string } | null>(null);
  const [cancelReason, setCancelReason] = useState('取消這次擁有權移交');
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [verifiedAction, setVerifiedAction] = useState<null | ((verificationId: string) => Promise<void>)>(null);

  function begin() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const ticket = ++generation.current;
    return { signal: controller.signal, live: () => sameGeneration(ticket, generation, controller.signal) };
  }

  async function loadOutgoing(view: TenantView, signal: AbortSignal, live: () => boolean) {
    const transferId = view.my_membership.role === 'owner' ? readBag(userId).ownership_transfer_id : undefined;
    const sameTenant = readBag(userId).tenant_id === view.tenant_id;
    if (!transferId || !sameTenant || view.status !== 'active') {
      if (live()) setOutgoing(null);
      return;
    }
    try {
      const row = await client.get<TransferView>(`/tenants/${view.tenant_id}/ownership-transfers/${transferId}`, { signal });
      if (!live()) return;
      if (row.state === 'pending' && row.from_principal_id === view.my_membership.principal_id) setOutgoing(row);
      else { setOutgoing(null); rememberTransfer(userId, view.tenant_id, null); }
    } catch {
      if (!live()) return;
      setOutgoing(null);
      rememberTransfer(userId, view.tenant_id, null);
    }
  }

  async function loadMine(prefer?: string) {
    const { signal, live } = begin();
    setLoading(true); setTenant(null); setMembers([]); setWorkspaceName(''); setPending(null); setOutgoing(null); setTransferPreview(null);
    try {
      const [page, inbox, transfers, recoveries] = await Promise.all([
        client.get<Page<TenantView>>('/tenants?limit=100', { signal }),
        client.get<Page<InvitationView>>('/me/tenant-invitations?limit=100', { signal }),
        client.get<Page<TransferView>>('/me/tenant-ownership-transfers?limit=100', { signal }),
        client.get<Page<RecoveryCaseView>>('/me/tenant-recovery-cases?limit=100', { signal }),
      ]);
      if (!live()) return;
      setTenants(page.items); setInvitations(inbox.items); setIncomingTransfers(transfers.items); setRecoveryCases(recoveries.items);
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
    await loadOutgoing(view, signal, live);
  }

  useEffect(() => {
    if (enabled !== true) return;
    void loadMine();
    return () => abortRef.current?.abort();
    // The acting tenant is re-read when the signed-in member changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (passwordOpen && !dialog.open) dialog.showModal();
    if (!passwordOpen && dialog.open) dialog.close();
    if (passwordOpen) passwordInput.current?.focus();
  }, [passwordOpen]);

  useEffect(() => () => { setPassword(''); }, []);

  function selectTenant(tenantId: string) {
    if (tenantId === selectedId && tenant) return;
    setNotice(''); setAlertText(''); setPending(null); setPeople([]); setRecipientPeople([]); setTransferPreview(null);
    const { signal, live } = begin();
    setSelectedId(tenantId); setTenant(null); setMembers([]); setWorkspaceName(''); setOutgoing(null); setLoading(true);
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
      if (networkFailure(error)) {
        setPending(attempt); setAlertText('正在確認是否已儲存'); return null;
      }
      setPending(null); setAlertText(error instanceof ApiError ? error.message : '需要處理'); return null;
    }
  }

  async function confirmAgain() {
    const attempt = pending;
    if (!attempt) return;
    const value = await run<{ tenant?: TenantView; tenant_id?: string; transfer_id?: string }>(attempt);
    if (!value) return;
    if (value.transfer_id && value.tenant_id && attempt.path.endsWith('/ownership-transfers')) rememberTransfer(userId, value.tenant_id, value.transfer_id);
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

  async function findRecipients() {
    const term = recipientQuery.trim();
    if (!term) return;
    setRecipientPeople([]); setAlertText('');
    try {
      const data = await client.get<{ items: DirectoryPerson[] }>(`/members?limit=20&sort=nickname&search=${encodeURIComponent(term)}`, { signal: abortRef.current?.signal });
      setRecipientPeople(data.items.filter(person => person.user_id !== userId).map(person => ({ user_id: person.user_id, nickname: person.nickname })));
    } catch (error) {
      if (abortRef.current?.signal.aborted) return;
      setAlertText(error instanceof ApiError ? error.message : '需要處理');
    }
  }

  async function invite(person: DirectoryPerson) {
    if (!tenant) return;
    let candidate: { principal_id: string; display_name: string };
    try {
      candidate = await client.get<{ principal_id: string; display_name: string }>(`/tenants/invite-candidates?user_id=${encodeURIComponent(person.user_id)}`, { signal: abortRef.current?.signal });
    } catch (error) {
      if (abortRef.current?.signal.aborted) return;
      setAlertText(error instanceof ApiError ? error.message : '需要處理');
      return;
    }
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

  function closePassword() {
    setPassword(''); setPasswordError(''); setPasswordOpen(false); setVerifiedAction(null);
    returnFocus.current?.focus();
  }

  function openPassword(event: MouseEvent<HTMLButtonElement>, action: (verificationId: string) => Promise<void>) {
    returnFocus.current = event.currentTarget;
    setPassword(''); setPasswordError(''); setVerifiedAction(() => action); setPasswordOpen(true);
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!tenant && !verifiedAction) return;
    const action = verifiedAction;
    const secret = password;
    if (!action || !secret) return;
    setPassword(''); setPasswordBusy(true); setPasswordError('');
    try {
      const purpose = actionPurpose.current;
      const tenantId = actionTenant.current;
      if (!purpose || !tenantId) return;
      const verified = await client.post<{ verification_id: string }>('/me/high-risk-verifications', {
        password: secret, purpose, tenant_id: tenantId,
      }, { signal: abortRef.current?.signal });
      setPasswordOpen(false); setVerifiedAction(null);
      await action(verified.verification_id);
    } catch (error) {
      if (abortRef.current?.signal.aborted) return;
      if (networkFailure(error)) {
        setPasswordError('無法確認重新驗證，請再輸入一次密碼。');
        return;
      }
      setPasswordError(error instanceof ApiError ? error.message : '需要處理');
    } finally { setPasswordBusy(false); }
  }

  async function previewTransfer(event: FormEvent) {
    event.preventDefault();
    if (!tenant || !recipient) return;
    setAlertText('');
    try {
      const candidate = await client.get<{ principal_id: string; display_name: string }>(`/tenants/invite-candidates?user_id=${encodeURIComponent(recipient.user_id)}`, { signal: abortRef.current?.signal });
      setTransferPreview({
        principalId: candidate.principal_id,
        displayName: candidate.display_name,
        expiresAt: new Date(Date.now() + transferHours * 60 * 60 * 1000).toISOString(),
      });
    } catch (error) {
      if (abortRef.current?.signal.aborted) return;
      setAlertText(error instanceof ApiError ? error.message : '需要處理');
    }
  }

  function startPropose(event: MouseEvent<HTMLButtonElement>) {
    if (!tenant || !transferPreview) return;
    const preview = transferPreview;
    const reason = transferReason.trim();
    const role = afterRole;
    const tenantId = tenant.tenant_id;
    actionPurpose.current = 'tenant.ownership.propose';
    actionTenant.current = tenantId;
    const key = crypto.randomUUID();
    openPassword(event, async verificationId => {
      const saved = await run<TransferView>({
        key, path: `/tenants/${tenantId}/ownership-transfers`,
        body: {
          to_principal_id: preview.principalId, from_role_after: role, expires_at: preview.expiresAt,
          reason, fresh_auth_verification_id: verificationId,
        },
      });
      if (!saved) return;
      setTransferPreview(null); setRecipient(null); setRecipientPeople([]); setTransferReason('');
      setOutgoing(saved); rememberTransfer(userId, tenantId, saved.transfer_id);
      setNotice(`已提出移交給${saved.to_display_name}。對方接受前，擁有權不會改變。`);
      await loadMine(tenantId);
    });
  }

  async function cancelTransfer(event: FormEvent) {
    event.preventDefault();
    if (!tenant || !outgoing) return;
    const saved = await run<TransferView>({
      key: crypto.randomUUID(), path: `/tenants/${tenant.tenant_id}/ownership-transfers/${outgoing.transfer_id}/cancel`,
      body: { reason: cancelReason.trim() },
    });
    if (!saved) return;
    setOutgoing(null); rememberTransfer(userId, tenant.tenant_id, null);
    setNotice('已取消移交。'); await loadMine(tenant.tenant_id);
  }

  function startAcceptTransfer(event: MouseEvent<HTMLButtonElement>, transfer: TransferView) {
    actionPurpose.current = 'tenant.ownership.accept';
    actionTenant.current = transfer.tenant_id;
    const key = crypto.randomUUID();
    openPassword(event, async verificationId => {
      const saved = await run<{ tenant_id: string }>({
        key, path: `/tenants/${transfer.tenant_id}/ownership-transfers/${transfer.transfer_id}/accept`, ifMatch: transfer.version,
        body: { accept_scope: true, fresh_auth_verification_id: verificationId },
      });
      if (!saved) return;
      setNotice(`已接受${transfer.tenant_display_name}的擁有權。`);
      await loadMine(transfer.tenant_id);
    });
  }

  async function declineTransfer(transfer: TransferView) {
    const saved = await run<TransferView>({
      key: crypto.randomUUID(), path: `/tenants/${transfer.tenant_id}/ownership-transfers/${transfer.transfer_id}/decline`, body: {},
    });
    if (!saved) return;
    setNotice(`已拒絕${transfer.tenant_display_name}的擁有權移交。`);
    await loadMine(selectedId ?? undefined);
  }

  function startAcceptRecovery(event: MouseEvent<HTMLButtonElement>, item: RecoveryCaseView) {
    actionPurpose.current = 'tenant.recovery.accept';
    actionTenant.current = item.tenant_id;
    const key = crypto.randomUUID();
    openPassword(event, async verificationId => {
      const saved = await run<RecoveryCaseView>({
        key, path: `/me/tenant-recovery-cases/${item.case_id}/accept`, ifMatch: item.version,
        body: { accept_scope: true, fresh_auth_verification_id: verificationId },
      });
      if (!saved) return;
      setNotice(`已接受${item.tenant_display_name}的復原。擁有權要等管理員執行後才會變更。`);
      await loadMine(selectedId ?? undefined);
    });
  }

  if (enabled === null) return <p role="status">正在讀取這個頁面。</p>;
  if (enabled === false) return <p className="banner" role="status">這個頁面目前未開放。</p>;

  const recovering = tenant?.status === 'recovery_required';
  const canEdit = tenant && !recovering ? allows(tenant, 'tenant.metadata.edit') : false;
  const canInvite = tenant && !recovering ? allows(tenant, 'tenant.member.invite') : false;
  const canManage = tenant && !recovering ? allows(tenant, 'tenant.member.manage') : false;
  const canAddWorkspace = tenant && !recovering ? allows(tenant, 'tenant.workspace.create') : false;
  const canTransfer = tenant?.my_membership.role === 'owner' && tenant.status === 'active';
  const inviteChoices = tenant?.my_membership.role === 'owner' ? INVITE_ROLES : INVITE_ROLES.filter(role => role !== 'admin');
  const activeOwners = members.filter(member => member.role === 'owner' && member.status === 'active').length;
  const lastOwner = tenant?.my_membership.role === 'owner' && membersComplete && activeOwners <= 1;

  return <div className="module-panel stack tenant-workspace">
    <p role="status" aria-live="polite">{loading ? '結果確認中' : notice}</p>
    {alertText && <p className="banner" role="alert">{alertText}</p>}
    {pending && <div className="actions"><button type="button" className="btn btn-ghost" onClick={() => void confirmAgain()}>再確認一次</button></div>}
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
      {recovering && <p className="banner" role="status">此業務空間目前沒有可登入的擁有者，正在等待受控復原；資料不會被刪除。</p>}
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
      {canTransfer && <section className="stack" aria-label="移交擁有權">
        <h2>移交擁有權</h2>
        {outgoing?.state === 'pending'
          ? <form className="stack card" onSubmit={event => void cancelTransfer(event)}>
            <p>已提議將擁有權移交給{outgoing.to_display_name}。對方接受前，你仍是擁有者。接受後你的角色是{AFTER_LABEL[outgoing.from_role_after]}。</p>
            <label className="field">取消原因<input value={cancelReason} minLength={3} maxLength={1000} required onChange={event => setCancelReason(event.target.value)}/></label>
            <button className="btn btn-ghost" type="submit">取消移交</button>
          </form>
          : <form className="stack" onSubmit={event => void previewTransfer(event)}>
            <label className="field">搜尋接收者<input type="search" value={recipientQuery} maxLength={80} onChange={event => setRecipientQuery(event.target.value)}/></label>
            <button className="btn btn-ghost" type="button" onClick={() => void findRecipients()}>搜尋接收者</button>
            <ul className="stack">{recipientPeople.map(person => <li key={person.user_id}>
              <button type="button" className={recipient?.user_id === person.user_id ? 'btn btn-primary' : 'btn btn-ghost'} aria-pressed={recipient?.user_id === person.user_id} onClick={() => setRecipient(person)}>選擇{person.nickname}為接收者</button>
            </li>)}</ul>
            <label className="field">移交後我的角色<select value={afterRole} onChange={event => setAfterRole(event.target.value as AfterRole)}>
              {AFTER_ROLES.map(role => <option key={role} value={role}>{AFTER_LABEL[role]}</option>)}
            </select></label>
            <label className="field">移交期限<select value={transferHours} onChange={event => setTransferHours(Number(event.target.value) as (typeof TRANSFER_HOURS)[number])}>
              {TRANSFER_HOURS.map(hours => <option key={hours} value={hours}>{hours} 小時</option>)}
            </select></label>
            <label className="field">移交原因<input value={transferReason} minLength={3} maxLength={1000} required onChange={event => setTransferReason(event.target.value)}/></label>
            <button className="btn btn-ghost" type="submit" disabled={!recipient}>檢視移交內容</button>
          </form>}
        {transferPreview && recipient && <section className="stack card" aria-label="確認移交">
          <p>將把「{tenant.display_name}」的擁有權移交給{transferPreview.displayName}。對方接受後成為擁有者，你的角色會變成{AFTER_LABEL[afterRole]}。對方接受前，擁有權不會改變。</p>
          <button type="button" className="btn btn-primary" onClick={startPropose}>繼續，重新驗證密碼</button>
          <button type="button" className="btn btn-ghost" onClick={() => setTransferPreview(null)}>返回修改</button>
        </section>}
      </section>}
      {!recovering && <section className="stack" aria-label="離開業務空間">
        {lastOwner && <p className="field-hint">你是唯一使用中的擁有者，目前不能離開這個業務空間。</p>}
        <div className="actions">
          {lastOwner
            ? <button type="button" className="btn btn-ghost" disabled>離開這個業務空間</button>
            : <button type="button" className="btn btn-ghost" onClick={() => void leave()}>離開這個業務空間</button>}
        </div>
      </section>}
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

    <section className="stack" aria-label="待接受的擁有權移交">
      <h2>待接受的擁有權移交</h2>
      {incomingTransfers.length === 0 && <p className="field-hint">目前沒有待接受的擁有權移交。</p>}
      <ul className="stack">{incomingTransfers.map(transfer => <li key={transfer.transfer_id} className="card">
        <p>{transfer.tenant_display_name}：{transfer.from_display_name}邀請你成為擁有者。接受後對方的角色是{AFTER_LABEL[transfer.from_role_after]}。</p>
        <button type="button" className="btn btn-primary" onClick={event => startAcceptTransfer(event, transfer)}>接受{transfer.tenant_display_name}的擁有權移交</button>
        <button type="button" className="btn btn-ghost" onClick={() => void declineTransfer(transfer)}>拒絕{transfer.tenant_display_name}的擁有權移交</button>
      </li>)}</ul>
    </section>

    <section className="stack" aria-label="待接受的復原">
      <h2>待接受的復原</h2>
      {recoveryCases.length === 0 && <p className="field-hint">目前沒有待接受的復原。</p>}
      <ul className="stack">{recoveryCases.map(item => <li key={item.case_id} className="card">
        <p>{item.tenant_display_name}請你成為受控復原後的擁有者。接受不會立刻變更擁有權，仍須由另一位管理員執行。</p>
        {item.recipient_accepted
          ? <p className="field-hint">已接受，等待執行。</p>
          : <button type="button" className="btn btn-primary" onClick={event => startAcceptRecovery(event, item)}>接受{item.tenant_display_name}的復原</button>}
      </li>)}</ul>
    </section>

    <dialog ref={dialogRef} className="tenant-authority-dialog" aria-labelledby={dialogTitle} aria-describedby={`${dialogTitle}-hint`} onCancel={event => { event.preventDefault(); closePassword(); }} onClose={() => { if (passwordOpen) closePassword(); }}>
      <form className="stack" onSubmit={event => void submitPassword(event)}>
        <h2 id={dialogTitle}>重新驗證</h2>
        <p id={`${dialogTitle}-hint`}>這一步只核對你現在的密碼，不會把密碼保存起來。</p>
        <label className="field">目前的密碼<input ref={passwordInput} type="password" autoComplete="current-password" value={password} required minLength={1} maxLength={1024} onChange={event => setPassword(event.target.value)} disabled={passwordBusy}/></label>
        {passwordError && <p className="banner" role="alert">{passwordError}</p>}
        <div className="actions tenant-authority-actions">
          <button className="btn btn-primary" type="submit" disabled={passwordBusy}>確認密碼</button>
          <button className="btn btn-ghost" type="button" onClick={closePassword}>取消</button>
        </div>
      </form>
    </dialog>
  </div>;
}
