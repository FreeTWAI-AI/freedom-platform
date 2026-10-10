import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, type PortalClient } from '../api';
import { describeError } from '../portal-session';
import './NotificationPreferences.css';

type Category = 'friends' | 'squads' | 'events' | 'following';
type Mode = 'instant' | 'summary' | 'off';
type PreferenceBody = {
  categories: Record<Category, Mode>;
  quiet_hours: { enabled: boolean; time_zone: string; start: string; end: string };
  muted_channel_ids: string[];
};
type Preferences = PreferenceBody & {
  version: number;
  supported_categories: Category[];
  email_digest: { enabled: false; status: 'not_enabled'; reason: string };
};
type ChannelKind = 'guild' | 'squad' | 'world';
type Channel = { kind: ChannelKind; channel_key: string; name: string };
type ChannelPage = { items: Channel[]; next_offset: number | null };
type Summary = { items: { id: string; source: 'notification' | 'following' | 'event_bulletin'; title: string; path: string | null }[]; generated_at: string; email_status: 'not_enabled' };
type Pending = { body: PreferenceBody; version: number; key: string; revision: number };
const categories: Record<Category, string> = { friends: '好友邀請與結果', squads: '小隊邀請與加入結果', events: '活動更新', following: '追蹤更新' };
const modes: Record<Mode, string> = { instant: '即時提醒', summary: '站內摘要', off: '不提醒' };
const channelKinds: Record<ChannelKind, string> = { guild: '公會', squad: '小隊', world: '世界' };
const channelId = (channel: Channel) => `${channel.kind}:${channel.channel_key}`;
function bodyOf(value: PreferenceBody): PreferenceBody {
  return { categories: { ...value.categories }, quiet_hours: { ...value.quiet_hours }, muted_channel_ids: [...value.muted_channel_ids] };
}
function validDraft(value: PreferenceBody): string {
  try { new Intl.DateTimeFormat('zh-TW', { timeZone: value.quiet_hours.time_zone }); }
  catch { return '請輸入有效的 IANA 時區，例如 Asia/Taipei。'; }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.quiet_hours.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.quiet_hours.end)) return '請填入完整的開始與結束時間。';
  if (value.quiet_hours.enabled && value.quiet_hours.start === value.quiet_hours.end) return '安靜時段的開始與結束時間不能相同。';
  if (value.muted_channel_ids.length > 50) return '最多可靜音 50 個頻道。';
  return '';
}
function summaryHref(path: string | null): string | undefined {
  return path && (path.startsWith('#') || /^\/(?!\/)/.test(path)) ? path : undefined;
}

export function NotificationPreferencesPanel({ client, followingEnabled }: { client: PortalClient; followingEnabled: boolean }) {
  const id = useId();
  const [prefs, setPrefs] = useState<Preferences | null>(null), [draft, setDraft] = useState<PreferenceBody | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false), [retry, setRetry] = useState(false);
  const [kind, setKind] = useState<ChannelKind>('guild'), [channels, setChannels] = useState<Channel[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [channelLoading, setChannelLoading] = useState(false), [channelError, setChannelError] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null), [summaryLoading, setSummaryLoading] = useState(false), [summaryError, setSummaryError] = useState('');
  const mounted = useRef(false), generation = useRef(0), revision = useRef(0), preferencesLock = useRef(false), channelLock = useRef(false), summaryLock = useRef(false);
  const pending = useRef<Pending | null>(null), channelGeneration = useRef(0);
  const current = (epoch: number, session: number) => mounted.current && generation.current === epoch && client.sessionGeneration === session;

  const loadPreferences = useCallback(async (preserveInputs = false) => {
    if (preferencesLock.current) return;
    preferencesLock.current = true;
    const epoch = generation.current, session = client.sessionGeneration;
    setLoading(true); setError('');
    try {
      const value = await client.get<Preferences>('/me/notification-preferences');
      if (!current(epoch, session)) return;
      setPrefs(value);
      if (!preserveInputs) { setDraft(bodyOf(value)); revision.current = 0; }
      pending.current = null; setRetry(false); setConflict(false);
      if (preserveInputs) setNotice(`已載入版本 ${value.version}，你的輸入保持不變；請確認後再次儲存。`);
    } catch (cause) {
      if (current(epoch, session)) setError(describeError(cause).message);
    } finally {
      if (epoch === generation.current) preferencesLock.current = false;
      if (current(epoch, session)) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void loadPreferences();
    return () => {
      mounted.current = false; generation.current++; channelGeneration.current++;
      preferencesLock.current = false; channelLock.current = false; summaryLock.current = false;
    };
  }, [loadPreferences]);

  const loadChannels = useCallback(async (offset: number, append: boolean) => {
    if (channelLock.current) return;
    channelLock.current = true;
    const epoch = generation.current, pageEpoch = channelGeneration.current, session = client.sessionGeneration;
    setChannelLoading(true); setChannelError('');
    try {
      const value = await client.get<ChannelPage>(`/me/channels?kind=${kind}&limit=50&offset=${offset}`);
      if (!current(epoch, session) || pageEpoch !== channelGeneration.current) return;
      setChannels(previous => {
        const rows = append ? [...previous, ...value.items] : value.items;
        return rows.filter((row, index) => rows.findIndex(other => channelId(other) === channelId(row)) === index);
      });
      setNextOffset(value.next_offset);
    } catch (cause) {
      if (current(epoch, session) && pageEpoch === channelGeneration.current) setChannelError(describeError(cause).message);
    } finally {
      if (epoch === generation.current && pageEpoch === channelGeneration.current) channelLock.current = false;
      if (current(epoch, session) && pageEpoch === channelGeneration.current) setChannelLoading(false);
    }
  }, [client, kind]);
  useEffect(() => { channelGeneration.current++; setChannels([]); setNextOffset(null); void loadChannels(0, false); }, [loadChannels]);

  function edit(change: (value: PreferenceBody) => PreferenceBody) {
    revision.current++; setNotice(''); setDraft(value => value && change(value));
  }
  async function save() {
    if (preferencesLock.current || summaryLock.current || !prefs || !draft || conflict) return;
    if (!pending.current) {
      const invalid = validDraft(draft);
      if (invalid) { setError(invalid); return; }
      // Keep the complete command snapshot through uncertain transport results, even if inputs change.
      const body = bodyOf(draft);
      Object.freeze(body.categories); Object.freeze(body.quiet_hours); Object.freeze(body.muted_channel_ids); Object.freeze(body);
      pending.current = { body, version: prefs.version, key: crypto.randomUUID(), revision: revision.current };
    }
    const command = pending.current;
    preferencesLock.current = true; setSaving(true); setError(''); setNotice('');
    const epoch = generation.current, session = client.sessionGeneration;
    try {
      const value = await client.patch<Preferences>('/me/notification-preferences', command.body, { ifMatch: command.version, idempotencyKey: command.key });
      if (!current(epoch, session)) return;
      setPrefs(value);
      if (revision.current === command.revision) setDraft(bodyOf(value));
      pending.current = null; setRetry(false); setSummary(null);
      setNotice(revision.current === command.revision ? '通知偏好已儲存。' : '前一筆偏好已儲存；較新的輸入尚未儲存。');
      window.dispatchEvent(new Event('freedom-notification-preferences-updated'));
    } catch (cause) {
      if (!current(epoch, session)) return;
      if (cause instanceof ApiError && cause.conflict) {
        pending.current = null; setRetry(false); setConflict(true);
        setError('設定版本已變更或指令衝突。你的輸入仍保留，請先重新載入最新版本，再確認並儲存。');
      } else if (cause instanceof ApiError && cause.status > 0 && cause.status < 500 && !cause.timedOut && !cause.network) {
        pending.current = null; setRetry(false); setError(describeError(cause).message);
      } else {
        setRetry(true); setError(`${describeError(cause).message} 結果尚未確認；重試會送出同一筆設定，不包含之後修改的輸入。`);
      }
    } finally { if (epoch === generation.current) preferencesLock.current = false; if (current(epoch, session)) setSaving(false); }
  }
  async function preview() {
    if (summaryLock.current || preferencesLock.current || !prefs || saving || loading || retry || conflict) return;
    summaryLock.current = true; setSummaryLoading(true); setSummaryError(''); setSummary(null);
    const epoch = generation.current, session = client.sessionGeneration;
    try {
      const value = await client.get<Summary>('/me/notification-preferences/summary');
      if (current(epoch, session)) setSummary(value);
    } catch (cause) { if (current(epoch, session)) setSummaryError(describeError(cause).message); }
    finally { if (epoch === generation.current) summaryLock.current = false; if (current(epoch, session)) setSummaryLoading(false); }
  }
  const disabled = !draft || loading;
  return <section className="card stack notification-preferences" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>通知偏好</h2>
    <p className="hint">只調整提醒方式，不會刪除通知、聊天歷史或標記已讀。權限、安全與交易通知不會被一般社群偏好停用。</p>
    {loading && <p role="status">載入通知設定…</p>}
    {error && <div className="banner banner-error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    {!prefs && !loading && <button type="button" className="btn btn-secondary btn-small" onClick={() => void loadPreferences()}>重新載入設定</button>}
    {conflict && <button type="button" className="btn btn-secondary btn-small" disabled={loading || saving} onClick={() => void loadPreferences(true)}>重新載入最新版本，保留輸入</button>}
    {draft && prefs && <form noValidate className="stack" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={disabled} className="notification-preferences-group">
        <legend>社群提醒方式</legend>
        <div className="notification-preferences-grid">{prefs.supported_categories.filter(category => category !== 'following' || followingEnabled).map(category => <label className="field" key={category}>{categories[category]}<select value={draft.categories[category]} onChange={event => edit(value => ({ ...value, categories: { ...value.categories, [category]: event.target.value as Mode } }))}>{Object.entries(modes).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}</select></label>)}</div>
        <p className="hint">站內摘要可在下方預覽；不提醒仍保留原本收件匣。原生內容回覆提醒尚未支援。</p>
      </fieldset>
      <fieldset disabled={disabled} className="notification-preferences-group">
        <legend>安靜時段</legend>
        <label className="checkbox-row"><input type="checkbox" checked={draft.quiet_hours.enabled} onChange={event => edit(value => ({ ...value, quiet_hours: { ...value.quiet_hours, enabled: event.target.checked } }))}/>啟用安靜時段</label>
        <div className="notification-preferences-grid"><label className="field">時區（IANA）<input required value={draft.quiet_hours.time_zone} placeholder="Asia/Taipei" onChange={event => edit(value => ({ ...value, quiet_hours: { ...value.quiet_hours, time_zone: event.target.value } }))}/></label><label className="field">開始時間<input required type="time" value={draft.quiet_hours.start} onChange={event => edit(value => ({ ...value, quiet_hours: { ...value.quiet_hours, start: event.target.value } }))}/></label><label className="field">結束時間<input required type="time" value={draft.quiet_hours.end} onChange={event => edit(value => ({ ...value, quiet_hours: { ...value.quiet_hours, end: event.target.value } }))}/></label></div>
        <p className="hint">以指定時區的當地時間計算，包含日光節約時間。{draft.quiet_hours.start > draft.quiet_hours.end ? '目前時段跨午夜，至隔日結束。' : '開始時間包含在內，結束時間不包含。'}只暫停一般即時提醒，不改收件匣或摘要。</p>
      </fieldset>
      <fieldset disabled={disabled} className="notification-preferences-group">
        <legend>頻道靜音（{draft.muted_channel_ids.length}/50）</legend>
        <p className="hint">只列出目前可存取的頻道。靜音僅停止提醒，不會刪除訊息、標已讀或改變成員資格；儲存時會重新確認存取權。</p>
        <label className="field">頻道類型<select value={kind} disabled={channelLoading} onChange={event => { if (!channelLock.current) setKind(event.target.value as ChannelKind); }}>{Object.entries(channelKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="notification-preferences-channels">{channels.map(channel => <label className="checkbox-row" key={channelId(channel)}><input type="checkbox" checked={draft.muted_channel_ids.includes(channelId(channel))} disabled={!draft.muted_channel_ids.includes(channelId(channel)) && draft.muted_channel_ids.length >= 50} onChange={event => edit(value => ({ ...value, muted_channel_ids: event.target.checked ? [...value.muted_channel_ids, channelId(channel)] : value.muted_channel_ids.filter(key => key !== channelId(channel)) }))}/><span>{channel.name}（{channelKinds[channel.kind]}）</span></label>)}</div>
        {channelLoading && <p role="status">載入可存取頻道…</p>}
        {channelError && <div role="alert"><p>{channelError}</p><button type="button" className="btn btn-secondary btn-small" disabled={channelLoading} onClick={() => void loadChannels(channels.length ? nextOffset ?? 0 : 0, channels.length > 0)}>重試載入頻道</button></div>}
        {!channelLoading && !channelError && channels.length === 0 && <p className="hint">目前沒有可存取的{channelKinds[kind]}頻道。</p>}
        {nextOffset !== null && <button type="button" className="btn btn-secondary btn-small" disabled={channelLoading} onClick={() => void loadChannels(nextOffset, true)}>載入更多{channelKinds[kind]}頻道</button>}
        {draft.muted_channel_ids.length > 0 && <details><summary>檢視所有已選靜音頻道</summary><ul className="notification-preferences-muted">{draft.muted_channel_ids.map(key => <li key={key}><span>{channels.find(channel => channelId(channel) === key)?.name ?? key}</span><button type="button" className="btn btn-secondary btn-small" aria-label={`取消靜音 ${channels.find(channel => channelId(channel) === key)?.name ?? key}`} onClick={() => edit(value => ({ ...value, muted_channel_ids: value.muted_channel_ids.filter(item => item !== key) }))}>取消靜音</button></li>)}</ul><p className="hint">未出現在目前頁面的頻道以識別碼顯示；若已失去資格，可先移除再儲存。</p></details>}
      </fieldset>
      <fieldset disabled className="notification-preferences-group"><legend>Email 摘要</legend><label className="checkbox-row"><input type="checkbox" checked={false} readOnly/>未啟用／預設未訂閱</label><p className="hint">尚缺獲授權的摘要寄送環境與政策；站內預覽不會寄出 Email。{prefs.email_digest.reason}</p></fieldset>
      <div className="actions"><button type="submit" className="btn btn-primary btn-small" disabled={disabled || saving || conflict || summaryLoading}>{saving ? '儲存中…' : retry ? '重試同一筆儲存' : '儲存通知偏好'}</button><span className="hint">設定版本 {prefs.version}</span></div>
    </form>}
    <section className="stack" aria-labelledby={`${id}-summary`}><h3 id={`${id}-summary`}>即時站內摘要預覽</h3><p className="hint">使用已儲存設定與目前仍可存取的來源，不使用未儲存輸入，不寄 Email，也不標記已讀。</p><div className="actions"><button type="button" className="btn btn-secondary btn-small" disabled={!prefs || loading || saving || retry || conflict || summaryLoading} onClick={() => void preview()}>{summaryLoading ? '讀取摘要…' : '預覽目前摘要'}</button></div>{summaryError && <p role="alert">{summaryError}</p>}{summary && <><p className="hint">產生時間：{new Date(summary.generated_at).toLocaleString('zh-TW')} · Email 未啟用</p>{summary.items.length === 0 ? <p className="empty">目前沒有符合已儲存偏好的摘要項目。</p> : <ul className="notification-preferences-summary">{summary.items.map(item => <li key={`${item.source}:${item.id}`}>{summaryHref(item.path) ? <a href={summaryHref(item.path)}>{item.title}</a> : item.title}</li>)}</ul>}</>}</section>
  </section>;
}
