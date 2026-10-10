import {useEffect, useRef, useState, type FormEvent} from 'react';
import {ApiError, type PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import type {SocialPost} from './SocialZone';
import {accessAwareFetch} from '../access-fetch';
import {prepareSocialImage} from './social-image';
import {ChatExtras,ChatSticker} from './ChatContent';
import {MemberAvatar} from './MemberAvatar';
import {SocialIcon,SocialTextTools,SocialRichText,SocialMemberLink,type Mention} from './SocialTools';
import {SocialPostShare} from './SocialPostShare';

type Comment = {image_url?:string|null;sticker_id?:string|null;mentions?:Mention[];like_count?:number;liked?:boolean;comment_id: string; body: string; created_at: string; edited_at: string | null; revision: number; author: {user_id: string; display_name: string}; mine: boolean};
type Comments = {items: Comment[]; next_cursor: string | null};
function mergeComments(current: Comment[], incoming: Comment[]) {
  const all = new Map([...current, ...incoming].map(item => [item.comment_id, item]));
  return [...all.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.comment_id.localeCompare(b.comment_id));
}

export function SocialInteractions({client, post, canHide, onUpdate,onTag}: {onTag?:(tag:string)=>void;client: PortalClient; post: SocialPost; canHide: boolean; onUpdate: (value: Partial<SocialPost>) => void}) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [liking, setLiking] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editing, setEditing] = useState<{id: string; text: string} | null>(null);
  const [mentions,setMentions]=useState<Mention[]>([]),[file,setFile]=useState<File|null>(null),[preview,setPreview]=useState(''),[preparing,setPreparing]=useState(false);
  const input=useRef<HTMLInputElement>(null),imageSeq=useRef(0),root=useRef<HTMLDivElement>(null),mounted=useRef(true);
  const [likePeople,setLikePeople]=useState<Mention[]>([]),[peopleCursor,setPeopleCursor]=useState<string|null>(null),[peopleBusy,setPeopleBusy]=useState(false),[peopleError,setPeopleError]=useState('');
  const peopleDialog=useRef<HTMLDialogElement>(null),peopleTrigger=useRef<HTMLButtonElement>(null),peopleSeq=useRef(0);
  const [commentLiking,setCommentLiking]=useState<string|null>(null),commentLikeCommands=useRef(new Map<string,{liked:boolean;key:string}>());
  type CommentCommand={body:{text?:string;image_id?:string;sticker_id?:string;mention_ids?:string[]};file:File|null;uploadKey:string;key:string};
  const pendingComment = useRef<CommentCommand|null>(null);
  const current=(generation:number)=>mounted.current&&client.sessionGeneration===generation;
  useEffect(()=>()=>{mounted.current=false;++imageSeq.current;++peopleSeq.current;},[]);
  useEffect(()=>{if(!file){setPreview('');return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
  // A visible post must remain at least half visible for one second. List fetches
  // and background tabs do not record reads. Server uniqueness survives reloads.
  useEffect(()=>{
    const element=root.current?.closest('article')?.querySelector('.social-post-header');if(!element)return;
    let timer:ReturnType<typeof setTimeout>|undefined,visible=false,done=false;
    const generation=client.sessionGeneration,key=crypto.randomUUID();
    const schedule=()=>{clearTimeout(timer);if(visible&&!document.hidden&&!done)timer=setTimeout(()=>{if(!current(generation))return;done=true;void client.post<{read_count:number}>(`/social-posts/${post.post_id}/read`,{},{idempotencyKey:key}).then(value=>{if(current(generation))onUpdate(value);}).catch(()=>{done=false;});},1000);};
    const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting&&entries[0].intersectionRatio>=0.5;schedule();},{threshold:[0,0.5]});
    observer.observe(element);document.addEventListener('visibilitychange',schedule);
    return()=>{clearTimeout(timer);observer.disconnect();document.removeEventListener('visibilitychange',schedule);};
  },[client,post.post_id]);
  async function selectImage(next:File|null){const token=++imageSeq.current,generation=client.sessionGeneration;setError('');if(!next){setFile(null);setPreparing(false);return;}setPreparing(true);try{const prepared=await prepareSocialImage(next);if(token===imageSeq.current&&current(generation))setFile(prepared);}catch(e){if(token===imageSeq.current&&current(generation))setError(e instanceof Error?e.message:'圖片無法處理，草稿仍保留。');}finally{if(token===imageSeq.current&&current(generation))setPreparing(false);}}
  async function loadPeople(next?:string){const token=++peopleSeq.current,generation=client.sessionGeneration;setPeopleBusy(true);setPeopleError('');if(!next)setLikePeople([]);try{const page=await client.get<{items:Mention[];next_cursor:string|null}>(`/social-posts/${post.post_id}/likes${next?`?cursor=${encodeURIComponent(next)}`:''}`);if(token===peopleSeq.current&&current(generation)){setLikePeople(old=>next?[...new Map([...old,...page.items].map(m=>[m.user_id,m])).values()]:page.items);setPeopleCursor(page.next_cursor);}}catch(e){if(token===peopleSeq.current&&current(generation))setPeopleError(e instanceof Error?e.message:'按讚名單暫時無法載入。');}finally{if(token===peopleSeq.current&&current(generation))setPeopleBusy(false);}}
  function closePeople(){++peopleSeq.current;peopleDialog.current?.close();peopleTrigger.current?.focus();}
  async function likeComment(comment:Comment){if(commentLiking)return;const generation=client.sessionGeneration;const command=commentLikeCommands.current.get(comment.comment_id)??{liked:!comment.liked,key:crypto.randomUUID()};commentLikeCommands.current.set(comment.comment_id,command);setCommentLiking(comment.comment_id);setError('');try{const value=await client.post<{liked:boolean;like_count:number}>(`/social-posts/${post.post_id}/comments/${comment.comment_id}/like`,{liked:command.liked},{idempotencyKey:command.key});if(!current(generation))return;setComments(rows=>rows.map(row=>row.comment_id===comment.comment_id?{...row,...value}:row));confirmedComments.current=confirmedComments.current.map(row=>row.comment_id===comment.comment_id?{...row,...value}:row);commentLikeCommands.current.delete(comment.comment_id);}catch(e){if(current(generation)){if(e instanceof ApiError&&!e.network)commentLikeCommands.current.delete(comment.comment_id);setError(e instanceof Error?e.message:'尚未確認按讚結果，請重試。');}}finally{if(current(generation))setCommentLiking(null);}}

  const pendingLike = useRef<{liked: boolean; key: string} | null>(null);
  const confirmedComments = useRef<Comment[]>([]);
  const sequence = useRef(0);
  useEffect(() => () => { ++sequence.current; }, []);
  async function load(next?: string) {
    const token = ++sequence.current;
    setLoading(true); setError('');
    try {
      const page = await client.get<Comments>(`/social-posts/${post.post_id}/comments${next ? `?cursor=${encodeURIComponent(next)}` : ''}`);
      if (token !== sequence.current) return;
      const fresh = confirmedComments.current.filter(comment => !page.items.some(item => item.comment_id === comment.comment_id));
      setComments(current => mergeComments(next ? current : fresh, page.items)); setCursor(page.next_cursor);
      confirmedComments.current = fresh;
    } catch (cause) { if (token === sequence.current) setError(cause instanceof Error ? cause.message : '留言暫時無法載入。'); }
    finally { if (token === sequence.current) setLoading(false); }
  }
  async function like() {
    if (liking) return;
    const command = pendingLike.current ?? {liked: !post.liked, key: crypto.randomUUID()};
    pendingLike.current = command; setLiking(true); setError('');
    try {
      const value = await client.post<{liked: boolean; like_count: number}>(`/social-posts/${post.post_id}/like`, {liked: command.liked}, {idempotencyKey: command.key});
      onUpdate(value); pendingLike.current = null;
    } catch (cause) {
      if (cause instanceof ApiError && !cause.network) pendingLike.current = null;
      setError(cause instanceof Error ? cause.message : '尚未確認按讚結果，請重試。');
    } finally { setLiking(false); }
  }
  async function send(event?:FormEvent,stickerId?:string) {
    event?.preventDefault();
    if(sending||preparing)return;
    const generation=client.sessionGeneration;
    const command=pendingComment.current??{body:stickerId?{sticker_id:stickerId}:{text:text.trim(),mention_ids:mentions.map(m=>m.user_id)},file:stickerId?null:file,uploadKey:crypto.randomUUID(),key:crypto.randomUUID()};
    if(!command.body.text&&!command.body.sticker_id&&!command.file)return;
    pendingComment.current=command;setSending(true);setError('');
    try{
      if(command.file&&!command.body.image_id){
        if(!client.csrfToken)throw new Error('登入狀態已變更，請重新登入。');
        const response=await accessAwareFetch(`/api/v1/social-posts/${post.post_id}/comment-images`,{method:'POST',credentials:'same-origin',body:command.file,headers:{'Content-Type':command.file.type,'X-CSRF-Token':client.csrfToken,'Idempotency-Key':command.uploadKey,Accept:'application/json'}});
        if(!current(generation))return;
        const result=await response.json() as {image_id:string;detail?:string;code?:string};
        if(!response.ok)throw new ApiError({message:result.detail??'圖片尚未上傳，請重試。',status:response.status,code:result.code});
        command.body.image_id=result.image_id;
      }
      const created=await client.post<Comment>(`/social-posts/${post.post_id}/comments`,command.body,{idempotencyKey:command.key});
      if(!current(generation))return;
      confirmedComments.current=mergeComments(confirmedComments.current,[created]);
      setComments(rows=>mergeComments(rows,[created]));
      if(!comments.some(item=>item.comment_id===created.comment_id))onUpdate({comment_count:(post.comment_count??0)+1});
      pendingComment.current=null;
      if(!command.body.sticker_id){setText('');setMentions([]);setFile(null);}
    }catch(cause){
      if(!current(generation))return;
      // Uploaded files remain bound to this draft when comment delivery is unknown.
      if(cause instanceof ApiError&&!cause.network&&cause.status<500)pendingComment.current=null;
      setError(cause instanceof Error?cause.message:'尚未確認留言結果，請重試。');
    }finally{if(current(generation))setSending(false);}
  }
  async function remove(comment: Comment) {
    if (sending) return;
    setSending(true); setError('');
    try {
      await client.delete(`/social-posts/${post.post_id}/comments/${comment.comment_id}`, {});
      confirmedComments.current = confirmedComments.current.filter(item => item.comment_id !== comment.comment_id);
      setComments(current => current.filter(item => item.comment_id !== comment.comment_id));
      onUpdate({comment_count: Math.max(0, (post.comment_count ?? 0) - 1)}); setConfirmDelete(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '留言未能刪除。'); }
    finally { setSending(false); }
  }
  async function saveEdit(event: FormEvent, comment: Comment) {
    event.preventDefault();
    if (!editing || sending) return;
    setSending(true); setError('');
    try {
      const saved = await client.post<Comment>(`/social-posts/${post.post_id}/comments/${comment.comment_id}/edit`, {text: editing.text.trim()}, {ifMatch: comment.revision});
      confirmedComments.current = confirmedComments.current.map(item => item.comment_id === saved.comment_id ? saved : item);
      setComments(current => current.map(item => item.comment_id === saved.comment_id ? saved : item));
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 412 ? '這則留言已在別處更新，請重新載入留言後再編輯。' : cause instanceof Error ? cause.message : '留言未能更新。');
    } finally { setSending(false); }
  }
  return <div ref={root} className="social-interactions stack">
    <div className="social-interaction-summary"><button ref={peopleTrigger} type="button" className="social-text-link" aria-label="查看按讚名單" onClick={()=>{peopleDialog.current?.showModal();void loadPeople();}}><SocialIcon name="like"/>{post.like_count??0} 人按讚</button><span title="在前景停留觀看的會員，每人只計一次"><SocialIcon name="eye"/>已讀 {post.read_count??0} 人</span></div>
    <dialog ref={peopleDialog} className="social-publish-dialog social-people-dialog" aria-label="按讚名單" onCancel={e=>{e.preventDefault();closePeople();}}><header className="social-publish-head"><h2>按讚名單</h2><button type="button" className="btn btn-ghost" onClick={closePeople}>關閉名單</button></header>{likePeople.map(member=><p className="social-person" key={member.user_id}><MemberAvatar nickname={member.display_name}/><SocialMemberLink client={client} member={member}/></p>)}{peopleBusy&&<p role="status">載入中…</p>}{!peopleBusy&&!likePeople.length&&!peopleError&&<p>目前沒有可顯示的按讚會員。</p>}{peopleError&&<p role="alert">{peopleError}</p>}{(peopleCursor||peopleError)&&<button type="button" className="btn btn-ghost" disabled={peopleBusy} onClick={()=>void loadPeople(peopleCursor??undefined)}>{peopleError?'重試':'更多按讚會員'}</button>}</dialog>
    <div className="social-actions">
      <button type="button" className="btn btn-ghost" aria-pressed={post.liked ?? false} disabled={liking} onClick={() => void like()}><SocialIcon name="like"/>{liking ? '處理中…' : pendingLike.current ? '重試按讚' : post.liked ? '已讚' : '讚'} · {post.like_count ?? 0}</button>
      <button type="button" className="btn btn-ghost" aria-expanded={open} aria-controls={`social-comments-${post.post_id}`} onClick={() => { setOpen(!open); if (!open) void load(); else { ++sequence.current; setLoading(false); } }}><SocialIcon name="comment"/>留言 · {post.comment_count ?? 0}</button>
      <SocialPostShare client={client} post={post}/>
    </div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {open && <section id={`social-comments-${post.post_id}`} className="social-comments stack" aria-label="貼文留言">
      {loading && <p role="status">正在載入留言…</p>}
      {!loading && comments.length === 0 && <p className="muted">還沒有留言，聊聊你的想法。</p>}
      {comments.map(comment => <article className="social-comment" key={comment.comment_id}>
        <div className="social-comment-meta"><MemberAvatar nickname={comment.author.display_name}/><strong>{comment.author.display_name}</strong><time dateTime={comment.created_at}>{formatIsoLocal(comment.created_at)}</time>{comment.edited_at && <span className="social-edited" title={formatIsoLocal(comment.edited_at)}>已編輯</span>}</div>
        {editing?.id === comment.comment_id ? <form className="stack" onSubmit={event => void saveEdit(event, comment)} aria-busy={sending}>
          <label className="field">編輯留言<textarea aria-label="編輯留言" required rows={2} maxLength={1000} value={editing.text} disabled={sending} onChange={event => setEditing({id: comment.comment_id, text: event.target.value})}/></label>
          <div className="social-actions"><button className="btn btn-ghost" disabled={sending || !editing.text.trim() || editing.text.trim() === comment.body}>{sending ? '儲存中…' : '儲存留言'}</button><button type="button" className="btn btn-ghost" disabled={sending} onClick={() => setEditing(null)}>取消</button></div>
        </form> : <div className="social-comment-bubble">{comment.body!=='[圖片]'&&comment.body!=='[貼圖]'&&<p className="multiline-text"><SocialRichText client={client} text={comment.body} mentions={comment.mentions} onTag={onTag}/></p>}{comment.sticker_id&&<ChatSticker id={comment.sticker_id}/>} {comment.image_url&&<a href={comment.image_url} target="_blank" rel="noopener noreferrer" aria-label="開啟留言圖片"><img className="social-comment-image" src={comment.image_url} alt="留言附圖" loading="lazy"/></a>}</div>}
        <div className="social-comment-actions"><button className="social-text-link" type="button" aria-label={`${comment.liked?'留言已讚':'留言讚'} · ${comment.like_count??0}`} aria-pressed={comment.liked??false} disabled={!!commentLiking} onClick={()=>void likeComment(comment)}>{commentLikeCommands.current.has(comment.comment_id)?'重試按讚':comment.liked?'已讚':'讚'}{(comment.like_count??0)>0&&` · ${comment.like_count}`}</button></div>
        {(comment.mine || canHide) && editing?.id !== comment.comment_id && <details className="social-post-menu social-comment-menu"><summary aria-label="留言選項">⋯</summary><div className="social-post-menu-actions">{confirmDelete === comment.comment_id ? <>
          <button type="button" className="btn btn-ghost" disabled={sending} onClick={() => void remove(comment)}>確定刪除留言</button><button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>取消</button>
        </> : <>{comment.mine && <button type="button" className="btn btn-ghost" disabled={sending} onClick={() => { setConfirmDelete(null); setEditing({id: comment.comment_id, text: comment.body}); }}>編輯留言</button>}<button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(comment.comment_id)}>刪除留言</button></>}</div></details>}
      </article>)}
      {cursor && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void load(cursor)}>載入更多留言</button>}
      {error && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void load()}>重新載入留言</button>}
      <form className="social-comment-composer" onSubmit={event=>void send(event)} aria-busy={sending||preparing}>
        <label className="field"><span className="sr-only">寫留言</span><textarea aria-label="寫留言" rows={2} maxLength={1000} value={text} disabled={sending||!!pendingComment.current} onChange={event=>setText(event.target.value)} onPaste={event=>{const pasted=[...event.clipboardData.files].find(f=>f.type.startsWith('image/'));if(pasted&&!sending&&!pendingComment.current){event.preventDefault();void selectImage(pasted);}}} placeholder="留下你的想法，輸入 @ 標註夥伴…"/></label>
        {preview&&<div className="social-compose-attachment"><img className="social-compose-preview" src={preview} alt="留言圖片預覽"/><button type="button" className="social-text-link" disabled={sending||!!pendingComment.current} onClick={()=>void selectImage(null)}>移除留言圖片</button></div>}
        {preparing&&<p role="status">正在處理圖片…</p>}
        <div className="social-comment-toolbar"><input ref={input} className="sr-only" tabIndex={-1} type="file" accept="image/jpeg,image/png,image/webp" aria-label="留言圖片" disabled={sending||preparing||!!pendingComment.current} onChange={event=>{void selectImage(event.target.files?.[0]??null);event.target.value='';}}/>
          <button className="social-icon-button" type="button" aria-label="上傳留言照片" title="上傳留言照片" disabled={sending||preparing||!!pendingComment.current} onClick={()=>input.current?.click()}><SocialIcon name="camera"/></button>
          <SocialTextTools client={client} text={text} onChange={setText} mentions={mentions} onMentions={setMentions} disabled={sending||!!pendingComment.current}/>
          <ChatExtras draft={{}} onChange={()=>{}} onSendSticker={id=>void send(undefined,id)} disabled={sending||preparing||!!pendingComment.current} target={post.post_id}/>
          <button className="social-icon-button social-comment-send" aria-label={sending?'傳送中…':pendingComment.current?'重試留言':'送出留言'} title={pendingComment.current?'重試留言':'送出留言'} disabled={sending||preparing||(!pendingComment.current&&!text.trim()&&!file)}><SocialIcon name="send"/></button>
        </div>
      </form>
    </section>}
  </div>;
}
