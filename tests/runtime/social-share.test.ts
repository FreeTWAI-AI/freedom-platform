import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PortalClient} from '../../apps/portal-web/src/api';
import {shareModuleRetryUrl} from '../../apps/portal-web/src/share-module-loader';
import {SHARE_IMAGE_LIMIT,SHARE_VIDEO_LIMIT,ShareMediaError,SocialShareSession,socialShareForSession,socialShareUrl,validateShareMedia} from '../../apps/portal-web/src/social-share';

const png=()=>new File([Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0])],'原始作品.png',{type:'image/png'});
const jpeg=()=>new File([Uint8Array.from([255,216,255,224,0,0])],'作品.jpg',{type:'image/jpeg'});
const mp4=()=>new File([Uint8Array.from([0,0,0,16,102,116,121,112,105,115,111,109])],'原始影片.mp4',{type:'video/mp4'});
function session(){const client=new PortalClient();client.csrfToken='test-current-session';return {client,job:socialShareForSession(client)};}
async function fault(files:File[],code:string){await assert.rejects(()=>validateShareMedia(files),cause=>cause instanceof ShareMediaError&&cause.fault===code);}

test('module-map retry accepts only this application chunk and at most three explicit fresh keys',()=>{
  const origin='https://workshop.example.test',path='/assets/SocialCrossPlatformShare-abc123.js',error=(url:string)=>new TypeError('Failed to fetch dynamically imported module: '+url);
  assert.equal(shareModuleRetryUrl(error(origin+path),origin,1),origin+path+'?share-retry=1');assert.equal(shareModuleRetryUrl(error(origin+path+'?share-retry=1'),origin,2),origin+path+'?share-retry=2');
  for(const url of ['https://other.test'+path,origin+'/assets/OtherModule-abc123.js',origin+'/assets/SocialCrossPlatformShare-abc123.css',origin+path+'?token=private',origin+path+'#fragment','https://user:secret@workshop.example.test'+path])assert.equal(shareModuleRetryUrl(error(url),origin,1),null);
  for(const attempt of [0,4,1.5])assert.equal(shareModuleRetryUrl(error(origin+path),origin,attempt),null);
});

test('official intent URLs round-trip the same caption, including Unicode, newlines, links and query injection characters',()=>{
  const text='同一份文案\nhttps://example.test/a?b=1&next=2 #作品 + % <script>';
  for(const [platform,origin,path] of [['x','https://twitter.com','/intent/tweet'],['threads','https://www.threads.com','/intent/post']] as const){
    const url=new URL(socialShareUrl(platform,text));assert.equal(url.origin,origin);assert.equal(url.pathname,path);assert.equal(url.searchParams.get('text'),text);assert.equal(url.searchParams.size,1);
  }
  assert.equal(socialShareUrl('facebook',text),'https://www.facebook.com/');assert.equal(socialShareUrl('instagram',text),'https://www.instagram.com/');
});

test('off-by-default and disabled workflows cannot select, prepare, copy, share, open or confirm',async()=>{
  const {job}=session();let external=0;
  assert.equal(job.snapshot().enabled,false);job.toggle('x');assert.deepEqual(job.snapshot().platforms,[]);assert.equal(job.prepare('原稿'),false);
  await job.copy(1,async()=>{external++;});await job.shareFiles(1,'x',async()=>{external++;});assert.equal(job.opened(1,'x'),false);job.confirm(1,'x');assert.equal(external,0);
  job.enable();job.toggle('x');job.prepare('原稿');const saved=job.snapshot().prepared!;job.disable();assert.equal(job.payload(saved.id),null);assert.equal(job.opened(saved.id,'x'),false);
  await job.copy(saved.id,async()=>{external++;});assert.equal(external,0);assert.equal(job.snapshot().prepared,saved);
});

test('preparation rejects missing selection, empty content and Instagram without original media',async()=>{
  const {job}=session();job.enable();assert.equal(job.prepare('caption'),false);assert.equal(job.snapshot().fault,'platforms');job.toggle('x');assert.equal(job.prepare('  '),false);assert.equal(job.snapshot().fault,'empty');
  job.toggle('instagram');assert.equal(job.prepare('caption'),false);assert.equal(job.snapshot().fault,'instagram-media');await job.addFiles([png()]);assert.equal(job.prepare('caption'),true);
});

test('validated original JPEG, PNG and MP4 use only bounded header reads',async()=>{
  await validateShareMedia([png(),jpeg()]);await validateShareMedia([mp4()]);let read:number[]=[];
  const file=png(),slice=file.slice.bind(file);file.slice=(start,end)=>{read.push(end!);return slice(start,end);};await validateShareMedia([file]);assert.deepEqual(read,[16]);
});

test('wrong type, forged signature, zero size, excess count and mixed media are rejected',async()=>{
  await fault([new File(['hello'],'x.webp',{type:'image/webp'})],'type');await fault([new File(['not a PNG'],'x.png',{type:'image/png'})],'signature');
  await fault([new File([],'x.png',{type:'image/png'})],'size');await fault([png(),png(),png(),png(),png()],'count');await fault([mp4(),mp4()],'count');await fault([png(),mp4()],'mixed');
});

test('image and video size boundaries reject before reading any body',async()=>{
  for(const [type,limit] of [['image/png',SHARE_IMAGE_LIMIT],['video/mp4',SHARE_VIDEO_LIMIT]] as const){
    let reads=0;const file={type,size:limit+1,slice(){reads++;throw Error('must not read oversized file');}} as unknown as File;
    await fault([file],'size');assert.equal(reads,0);
  }
});

test('invalid newly added media preserves existing files and prepared work',async()=>{
  const {job}=session(),image=png();job.enable();job.toggle('instagram');await job.addFiles([image]);job.prepare('original');const saved=job.snapshot().prepared;
  await job.addFiles([new File(['forged'],'bad.png',{type:'image/png'})]);assert.equal(job.snapshot().fault,'signature');assert.deepEqual(job.snapshot().files,[image]);assert.equal(job.snapshot().prepared,saved);
});

test('snapshot remains the prepared caption, media and selection; changed input needs an explicit new preparation',async()=>{
  const {job}=session(),image=png();job.enable();job.toggle('x');job.toggle('threads');await job.addFiles([image]);job.prepare(' A ');const saved=job.snapshot().prepared!;
  job.confirm(saved.id,'x');job.toggle('facebook');job.removeFile(0);assert.equal(job.changed('B'),true);assert.equal(saved.text,'A');assert.deepEqual(saved.files,[image]);assert.deepEqual(saved.platforms,['x','threads']);
  assert.equal(job.prepare('B'),true);const next=job.snapshot().prepared!;assert.notEqual(next.id,saved.id);assert.equal(next.text,'B');assert.deepEqual(next.files,[]);assert.deepEqual(next.platforms,['x','facebook','threads']);assert.equal(job.snapshot().progress.x?.confirmedAt,null);assert.equal(job.payload(saved.id),null);
});

test('an open request or successful OS handoff never counts as published or self-confirmed',async()=>{
  const {job}=session();job.enable();job.toggle('x');job.toggle('threads');await job.addFiles([png()]);job.prepare('shared copy');const id=job.snapshot().prepared!.id;
  assert.equal(job.opened(id,'x'),true);assert.equal(job.snapshot().progress.x?.confirmedAt,null);let invoked=false;
  const pending=job.shareFiles(id,'x',async data=>{invoked=true;assert.equal(data.files!.length,1);assert.equal(data.text,undefined);});assert.equal(invoked,true,'share is invoked inside the click call stack');await pending;
  assert.equal(job.snapshot().progress.x?.deviceShared,true);assert.equal(job.snapshot().progress.x?.confirmedAt,null);assert.equal(job.snapshot().feedback,'device-share');
  job.confirm(id,'x');assert.equal(typeof job.snapshot().progress.x?.confirmedAt,'number');assert.equal(job.snapshot().active,'threads');assert.equal(job.snapshot().progress.threads?.confirmedAt,null);
});

test('OS cancellation and clipboard denial retain the exact snapshot and unconfirmed progress',async()=>{
  const {job}=session();job.enable();job.toggle('instagram');await job.addFiles([png()]);job.prepare('copy');const saved=job.snapshot().prepared!;
  await job.shareFiles(saved.id,'instagram',async()=>{throw new DOMException('cancelled','AbortError');});assert.equal(job.snapshot().fault,'share-cancel');assert.equal(job.snapshot().prepared,saved);assert.equal(job.snapshot().progress.instagram?.confirmedAt,null);
  await job.copy(saved.id,async()=>{throw new DOMException('denied','NotAllowedError');});assert.equal(job.snapshot().fault,'clipboard');assert.equal(job.snapshot().prepared,saved);
  let copied='';await job.copy(saved.id,async text=>{copied=text;});assert.equal(copied,'copy');assert.equal(job.snapshot().feedback,'copied');
});

test('same-login remounts recover in memory; another login receives an empty opt-in session',async()=>{
  const {client,job}=session();job.enable();job.toggle('instagram');await job.addFiles([png()]);job.prepare('private draft');assert.equal(socialShareForSession(client),job);
  client.csrfToken=null;client.csrfToken='different-login';const next=socialShareForSession(client);assert.notEqual(next,job);assert.equal(next.snapshot().enabled,false);assert.deepEqual(next.snapshot().files,[]);assert.equal(next.snapshot().prepared,null);
  let calls=0;await job.copy(1,async()=>{calls++;});assert.equal(calls,0);assert.equal(job.snapshot().fault,'session');assert.equal(job.snapshot().prepared,null);
});

test('late async completion after logout cannot revive a previous member draft or progress',async()=>{
  const {client,job}=session();job.enable();job.toggle('x');job.prepare('private copy');let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve});const pending=job.copy(1,()=>gate);
  assert.equal(job.snapshot().busy,'clipboard');client.csrfToken=null;release();await pending;assert.equal(job.snapshot().enabled,false);assert.equal(job.snapshot().prepared,null);assert.equal(job.snapshot().fault,'session');
});

test('disabling while media validation is pending cancels its late state change',async()=>{
  const {job}=session();job.enable();let release=(_:ArrayBuffer)=>{};const header=new Promise<ArrayBuffer>(resolve=>{release=resolve});const file=png();file.slice=()=>({arrayBuffer:()=>header}) as Blob;
  const pending=job.addFiles([file]);assert.equal(job.snapshot().busy,'files');job.disable();release(Uint8Array.from([137,80,78,71,13,10,26,10]).buffer);await pending;
  assert.equal(job.snapshot().enabled,false);assert.deepEqual(job.snapshot().files,[]);assert.equal(job.snapshot().feedback,'disabled');
});

test('disabled share invalidates pending results, retains the draft, and stale platform steps cannot run',async()=>{
  const {job}=session();job.enable();job.toggle('x');await job.addFiles([png()]);job.prepare('copy');const saved=job.snapshot().prepared!;let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve});
  const pending=job.shareFiles(saved.id,'x',()=>gate);job.disable();release();await pending;assert.equal(job.snapshot().progress.x?.deviceShared,false);assert.equal(job.snapshot().prepared,saved);
  job.enable();assert.equal(job.opened(saved.id,'facebook'),false);job.confirm(saved.id,'facebook');assert.equal(job.snapshot().progress.facebook,undefined);
});
