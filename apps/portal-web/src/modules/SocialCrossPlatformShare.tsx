import {useEffect,useId,useRef,useState,useSyncExternalStore} from 'react';
import type {PortalClient} from '../api';
import {useLanguage,type InterfaceLanguage} from '../language';
import {SHARE_LABELS,SHARE_PLATFORMS,socialShareForSession,socialShareUrl,type ShareFault,type SharePlatform,type SocialShareSession} from '../social-share';
import './SocialCrossPlatformShare.css';

// Deferred with the feature; user-authored captions and filenames remain verbatim.
const messages={
  title:['多平台分享','Share to platforms','複数のサービスに共有','여러 플랫폼에 공유','Compartir en plataformas'],
  collapse:['收合','Collapse','閉じる','접기','Contraer'],
  riskTitle:['開啟前，先了解帳號風險','Before enabling, understand the account risk','有効にする前に、アカウントのリスクをご確認ください','사용 전 계정 위험을 확인하세요','Antes de activar, conoce el riesgo para tu cuenta'],
  risk:['各平台可能依內容、發布頻率與操作判定限制帳號或停權。最後仍由你在各平台確認發布，提醒無法保證帳號不被限制。','Platforms may restrict or suspend accounts based on content, posting frequency and activity. You confirm each post on its platform; this notice cannot guarantee your account will avoid restrictions.','各サービスは内容、投稿頻度、操作によりアカウントを制限・停止する場合があります。各サービスでご自身が投稿を確定します。この案内は制限を防ぐ保証ではありません。','플랫폼은 콘텐츠, 게시 빈도 및 활동에 따라 계정을 제한하거나 정지할 수 있습니다. 각 플랫폼에서 직접 게시를 확인하며, 이 안내가 계정 제한을 방지하지는 않습니다.','Las plataformas pueden restringir o suspender cuentas según el contenido, la frecuencia y la actividad. Tú confirmas cada publicación en su plataforma; este aviso no garantiza evitar restricciones.'],
  privacy:['不連結社群帳號。文案、素材與進度只保留在這次登入的記憶中。','No social account connection. Copy, media and progress stay in memory for this login.','SNSアカウントの連携は不要です。文章、素材、進捗は今回のログイン中のメモリにのみ保持します。','소셜 계정 연결 없이 문안, 미디어 및 진행 상황은 이번 로그인 동안 메모리에만 보관됩니다.','Sin conectar cuentas sociales. El texto, los archivos y el progreso se guardan en memoria durante esta sesión.'],
  enable:['了解並開啟','Understand and enable','確認して有効にする','이해하고 사용하기','Entendido, activar'],
  cancel:['先不要','Not now','今はしない','나중에','Ahora no'],
  disable:['關閉功能','Disable','無効にする','기능 끄기','Desactivar'],
  choose:['選擇分享平台','Choose platforms','共有先を選ぶ','공유 플랫폼 선택','Elegir plataformas'],
  selected:['已選 {count} 個平台','{count} platforms selected','{count}件選択中','플랫폼 {count}개 선택','{count} plataformas seleccionadas'],
  instructions:['選平台 → 準備內容 → 逐站確認發布','Choose → Prepare → Confirm on each platform','選択 → 準備 → 各サービスで投稿を確定','선택 → 준비 → 플랫폼마다 게시 확인','Elegir → Preparar → Confirmar en cada plataforma'],
  media:['加入照片或影片','Add photos or video','写真・動画を追加','사진 또는 동영상 추가','Añadir fotos o video'],
  mediaLabel:['分享素材','Media to share','共有する素材','공유 미디어','Archivos para compartir'],
  mediaHint:['最多 4 張 JPG／PNG（每張 10 MB），或 1 部 MP4（50 MB）。Instagram 需要素材。','Up to 4 JPG/PNG images (10 MB each), or 1 MP4 (50 MB). Instagram needs media.','JPG/PNGは4枚まで（各10 MB）、またはMP4を1本（50 MB）。Instagramには素材が必要です。','JPG/PNG 최대 4장(각 10 MB) 또는 MP4 1개(50 MB). Instagram에는 미디어가 필요합니다.','Hasta 4 imágenes JPG/PNG (10 MB cada una), o 1 MP4 (50 MB). Instagram necesita archivos.'],
  remove:['移除 {name}','Remove {name}','{name}を削除','{name} 삭제','Eliminar {name}'],
  checking:['正在檢查素材…','Checking media…','素材を確認中…','미디어 확인 중…','Revisando archivos…'],
  prepare:['準備分享','Prepare sharing','共有を準備','공유 준비','Preparar'],
  reprepare:['使用目前內容重新準備','Prepare current content again','現在の内容で準備し直す','현재 내용으로 다시 준비','Preparar el contenido actual'],
  changed:['文案、平台或素材已變更。重新準備前，以下仍使用先前內容；已發布的貼文不會跟著修改。','Copy, platforms or media changed. The steps below still use the prepared version until you prepare again; existing posts are not edited.','文章、共有先、素材が変更されています。再準備するまで以下は前の内容を使用します。投稿済みの内容は変更されません。','문안, 플랫폼 또는 미디어가 변경되었습니다. 다시 준비하기 전까지 아래 단계는 이전 내용을 사용하며, 기존 게시물은 수정되지 않습니다.','Cambió el texto, las plataformas o los archivos. Los pasos siguen usando la versión preparada hasta que prepares de nuevo; las publicaciones existentes no se editan.'],
  copy:['複製文案','Copy caption','文章をコピー','문안 복사','Copiar texto'],
  copying:['複製中…','Copying…','コピー中…','복사 중…','Copiando…'],
  caption:['分享文案','Prepared caption','共有する文章','준비된 문안','Texto preparado'],
  restore:['帶回目前草稿','Restore to editor','編集欄に戻す','편집기로 복원','Restaurar en el editor'],
  download:['下載 {name}','Download {name}','{name}をダウンロード','{name} 다운로드','Descargar {name}'],
  progress:['本人確認完成 {done}/{total}','Self-confirmed {done}/{total}','本人確認済み {done}/{total}','직접 확인한 완료 {done}/{total}','Confirmado por ti {done}/{total}'],
  ready:['待操作','Ready','準備完了','준비됨','Preparado'],
  requested:['已請求開啟','Open requested','表示をリクエスト済み','열기 요청됨','Apertura solicitada'],
  handed:['系統分享已交接','Handed to system share','システム共有に引き渡し済み','시스템 공유로 전달됨','Entregado al sistema'],
  confirmed:['本人已確認','Self-confirmed','本人確認済み','직접 확인함','Confirmado por ti'],
  open:['開啟 {platform} ↗','Open {platform} ↗','{platform}を開く ↗','{platform} 열기 ↗','Abrir {platform} ↗'],
  prefill:['文字會帶入發布畫面；素材請在該平台加入，並檢查字數與格式。','Text goes into the composer. Add media there and check its text and format limits.','投稿画面に文章が入力されます。素材を追加し、文字数と形式を確認してください。','게시 화면에 문안이 입력됩니다. 해당 플랫폼에서 미디어를 추가하고 글자 수와 형식을 확인하세요.','El texto se añade al editor. Agrega los archivos allí y revisa los límites de texto y formato.'],
  manual:['複製文案、儲存素材後，開啟平台貼上並發布。','Copy the caption and save media, then open the platform to paste and publish.','文章をコピーして素材を保存した後、共有先で貼り付けて投稿してください。','문안을 복사하고 미디어를 저장한 다음 플랫폼에서 붙여 넣고 게시하세요.','Copia el texto y guarda los archivos; luego abre la plataforma para pegar y publicar.'],
  systemShare:['分享素材（請選 {platform}）','Share media (choose {platform})','素材を共有（{platform}を選択）','미디어 공유({platform} 선택)','Compartir archivos (elige {platform})'],
  sharing:['等待系統分享…','Waiting for system share…','システム共有を待っています…','시스템 공유 대기 중…','Esperando al sistema…'],
  systemHint:['分享選單由你的裝置提供；本頁無法得知你選了哪個 App 或是否發布成功。','Your device provides the share sheet. This page cannot know the chosen app or whether you published.','共有メニューは端末が提供します。このページでは選んだアプリや投稿の成否は分かりません。','공유 메뉴는 기기에서 제공하며, 이 페이지는 선택한 앱이나 게시 성공 여부를 알 수 없습니다.','Tu dispositivo ofrece el menú. Esta página no sabe qué app elegiste ni si publicaste.'],
  fallback:['此裝置未提供素材分享。可下載素材，再到平台加入。','Media sharing is unavailable here. Download media and add it on the platform.','この端末では素材共有を利用できません。保存して共有先で追加してください。','이 기기에서는 미디어 공유를 사용할 수 없습니다. 다운로드한 뒤 플랫폼에서 추가하세요.','Aquí no está disponible compartir archivos. Descárgalos y agrégalos en la plataforma.'],
  complete:['我已完成發布','I have published','投稿を完了しました','게시를 완료했어요','Ya publiqué'],
  truth:['此進度由你確認，不代表平台已回報發布成功。','Progress is your confirmation, not a publication receipt from the platform.','これはご自身の確認記録であり、共有先からの投稿完了通知ではありません。','진행 상황은 직접 확인한 기록이며, 플랫폼의 게시 성공 응답이 아닙니다.','Este progreso es tu confirmación, no un comprobante de publicación de la plataforma.'],
  allDone:['你已確認所有選擇的平台。可以收合，或繼續編輯草稿。','You confirmed every selected platform. Collapse this panel or keep editing.','選んだ共有先をすべて確認しました。閉じるか、編集を続けられます。','선택한 모든 플랫폼을 확인했습니다. 접거나 편집을 계속할 수 있습니다.','Confirmaste todas las plataformas elegidas. Puedes contraer el panel o seguir editando.'],
  enabled:['已開啟，請點選平台 Logo。','Enabled. Select platform logos.','有効にしました。共有先のロゴを選んでください。','사용 설정됨. 플랫폼 로고를 선택하세요.','Activado. Elige los logos de las plataformas.'],
  disabled:['功能已關閉，草稿與這次的準備內容仍保留。','Disabled. Your draft and prepared content are retained for this login.','無効にしました。今回の下書きと準備内容は保持されます。','기능을 껐습니다. 이번 로그인의 초안과 준비 내용은 유지됩니다.','Desactivado. Se conservan el borrador y el contenido preparado durante esta sesión.'],
  filesAdded:['素材已加入。','Media added.','素材を追加しました。','미디어 추가됨.','Archivos añadidos.'],
  fileRemoved:['素材已移除。','Media removed.','素材を削除しました。','미디어 삭제됨.','Archivo eliminado.'],
  prepared:['內容已準備，請逐站確認發布。','Prepared. Confirm publishing on each platform.','準備しました。各サービスで投稿を確定してください。','준비 완료. 각 플랫폼에서 게시를 확인하세요.','Preparado. Confirma la publicación en cada plataforma.'],
  copied:['文案已複製。','Caption copied.','文章をコピーしました。','문안 복사됨.','Texto copiado.'],
  opened:['已請求開啟平台。完成發布後，回來確認進度。','Opening requested. Return to confirm progress after publishing.','表示をリクエストしました。投稿後に戻って進捗を確認してください。','플랫폼 열기를 요청했습니다. 게시 후 돌아와 진행 상황을 확인하세요.','Apertura solicitada. Vuelve para confirmar el progreso después de publicar.'],
  shared:['已交給系統分享，目的地與發布結果尚未確認。','Handed to system share. Destination and publication are unconfirmed.','システム共有に引き渡しました。共有先と投稿結果は未確認です。','시스템 공유로 전달했습니다. 목적지와 게시 결과는 확인되지 않았습니다.','Entregado al sistema. El destino y la publicación no están confirmados.'],
  session:['登入狀態已變更，請重新開啟發文器。','Your login changed. Reopen the composer.','ログイン状態が変わりました。投稿画面を開き直してください。','로그인 상태가 변경되었습니다. 게시 작성기를 다시 여세요.','Cambió tu sesión. Vuelve a abrir el editor.'],
  platforms:['請至少選一個平台。','Choose at least one platform.','共有先を1件以上選んでください。','플랫폼을 하나 이상 선택하세요.','Elige al menos una plataforma.'],
  empty:['請先寫文案或加入素材。','Write a caption or add media first.','文章を入力するか素材を追加してください。','문안을 작성하거나 미디어를 추가하세요.','Escribe un texto o añade archivos.'],
  instagramMedia:['Instagram 需要照片或影片，請加入素材或取消勾選 Instagram。','Instagram needs photos or video. Add media or deselect Instagram.','Instagramには写真・動画が必要です。追加するかInstagramの選択を解除してください。','Instagram에는 사진이나 동영상이 필요합니다. 미디어를 추가하거나 선택을 해제하세요.','Instagram necesita fotos o video. Añade archivos o desmarca Instagram.'],
  type:['請選擇 JPG、PNG 或 MP4 檔案。','Choose JPG, PNG or MP4 files.','JPG、PNG、MP4を選んでください。','JPG, PNG 또는 MP4 파일을 선택하세요.','Elige archivos JPG, PNG o MP4.'],
  size:['照片需在 10 MB 內、影片需在 50 MB 內，且不可為空檔案。','Images must be at most 10 MB and videos 50 MB; empty files are not allowed.','写真は10 MB以下、動画は50 MB以下です。空のファイルは選べません。','사진은 10 MB 이하, 동영상은 50 MB 이하이며 빈 파일은 허용되지 않습니다.','Las imágenes deben pesar hasta 10 MB y los videos 50 MB; no se permiten archivos vacíos.'],
  mixed:['照片與影片請分開準備。原本的素材已保留。','Prepare images and video separately. Your previous media is retained.','写真と動画は別々に準備してください。前の素材は保持されています。','사진과 동영상은 따로 준비하세요. 이전 미디어는 유지됩니다.','Prepara imágenes y video por separado. Se conservan los archivos anteriores.'],
  count:['最多選 4 張照片，或 1 部影片。','Choose up to 4 images or 1 video.','写真は4枚まで、または動画を1本選んでください。','사진 최대 4장 또는 동영상 1개를 선택하세요.','Elige hasta 4 imágenes o 1 video.'],
  signature:['檔案內容不符合格式，請換一個檔案。原本素材已保留。','File contents do not match the format. Choose another file; previous media is retained.','ファイル内容が形式と一致しません。別のファイルを選んでください。前の素材は保持されています。','파일 내용이 형식과 일치하지 않습니다. 다른 파일을 선택하세요. 이전 미디어는 유지됩니다.','El contenido no coincide con el formato. Elige otro archivo; se conservan los anteriores.'],
  read:['無法讀取素材，請重新選取。原本素材已保留。','Media could not be read. Select it again; previous media is retained.','素材を読み込めません。選び直してください。前の素材は保持されています。','미디어를 읽을 수 없습니다. 다시 선택하세요. 이전 미디어는 유지됩니다.','No se pudieron leer los archivos. Elígelos de nuevo; se conservan los anteriores.'],
  clipboard:['無法自動複製。請選取下方文案手動複製，準備內容已保留。','Automatic copy failed. Select the caption below and copy manually; prepared content is retained.','自動コピーに失敗しました。下の文章を選んで手動コピーしてください。準備内容は保持されています。','자동 복사에 실패했습니다. 아래 문안을 선택해 직접 복사하세요. 준비 내용은 유지됩니다.','Falló la copia automática. Selecciona el texto de abajo y cópialo; se conserva el contenido preparado.'],
  shareCancel:['已取消系統分享，內容與進度仍保留。','System sharing cancelled. Content and progress are retained.','システム共有をキャンセルしました。内容と進捗は保持されています。','시스템 공유를 취소했습니다. 내용과 진행 상황은 유지됩니다.','Se canceló el envío. Se conservan el contenido y el progreso.'],
  shareFailed:['系統分享未完成。可下載素材，再到平台加入；內容已保留。','System sharing did not complete. Download media and add it on the platform; content is retained.','システム共有が完了しませんでした。素材を保存して共有先で追加できます。内容は保持されています。','시스템 공유가 완료되지 않았습니다. 미디어를 다운로드해 플랫폼에 추가하세요. 내용은 유지됩니다.','El envío no se completó. Descarga los archivos y agrégalos en la plataforma; se conserva el contenido.'],
} as const;
const languageIndex:Record<InterfaceLanguage,number>={'zh-Hant':0,en:1,ja:2,ko:3,es:4};
const faultKeys:Record<ShareFault,keyof typeof messages>={session:'session',platforms:'platforms',empty:'empty','instagram-media':'instagramMedia',type:'type',size:'size',mixed:'mixed',count:'count',signature:'signature',read:'read',clipboard:'clipboard','share-cancel':'shareCancel','share-failed':'shareFailed'};

export function PlatformLogo({platform}:{platform:SharePlatform}){
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true" focusable="false">
    {platform==='x'&&<path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.1l-4.8-7.4L5.6 22H2.4l8.2-9.4L1 2h6.3l4.4 6.7L18.9 2ZM17.4 20h1.8L6.2 4H4.3l13.1 16Z"/>}
    {platform==='facebook'&&<path fill="currentColor" d="M13.8 22v-9.1h3l.5-3.5h-3.5V7.2c0-1 .3-1.7 1.8-1.7h1.9V2.4c-.3 0-1.5-.2-2.8-.2-2.8 0-4.7 1.7-4.7 4.8v2.4H7v3.5h3V22h3.8Z"/>}
    {platform==='instagram'&&<g stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></g>}
    {platform==='threads'&&<path d="M19.7 7.8C18.8 3.8 15.6 2 12 2 5.8 2 3.2 6 3.2 12s2.9 10 8.8 10c4.9 0 8.2-2.6 8.2-6.1 0-3-2.6-5.1-6.2-5.1-3.2 0-5.1 1.3-5.1 3.2 0 1.6 1.1 2.6 3 2.6 3.4 0 4.3-2.7 4.3-5.9 0-2.8-1.6-4.5-4.2-4.5-1.8 0-3.3.8-4 2.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"/>}
  </svg>;
}

export function SocialCrossPlatformShare({client,draft,disabled,onRestore,onClose,shareJob}:{shareJob?:SocialShareSession;client:PortalClient;draft:string;disabled:boolean;onRestore?:(text:string)=>void;onClose:()=>void}){
  const {language}=useLanguage(),id=useId(),root=useRef<HTMLElement>(null),input=useRef<HTMLInputElement>(null);
  const [job]=useState(()=>shareJob??socialShareForSession(client));
  const state=useSyncExternalStore(job.subscribe,job.snapshot,job.snapshot),saved=state.prepared;
  const t=(key:keyof typeof messages,values:Record<string,string|number>={})=>messages[key][languageIndex[language]].replace(/\{(\w+)\}/g,(match,key)=>String(values[key]??match));
  const busy=disabled||!!state.busy,changed=job.changed(draft),done=saved?.platforms.filter(platform=>state.progress[platform]?.confirmedAt).length??0;
  const canShare=(()=>{try{return !!saved?.files.length&&typeof navigator.share==='function'&&navigator.canShare?.({files:[...saved.files]})===true;}catch{return false;}})();
  useEffect(()=>{root.current?.querySelector<HTMLElement>('h3')?.focus({preventScroll:true});root.current?.scrollIntoView({block:'nearest'});},[]);
  useEffect(()=>{if(state.enabled)root.current?.querySelector<HTMLButtonElement>('.social-share-platform')?.focus({preventScroll:true});},[state.enabled]);
  useEffect(()=>{if(state.active){const step=document.getElementById(`${id}-${state.active}`),toggle=step?.previousElementSibling as HTMLButtonElement|null;toggle?.focus({preventScroll:true});toggle?.scrollIntoView({block:'nearest'});}},[id,state.active]);
  useEffect(()=>{if(state.fault)root.current?.querySelector<HTMLElement>('.social-share-error')?.scrollIntoView({block:'nearest'});},[state.fault]);
  function download(index:number){
    if(disabled||!saved)return;const payload=job.payload(saved.id);if(!payload)return;
    const file=payload.files[index];if(!file)return;
    const url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const feedback=state.feedback==='selected'?t('selected',{count:state.platforms.length}):state.feedback==='files-added'?t('filesAdded'):state.feedback==='file-removed'?t('fileRemoved'):state.feedback==='open-requested'?t('opened'):state.feedback==='device-share'?t('shared'):state.feedback==='confirmed'?t('progress',{done,total:saved?.platforms.length??0}):state.feedback?t(state.feedback as 'enabled'|'disabled'|'prepared'|'copied'):'';
  const alert=state.fault&&<p className="banner banner-error social-share-error" role="alert">{t(faultKeys[state.fault])}</p>;
  const clipboardFault=state.fault==='clipboard',shareFault=state.fault==='share-cancel'||state.fault==='share-failed';
  return <section ref={root} className="social-share-panel" aria-labelledby={`${id}-title`} aria-busy={!!state.busy}>
    <header className="social-share-header"><div><span className="social-share-eyebrow" lang="en">Social Post</span><h3 id={`${id}-title`} tabIndex={-1}>{t('title')}</h3></div><button type="button" className="btn btn-ghost" onClick={onClose}>{t('collapse')}</button></header>
    {!state.enabled?<div className="social-share-consent">
      <h4>{t('riskTitle')}</h4><p>{t('risk')}</p><p className="muted">{t('privacy')}</p>
      <div className="social-share-actions"><button type="button" className="btn btn-primary" disabled={disabled||state.fault==='session'} onClick={()=>job.enable()}>{t('enable')}</button><button type="button" className="btn btn-ghost" onClick={onClose}>{t('cancel')}</button></div>
      {alert}
    </div>:<>
      <p className="social-share-hint">{t('instructions')}</p>
      <fieldset className="social-share-platforms" disabled={busy}><legend>{t('choose')}</legend><div className="social-share-logos">
        {SHARE_PLATFORMS.map(platform=><button key={platform} type="button" className="social-share-platform" aria-label={SHARE_LABELS[platform]} aria-pressed={state.platforms.includes(platform)} onClick={()=>job.toggle(platform)}><span className="social-share-logo"><PlatformLogo platform={platform}/><span className="social-share-light"/></span><span>{platform==='instagram'?'IG':platform==='facebook'?'FB':SHARE_LABELS[platform]}</span><span className="social-share-check" aria-hidden="true">{state.platforms.includes(platform)?'✓':'＋'}</span></button>)}
      </div></fieldset>
      <p className="social-share-selection">{t('selected',{count:state.platforms.length})}</p>
      <div className="social-share-media">
        <input ref={input} className="sr-only" tabIndex={-1} type="file" multiple accept="image/jpeg,image/png,video/mp4" aria-label={t('mediaLabel')} disabled={busy} onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';void job.addFiles(files);}}/>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>input.current?.click()}>{state.busy==='files'?t('checking'):t('media')}</button><p className="social-share-hint">{t('mediaHint')}</p>
        {!!state.files.length&&<ul className="social-share-files">{state.files.map((file,index)=><li key={`${index}-${file.name}`}><span translate="no" title={file.name}>{file.name}<small>{(file.size/1024/1024).toFixed(1)} MB</small></span><button type="button" aria-label={t('remove',{name:file.name})} disabled={busy} onClick={()=>job.removeFile(index)}>×</button></li>)}</ul>}
      </div>
      {changed&&<p className="social-share-change" role="status">{t('changed')}</p>}
      {!clipboardFault&&!shareFault&&alert}
      <div className="social-share-actions"><button type="button" className="btn btn-primary" disabled={busy||!!saved&&!changed} onClick={()=>job.prepare(draft)}>{saved?t('reprepare'):t('prepare')}</button><button type="button" className="btn btn-ghost" onClick={()=>job.disable()}>{t('disable')}</button></div>
      {saved&&<div className="social-share-prepared">
        {clipboardFault&&alert}
        <div className="social-share-caption"><details open={state.fault==='clipboard'||undefined}><summary>{t('caption')}</summary><textarea aria-label={t('caption')} value={saved.text} readOnly translate="no" rows={4} onFocus={event=>event.currentTarget.select()}/>{onRestore&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{if(!disabled&&job.payload(saved.id))onRestore(saved.text);}}>{t('restore')}</button>}</details><button type="button" className="btn btn-ghost" disabled={busy||!saved.text} onClick={()=>{if(!disabled)void job.copy(saved.id,text=>navigator.clipboard.writeText(text));}}>{state.busy==='clipboard'?t('copying'):t('copy')}</button></div>
        {!!saved.files.length&&<div className="social-share-downloads">{saved.files.map((file,index)=><button key={index} type="button" className="btn btn-ghost" disabled={busy} onClick={()=>download(index)}><span>{t('download',{name:file.name})}</span></button>)}</div>}
        <p className="social-share-progress">{t('progress',{done,total:saved.platforms.length})}</p>
        <div className="social-share-steps">{saved.platforms.map((platform,index)=>{
          const progress=state.progress[platform]!,active=state.active===platform,status=progress.confirmedAt?'confirmed':progress.deviceShared?'handed':progress.opened?'requested':'ready';
          return <div className="social-share-step" key={platform} data-complete={!!progress.confirmedAt}>
            <button className="social-share-step-toggle" type="button" disabled={busy} aria-expanded={active} aria-controls={`${id}-${platform}`} onClick={()=>job.focus(platform)}><span className="social-share-step-number">{progress.confirmedAt?'✓':index+1}</span><PlatformLogo platform={platform}/><strong>{SHARE_LABELS[platform]}</strong><span>{t(status)}</span></button>
            {active&&<div id={`${id}-${platform}`} className="social-share-step-body"><p className="social-share-hint">{t(platform==='x'||platform==='threads'?'prefill':'manual')}</p>{shareFault&&alert}<div className="social-share-actions"><a className="btn btn-primary" href={socialShareUrl(platform,saved.text)} target="_blank" rel="noopener noreferrer" aria-disabled={busy||undefined} onClick={event=>{if(disabled||!job.opened(saved.id,platform))event.preventDefault();}}>{t('open',{platform:SHARE_LABELS[platform]})}</a>
              {canShare&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{if(!disabled)void job.shareFiles(saved.id,platform,data=>navigator.share(data));}}>{state.busy==='share'?t('sharing'):t('systemShare',{platform:SHARE_LABELS[platform]})}</button>}
              <button type="button" className="btn btn-ghost" disabled={busy||!!progress.confirmedAt} onClick={()=>job.confirm(saved.id,platform)}>{t('complete')}</button></div>
              {!!saved.files.length&&<p className="social-share-hint">{t(canShare?'systemHint':'fallback')}</p>}
            </div>}
          </div>;
        })}</div>
        <p className="social-share-hint">{t('truth')}</p>{done===saved.platforms.length&&<p className="social-share-done" role="status">{t('allDone')}</p>}
      </div>}
    </>}
    <p className={`social-share-feedback${state.feedback==='selected'?' sr-only':''}`} role="status" aria-live="polite" aria-atomic="true">{feedback}</p>
  </section>;
}
