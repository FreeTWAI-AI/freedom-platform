import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, type PortalClient } from '../api';
import { MemberAvatar, type AvatarMetadata } from './MemberAvatar';
import { uploadMemberAvatar } from './avatar-client';
import './MemberAvatar.css';

const MAX_BYTES = 2 * 1024 * 1024;
const formats = ['image/jpeg', 'image/png', 'image/webp'];
export function AvatarEditor({ client, nickname, initial, onSaved }: { client: PortalClient; nickname: string; initial: AvatarMetadata; onSaved: (value: AvatarMetadata) => void }) {
  const [saved, setSaved] = useState(initial), [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const input = useRef<HTMLInputElement>(null), pending = useRef(false), selection = useRef(0);
  const retry = useRef<{ file: File | null; version: number; key: string } | null>(null);
  const helpId = useId();
  useEffect(() => { setSaved(initial); }, [initial]);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  function clearDraft() { selection.current++; setFile(null); retry.current = null; if (input.current) input.current.value = ''; }
  async function choose(next?: File) {
    const generation = ++selection.current;
    setFile(null); setNotice(''); setError(''); retry.current = null;
    if (!next) return;
    if (!formats.includes(next.type)) { setError('請選擇 JPEG、PNG 或 WebP 圖片。'); return; }
    if (next.size === 0 || next.size > MAX_BYTES) { setError('圖片需為 2 MB 以下的檔案。'); return; }
    try {
      const bytes = new Uint8Array(await next.slice(0, 12).arrayBuffer());
      const matches = next.type === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
        : next.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
      if (generation !== selection.current) return;
      if (!matches) { setError('圖片內容與格式不符，請換一張圖片。'); return; }
      setFile(next);
    } catch { if (generation === selection.current) setError('無法讀取圖片，請重新選擇。'); }
  }
  async function mutate(remove = false) {
    if (pending.current || needsRefresh || (!remove && !file)) return;
    const selected = remove ? null : file;
    const operation = retry.current?.file === selected && retry.current.version === saved.aggregate_version
      ? retry.current : { file: selected, version: saved.aggregate_version, key: crypto.randomUUID() };
    retry.current = operation; pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = selected ? await uploadMemberAvatar(client, selected, operation.version, operation.key)
        : await client.post<AvatarMetadata>('/me/avatar/remove', {}, { ifMatch: operation.version, idempotencyKey: operation.key });
      // A replay returns the historical receipt, not necessarily the current
      // image. Confirm the latest revision before updating any visible card.
      clearDraft(); setNeedsRefresh(true);
      await confirmCurrent(result, remove);
    } catch (cause) {
      if (!(cause instanceof ApiError) || !cause.network) retry.current = null;
      if (cause instanceof ApiError && cause.conflict) {
        try {
          const latest = await client.get<AvatarMetadata>('/me/avatar'); setSaved(latest); onSaved(latest);
          setError('頭像已在其他視窗更新。已讀取最新版本，確認後可再次保存或移除。');
        } catch { setError('頭像資料已更新，請重新載入頁面後再操作。'); }
      } else setError(cause instanceof Error ? cause.message : '頭像未能保存，請稍後再試。');
    } finally { pending.current = false; setBusy(false); }
  }
  async function confirmCurrent(receipt?: AvatarMetadata, remove = false) {
    try {
      const current = await client.get<AvatarMetadata>('/me/avatar');
      setSaved(current); setNeedsRefresh(false); onSaved(current);
      window.dispatchEvent(new Event('freedom-profile-updated'));
      const changed = receipt && (current.aggregate_version !== receipt.aggregate_version || current.avatar_url !== receipt.avatar_url);
      setNotice(changed ? '頭像已在其他視窗更新，這裡顯示的是目前版本。' : !receipt ? '已重新確認目前頭像。' : remove ? '頭像已移除。' : '頭像已保存，工坊夥伴現在可以看見。');
    } catch {
      setNeedsRefresh(true); setNotice('');
      setError('操作已完成，但目前頭像暫時讀取失敗。請重新確認頭像。');
    }
  }
  async function refreshCurrent() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await confirmCurrent(); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="card avatar-editor" aria-labelledby={`${helpId}-title`}>
    <div className="avatar-editor-preview">
      {needsRefresh ? <span>等待確認</span> : preview ? <img src={preview} alt="頭像預覽" width="256" height="256" onLoad={event => {
        if (event.currentTarget.naturalWidth > 4096 || event.currentTarget.naturalHeight > 4096) { clearDraft(); setError('圖片長寬各需在 4096 像素以內。'); }
      }} onError={() => { clearDraft(); setError('無法讀取圖片，請換一張完整的圖片。'); }}/>
        : <MemberAvatar nickname={nickname} avatarUrl={saved.avatar_url}/>}
      <span>{needsRefresh ? '頭像狀態待確認' : preview ? '尚未保存的預覽' : '目前頭像'}</span>
    </div>
    <div className="avatar-editor-content">
      <h3 id={`${helpId}-title`}>我的頭像</h3>
      <p id={helpId}>JPEG、PNG 或 WebP，2 MB 以下；長寬各不超過 4096 像素，僅限靜態圖片。保存時會裁成正方形。</p>
      <p>同一工坊內已登入、完成定位的會員可以看見你的頭像。</p>
      <label className="field avatar-file-field">選擇頭像<input ref={input} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || needsRefresh} aria-describedby={helpId} onChange={event => void choose(event.currentTarget.files?.[0])}/></label>
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={busy || needsRefresh || !file} onClick={() => void mutate()}>{busy ? '處理中…' : '保存頭像'}</button>
        {file && <button type="button" className="btn btn-ghost" disabled={busy} onClick={clearDraft}>取消預覽</button>}
        {saved.avatar_url && !file && !needsRefresh && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void mutate(true)}>移除頭像</button>}
        {needsRefresh && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void refreshCurrent()}>重新確認頭像</button>}
      </div>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {notice && <p className="banner status-note" role="status">{notice}</p>}
    </div>
  </section>;
}
