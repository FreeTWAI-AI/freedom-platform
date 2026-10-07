import type {PortalClient} from './api';

export const SHARE_PLATFORMS=['x','instagram','facebook','threads'] as const;
export type SharePlatform=typeof SHARE_PLATFORMS[number];
export const SHARE_LABELS:Record<SharePlatform,string>={x:'X',instagram:'Instagram',facebook:'Facebook',threads:'Threads'};
export const SHARE_IMAGE_LIMIT=10*1024*1024,SHARE_VIDEO_LIMIT=50*1024*1024;
export type ShareFault='session'|'platforms'|'empty'|'instagram-media'|'type'|'size'|'mixed'|'count'|'signature'|'read'|'clipboard'|'share-cancel'|'share-failed';
type Feedback='enabled'|'disabled'|'selected'|'files-added'|'file-removed'|'prepared'|'copied'|'open-requested'|'device-share'|'confirmed'|null;
export type ShareProgress={opened:boolean;deviceShared:boolean;confirmedAt:number|null};
export type PreparedShare={id:number;text:string;files:readonly File[];platforms:readonly SharePlatform[]};
export type ShareSnapshot={
  enabled:boolean;platforms:readonly SharePlatform[];files:readonly File[];
  prepared:PreparedShare|null;progress:Partial<Record<SharePlatform,ShareProgress>>;
  active:SharePlatform|null;busy:'files'|'clipboard'|'share'|null;
  feedback:Feedback;fault:ShareFault|null;
};
const empty=():ShareSnapshot=>({enabled:false,platforms:[],files:[],prepared:null,progress:{},active:null,busy:null,feedback:null,fault:null});

/** Official user-confirmed composers. FB/IG have no generic web media/caption prefill. */
export function socialShareUrl(platform:SharePlatform,text:string):string{
  if(platform==='instagram')return 'https://www.instagram.com/';
  if(platform==='facebook')return 'https://www.facebook.com/';
  const url=new URL(platform==='x'?'https://twitter.com/intent/tweet':'https://www.threads.com/intent/post');
  url.searchParams.set('text',text);return url.toString();
}

export class ShareMediaError extends Error{constructor(readonly fault:ShareFault){super(fault);}}
/** Bounded header reads only. This feature never uploads or normalizes original media. */
export async function validateShareMedia(files:readonly File[]):Promise<void>{
  const images=files.filter(file=>file.type==='image/jpeg'||file.type==='image/png');
  const videos=files.filter(file=>file.type==='video/mp4');
  if(images.length+videos.length!==files.length)throw new ShareMediaError('type');
  if(images.length&&videos.length)throw new ShareMediaError('mixed');
  if(images.length>4||videos.length>1)throw new ShareMediaError('count');
  if(files.some(file=>file.size===0||file.size>(file.type==='video/mp4'?SHARE_VIDEO_LIMIT:SHARE_IMAGE_LIMIT)))throw new ShareMediaError('size');
  for(const file of files){
    let bytes:Uint8Array;
    try{bytes=new Uint8Array(await file.slice(0,16).arrayBuffer());}catch{throw new ShareMediaError('read');}
    const valid=file.type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
      file.type==='image/png'?[137,80,78,71,13,10,26,10].every((byte,index)=>bytes[index]===byte):
      bytes.length>=12&&[102,116,121,112].every((byte,index)=>bytes[index+4]===byte);
    if(!valid)throw new ShareMediaError('signature');
  }
}

type Client=Pick<PortalClient,'sessionGeneration'|'csrfToken'>;
/** Current-login memory only: no credentials, drafts, filenames or progress in storage. */
export class SocialShareSession{
  private state=empty();private listeners=new Set<()=>void>();private operation=0;private revision=0;
  private readonly generation:number;
  constructor(private readonly client:Client){this.generation=client.sessionGeneration;}
  snapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private update(change:Partial<ShareSnapshot>){this.state={...this.state,...change};for(const listener of this.listeners)listener();}
  private current(){
    if(this.client.sessionGeneration===this.generation&&this.client.csrfToken)return true;
    ++this.operation;this.state={...empty(),fault:'session'};for(const listener of this.listeners)listener();return false;
  }
  enable(){if(!this.current())return;this.update({enabled:true,fault:null,feedback:'enabled'});}
  disable(){if(!this.current())return;++this.operation;this.update({enabled:false,busy:null,fault:null,feedback:'disabled'});}
  toggle(platform:SharePlatform){
    if(!this.current()||!this.state.enabled||this.state.busy)return;
    const selected=this.state.platforms.includes(platform),platforms=SHARE_PLATFORMS.filter(id=>id===platform?!selected:this.state.platforms.includes(id));
    this.update({platforms,fault:null,feedback:'selected'});
  }
  async addFiles(incoming:readonly File[]){
    if(!this.current()||!this.state.enabled||this.state.busy||!incoming.length)return;
    const operation=++this.operation,files=[...this.state.files,...incoming];this.update({busy:'files',fault:null,feedback:null});
    try{await validateShareMedia(files);if(this.finish(operation))this.update({files,busy:null,feedback:'files-added'});}
    catch(cause){if(this.finish(operation))this.update({busy:null,fault:cause instanceof ShareMediaError?cause.fault:'read'});}
  }
  removeFile(index:number){if(!this.current()||!this.state.enabled||this.state.busy)return;this.update({files:this.state.files.filter((_,i)=>i!==index),fault:null,feedback:'file-removed'});}
  prepare(text:string){
    if(!this.current()||!this.state.enabled||this.state.busy)return false;
    const fault=!this.state.platforms.length?'platforms':!text.trim()&&!this.state.files.length?'empty':this.state.platforms.includes('instagram')&&!this.state.files.length?'instagram-media':null;
    if(fault){this.update({fault,feedback:null});return false;}
    const prepared:PreparedShare=Object.freeze({id:++this.revision,text:text.trim(),files:Object.freeze([...this.state.files]),platforms:Object.freeze([...this.state.platforms])});
    const progress=Object.fromEntries(prepared.platforms.map(id=>[id,{opened:false,deviceShared:false,confirmedAt:null}]));
    this.update({prepared,progress,active:prepared.platforms[0],fault:null,feedback:'prepared'});return true;
  }
  changed(text:string){const saved=this.state.prepared;return !!saved&&(saved.text!==text.trim()||saved.files.length!==this.state.files.length||saved.files.some((file,i)=>file!==this.state.files[i])||saved.platforms.join()!==this.state.platforms.join());}
  /** Recheck immediately before each browser handoff; stale UI links cannot send old work. */
  payload(id:number,platform?:SharePlatform):PreparedShare|null{
    if(!this.current()||!this.state.enabled||this.state.busy||this.state.prepared?.id!==id||platform&&!this.state.prepared.platforms.includes(platform))return null;
    return this.state.prepared;
  }
  focus(platform:SharePlatform){if(this.state.prepared&&this.payload(this.state.prepared.id,platform))this.update({active:platform,fault:null,feedback:null});}
  opened(id:number,platform:SharePlatform){
    if(!this.payload(id,platform))return false;
    this.update({progress:{...this.state.progress,[platform]:{...this.state.progress[platform]!,opened:true}},fault:null,feedback:'open-requested'});return true;
  }
  confirm(id:number,platform:SharePlatform){
    const saved=this.payload(id,platform);if(!saved)return;
    const progress={...this.state.progress,[platform]:{...this.state.progress[platform]!,confirmedAt:Date.now()}};
    this.update({progress,active:saved.platforms.find(item=>!progress[item]?.confirmedAt)??platform,fault:null,feedback:'confirmed'});
  }
  private finish(operation:number){return this.current()&&operation===this.operation&&this.state.enabled;}
  async copy(id:number,write:(text:string)=>Promise<void>){
    const saved=this.payload(id);if(!saved)return;
    const operation=++this.operation;this.update({busy:'clipboard',fault:null,feedback:null});
    try{await write(saved.text);if(this.finish(operation))this.update({busy:null,feedback:'copied'});}
    catch{if(this.finish(operation))this.update({busy:null,fault:'clipboard'});}
  }
  async shareFiles(id:number,platform:SharePlatform,share:(data:ShareData)=>Promise<void>){
    const saved=this.payload(id,platform);if(!saved||!saved.files.length)return;
    const operation=++this.operation;this.update({busy:'share',fault:null,feedback:null});
    // Call synchronously during the user's click. Resolution proves OS handoff, not destination or publication.
    try{await share({files:[...saved.files]});if(this.finish(operation))this.update({busy:null,progress:{...this.state.progress,[platform]:{...this.state.progress[platform]!,deviceShared:true}},feedback:'device-share'});}
    catch(cause){if(this.finish(operation))this.update({busy:null,fault:cause instanceof Error&&cause.name==='AbortError'?'share-cancel':'share-failed'});}
  }
}
const sessions=new WeakMap<Client,{generation:number;job:SocialShareSession}>();
export function socialShareForSession(client:Client){
  const entry=sessions.get(client);if(entry?.generation===client.sessionGeneration)return entry.job;
  const job=new SocialShareSession(client);sessions.set(client,{generation:client.sessionGeneration,job});return job;
}
