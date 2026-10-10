import { useCallback, useEffect, useRef, useState } from 'react';
import type { PortalClient } from '../api';
import { ApiError } from '../api';
import { imageOrientation, uploadHighlightImage } from './highlight-media';
import {EventOutcomes} from './EventOutcomes';
import './EventHighlights.css';

type Mode = 'online' | 'in_person' | 'hybrid';
type Filter = 'all' | 'online' | 'in_person';
type Cover = { kind: 'banner' | 'poster' | 'photo' | 'youtube'; url: string } | null;
type Card = {
  event_id: string; title: string; starts_at: string; ends_at: string; mode: Mode; event_kind: string;
  organizer_name: string; attending_count: number; public_path: string; cover: Cover;
  counts: { links: number; photos: number; posters: number };
};
type Uploader = { user_id: string; display_name: string; avatar_url: string | null };
type Item = {
  media_id: string; kind: 'link' | 'photo' | 'poster'; title: string | null; created_at: string;
  url?: string; platform?: string; thumbnail_url?: string; image_url?: string; thumb_url?: string;
  orientation?: 'landscape' | 'portrait'; uploader: Uploader; uploaded_by_organizer: boolean; can_remove: boolean;
};
type Detail = Card & {
  description: string | null; banner_url: string | null; banner_orientation: 'landscape' | 'portrait' | null;
  items: Item[]; can_upload: boolean;
  visibility:'open'|'referral'|'workshop'|'guild';
  quota: { links: { remaining_for_me: number; remaining_for_event: number }; photos: { remaining_for_me: number; remaining_for_event: number }; posters: { remaining_for_me: number; remaining_for_event: number } };
};
const modeLabel: Record<Mode, string> = { online: '線上', in_person: '實體', hybrid: '線上＋實體' };
const kindLabel: Record<string, string> = { reading_group: '線上讀書會', meetup: '聚會', guild_skill_exchange: '公會技能交流', other: '其他活動' };
const platformLabel: Record<string, string> = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', x: 'X', vimeo: 'Vimeo', google_drive: 'Google 雲端硬碟', google_photos: 'Google 相簿', other: '連結' };
const dayFormat = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function when(starts: string, ends: string) {
  const start = new Date(starts), end = new Date(ends);
  return dayFormat.format(start) === dayFormat.format(end)
    ? `${dayFormat.format(start)} ${timeFormat.format(start)}–${timeFormat.format(end)}`
    : `${dayFormat.format(start)} ${timeFormat.format(start)} – ${dayFormat.format(end)} ${timeFormat.format(end)}`;
}
function eventIdFromHash() {
  const match = /^#highlights\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(window.location.hash);
  return match?.[1] ?? null;
}
function message(error: unknown) { return error instanceof ApiError ? error.message : '這次沒有完成，請再試一次。'; }
function room(quota: Detail['quota'], key: 'links' | 'photos' | 'posters') { return Math.min(quota[key].remaining_for_me, quota[key].remaining_for_event); }

function Cover({ cover, mode, whenLabel }: { cover: Cover; mode: Mode; whenLabel: string }) {
  const [failed, setFailed] = useState(false);
  if (!cover || failed) return <div className="hl-placeholder"><span>{modeLabel[mode]}</span><span>{whenLabel}</span></div>;
  return <img key={cover.url} src={cover.url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export function EventHighlights({ client,outcomesEnabled=false }: { client: PortalClient;outcomesEnabled?:boolean }) {
  const [eventId, setEventId] = useState(eventIdFromHash);
  useEffect(() => {
    const changed = () => setEventId(eventIdFromHash());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return <div className="hl-panel">{eventId ? <HighlightDetail key={eventId} client={client} eventId={eventId} outcomesEnabled={outcomesEnabled}/> : <HighlightList client={client} />}</div>;
}

function HighlightList({ client }: { client: PortalClient }) {
  const [mode, setMode] = useState<Filter>('all');
  const [items, setItems] = useState<Card[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (nextMode: Filter, nextCursor: string | null, append: boolean) => {
    setError(null);
    try {
      const query = new URLSearchParams({ mode: nextMode });
      if (nextCursor) query.set('cursor', nextCursor);
      const page = await client.get<{ items: Card[]; next_cursor: string | null }>(`/event-highlights?${query}`);
      setItems(current => append && current ? [...current, ...page.items] : page.items);
      setCursor(page.next_cursor);
    } catch (err) { if (!append) setItems([]); setError(message(err)); }
  }, [client]);
  useEffect(() => { void load(mode, null, false); }, [load, mode]);
  return <>
    <p className="hl-intro">活動結束後會收進集錦。公開活動可分享給所有人；社群與公會內部活動仍依目前閱讀權限。夥伴可以補上有權分享的摘要、照片、海報和影片連結。</p>
    {error && <p role="alert">{error}</p>}
    <div className="hl-chips" data-guide-anchor="highlights:format" role="group" aria-label="活動形式">
      {([['all', '全部'], ['online', '線上'], ['in_person', '實體']] as const).map(([value, label]) =>
        <button key={value} type="button" className="hl-chip" aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}
    </div>
    {items && items.length === 0 && <p className="hl-empty">還沒有已結束的活動。活動結束後會自動出現在這裡。</p>}
    <div className="hl-grid" data-guide-anchor="highlights:list">
      {items?.map(item => <article className="hl-card" key={item.event_id} aria-label={item.title}>
        <a className="hl-cover" href={`#highlights/${item.event_id}`}><Cover cover={item.cover} mode={item.mode} whenLabel={when(item.starts_at, item.ends_at)} /></a>
        <h2><a href={`#highlights/${item.event_id}`}>{item.title}</a></h2>
        <p>{when(item.starts_at, item.ends_at)}</p>
        <p><span className={`hl-mode hl-mode-${item.mode}`}>{modeLabel[item.mode]}</span> {item.organizer_name}</p>
        <p className="hl-meta">{item.attending_count} 人回覆 Going · 影片 {item.counts.links}・照片 {item.counts.photos}・海報 {item.counts.posters}</p>
        <p><a className="hl-btn" href={`#highlights/${item.event_id}`}>查看集錦</a></p>
      </article>)}
    </div>
    {cursor && <p><button type="button" className="hl-btn" onClick={() => void load(mode, cursor, true)}>載入更多</button></p>}
  </>;
}

function HighlightDetail({ client, eventId,outcomesEnabled }: { client: PortalClient; eventId: string;outcomesEnabled:boolean }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [openCopy, setOpenCopy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [kind, setKind] = useState<'link' | 'photo' | 'poster'>('link');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [copied, setCopied] = useState(false);
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);
  const [outcomeId,setOutcomeId]=useState<string|null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    setError(null); setMissing(false);
    try { setDetail(await client.get<Detail>(`/event-highlights/${eventId}`)); }
    catch (err) { setDetail(null); if (err instanceof ApiError && err.status === 404) setMissing(true); else setError(message(err)); }
  }, [client, eventId]);
  useEffect(() => { void load(); }, [load]);
  const photos = detail?.items.filter(item => item.kind === 'photo') ?? [];
  useEffect(() => {
    const dialog = dialogRef.current;
    if (photoIndex === null || !dialog) return;
    if (!dialog.open) dialog.showModal();
  }, [photoIndex]);
  async function share() {
    if(!detail||!['open','referral'].includes(detail.visibility))return;
    const shareUrl = new URL(detail?.public_path ?? `/highlights/${eventId}`, window.location.origin).href;
    setCopied(false); setManual(false);
    if (navigator.share) {
      try { await navigator.share({ title: detail?.title ?? '自由工坊活動集錦', url: shareUrl }); return; }
      catch (err) { if ((err as Error).name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); }
    catch { setManual(true); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!detail) return;
    setFormError(null); setProgress(null);
    let batch:File[]|null=null,uploaded=0;
    try {
      if (kind === 'link') {
        await client.post(`/event-highlights/${eventId}/links`, { url, ...(title.trim() ? { title: title.trim() } : {}),...(outcomeId?{outcome_id:outcomeId}:{}) }, { idempotencyKey: crypto.randomUUID() });
        setUrl(''); setTitle('');
      } else {
        const files = [...(fileRef.current?.files ?? [])];batch=files;
        if (!files.length) { setFormError('請先選擇圖片。'); return; }
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new ApiError({message:'請選擇 JPEG、PNG 或 WebP 圖片。',status:422});
          setProgress(files.length > 1 ? `正在上傳第 ${index + 1}／${files.length} 張` : null);
          const orientation = await imageOrientation(file);
          await uploadHighlightImage(client, eventId, kind, file, orientation, title, crypto.randomUUID(),outcomeId??undefined);
          uploaded+=1;
        }
        setTitle('');
        if (fileRef.current) fileRef.current.value = '';
      }
      setProgress(null);
      await load();
    } catch (err) {
      setProgress(null);
      setFormError(`${uploaded?`已新增 ${uploaded} 張；成功項目保留，其餘尚未新增。 `:''}${message(err)}`);
      if(batch&&uploaded&&fileRef.current){const remaining=new DataTransfer();for(const file of batch.slice(uploaded))remaining.items.add(file);fileRef.current.files=remaining.files;}
      await load();
    }
  }
  async function remove(item: Item) {
    if (!window.confirm('要移除這個項目嗎？公開頁也會一併拿掉。')) return;
    setFormError(null);
    try { await client.post(`/event-highlights/media/${item.media_id}/remove`, {}, { idempotencyKey: crypto.randomUUID() }); await load(); }
    catch (err) { setFormError(message(err)); }
  }
  if (missing) return <p>找不到這場活動集錦。<a className="hl-btn" href="#highlights">返回活動集錦</a></p>;
  if (!detail) return error ? <p role="alert">{error}</p> : <p>正在整理這場活動。</p>;
  const publiclyReadable=['open','referral'].includes(detail.visibility);
  const shareUrl = new URL(detail.public_path, window.location.origin).href;
  const links = detail.items.filter(item => item.kind === 'link');
  const posters = detail.items.filter(item => item.kind === 'poster');
  const hint = kind === 'link' ? '影片請貼 YouTube、Facebook 等連結，也可以貼相簿或回顧文章。' : kind === 'photo' ? 'JPEG、PNG 或 WebP，10 MiB 以下，可一次選多張。上傳前請確認你有權向所選範圍分享、照片中的人已同意。' : '活動海報或宣傳圖，JPEG、PNG 或 WebP，10 MiB 以下；請保留作者、來源及授權。';
  const currentPhoto = photoIndex === null ? null : photos[photoIndex];
  return <>
    <div className="hl-actions">
      <a className="hl-btn" href="#highlights">返回活動集錦</a>
      <a className="hl-btn" href={`#events/${eventId}`}>活動專頁</a>
      {publiclyReadable&&<><a className="hl-btn" href={detail.public_path} target="_blank" rel="noopener noreferrer">公開頁 ↗</a>
      <button type="button" className="hl-btn" onClick={() => void share()}>分享</button></>}
    </div>
    {publiclyReadable && copied && <p role="status">已複製公開連結。</p>}
    {publiclyReadable && (manual || openCopy) && <p className="hl-copy"><label>請手動複製公開連結。<input readOnly value={shareUrl} aria-label="公開連結" onFocus={event => event.currentTarget.select()} /></label> <button type="button" className="hl-btn" onClick={() => setOpenCopy(value => !value)} hidden>{openCopy ? '收合' : '顯示'}</button></p>}
    <p className="hl-notice">{['open','referral'].includes(detail.visibility)?'公開活動的公開內容可供任何人閱讀；私人成果與草稿不會自動公開。':'這場活動只對符合目前社群或公會權限的會員開放，不提供匿名公開頁。'}</p>
    {error && <p role="alert">{error}</p>}
    <section className="hl-block">
      <h2>{detail.title}</h2>
      <p>{when(detail.starts_at, detail.ends_at)} · <span className={`hl-mode hl-mode-${detail.mode}`}>{modeLabel[detail.mode]}</span> · {kindLabel[detail.event_kind] ?? '其他活動'}</p>
      <p>主辦 {detail.organizer_name} · {detail.attending_count} 人回覆 Going（不代表實際出席）</p>
      <div className={expanded ? undefined : 'hl-clamp'}>{(detail.description ?? '').split(/\n+/).filter(line => line.trim()).map(line => <p key={line}>{line}</p>)}</div>
      <button type="button" className="hl-btn" onClick={() => setExpanded(value => !value)}>{expanded ? '收合' : '展開'}</button>
    </section>
    {outcomesEnabled&&<EventOutcomes client={client} eventId={eventId} onBindingChange={setOutcomeId} onChanged={load}/>}
    <section>
      <h2>海報</h2>
      <div className="hl-posters">
        {detail.banner_url && <div className="hl-frame"><img src={detail.banner_url} alt={`${detail.title} 海報`} /></div>}
        {posters.map(item => <figure key={item.media_id}><div className="hl-frame"><img src={item.image_url} alt={item.title || '海報'} /></div>{item.title && <figcaption>{item.title}</figcaption>}{item.can_remove && <button type="button" className="hl-btn" onClick={() => void remove(item)}>移除</button>}</figure>)}
        {!detail.banner_url && posters.length === 0 && <p className="hl-meta">還沒有海報。</p>}
      </div>
    </section>
    <section>
      <h2>錄影與影片</h2>
      <div className="hl-links">
        {links.map(item => <article className="hl-item" key={item.media_id}>
          {item.thumbnail_url ? <img className="hl-thumb" src={item.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="hl-placeholder">{platformLabel[item.platform ?? 'other']}</div>}
          <p><span className="hl-platform">{platformLabel[item.platform ?? 'other']}</span></p>
          <h3>{item.title || '相關連結'}</h3>
          <p>{item.uploader.display_name} {item.uploaded_by_organizer && <span className="hl-organizer">主辦者</span>}</p>
          <p className="hl-actions"><a className="hl-btn" href={item.url} target="_blank" rel="noopener noreferrer">開啟影片 ↗</a>{item.can_remove && <button type="button" className="hl-btn" onClick={() => void remove(item)}>移除</button>}</p>
        </article>)}
      </div>
    </section>
    <section>
      <h2>活動照片</h2>
      <div className="hl-photos">
        {photos.map((item, index) => <div className="hl-photo" key={item.media_id}>
          <button type="button" className="hl-shot" onClick={event => { openerRef.current = event.currentTarget; setPhotoIndex(index); }}>
            <img src={item.thumb_url} alt={`${item.title || '活動照片'}，${item.uploader.display_name}`} />
          </button>
          {item.can_remove && <button type="button" className="hl-btn" onClick={() => void remove(item)}>移除{item.title ? ` ${item.title}` : '照片'}</button>}
        </div>)}
      </div>
    </section>
    {detail.items.length === 0 && <p>還沒有人補上內容。有閱讀權限的社群會員可以補上有權分享的照片、海報或影片連結。</p>}
    <details className="hl-add">
      <summary>補上照片或影片連結</summary>
      <p className="hl-quota">你還可以新增：連結 {room(detail.quota, 'links')}・照片 {room(detail.quota, 'photos')}・海報 {room(detail.quota, 'posters')}</p>
      <div className="hl-segment" role="group" aria-label="要補上的內容">
        {([['link', '影片連結'], ['photo', '照片'], ['poster', '海報']] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}
      </div>
      <p className="hl-hint">{hint}</p>
      {outcomesEnabled&&<p className="hl-hint">{outcomeId?'新增項目綁定目前選取的精華，沿用精華目前狀態與閱讀範圍；私人草稿不會匿名公開。':'尚未綁定精華：新增項目直接沿用這場活動的閱讀範圍。要保持私人草稿，請先在上方儲存並選取精華。'}</p>}
      <form onSubmit={event => void submit(event)}>
        {kind === 'link' && <label className="hl-field">影片連結<input value={url} onChange={event => setUrl(event.target.value)} type="url" required placeholder="https://" autoComplete="off" /></label>}
        {kind !== 'link' && <label className="hl-field">{kind === 'photo' ? '照片' : '海報'}<input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple={kind === 'photo'} required /></label>}
        <label className="hl-field">標題（選填）<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} /></label>
        {progress && <p role="status">{progress}</p>}
        {formError && <p role="alert">{formError}</p>}
        <button type="submit" className="btn btn-primary hl-btn" disabled={room(detail.quota, kind === 'link' ? 'links' : kind === 'photo' ? 'photos' : 'posters') <= 0 || Boolean(progress)}>送出</button>
      </form>
    </details>
    <dialog ref={dialogRef} className="hl-lightbox" aria-label="活動照片" onClose={() => { setPhotoIndex(null); openerRef.current?.focus(); }} onKeyDown={event => {
      if (event.key === 'ArrowRight' && photoIndex !== null && photoIndex < photos.length - 1) { event.preventDefault(); setPhotoIndex(photoIndex + 1); }
      if (event.key === 'ArrowLeft' && photoIndex !== null && photoIndex > 0) { event.preventDefault(); setPhotoIndex(photoIndex - 1); }
    }}>
      {currentPhoto && <>
        <img src={currentPhoto.image_url} alt={`${currentPhoto.title || '活動照片'}，${currentPhoto.uploader.display_name}`} />
        <p>{currentPhoto.title || '活動照片'}</p>
        <p>{currentPhoto.uploader.display_name}</p>
        <div className="hl-actions">
          <button type="button" className="hl-btn" onClick={() => setPhotoIndex(index => index === null ? index : Math.max(0, index - 1))} disabled={photoIndex === 0}>上一張</button>
          <button type="button" className="hl-btn" onClick={() => setPhotoIndex(index => index === null ? index : Math.min(photos.length - 1, index + 1))} disabled={photoIndex === photos.length - 1}>下一張</button>
          <button type="button" className="hl-btn" onClick={() => dialogRef.current?.close()}>關閉</button>
        </div>
      </>}
    </dialog>
    {publiclyReadable&&<p className="hl-actions"><button type="button" className="hl-btn" onClick={() => setOpenCopy(true)}>顯示公開連結</button></p>}
  </>;
}
