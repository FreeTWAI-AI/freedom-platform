import { decode, encode } from '@msgpack/msgpack';

/** MindAR 1.2.5 image-target format, not executable project JSON. The packet
 * contains grayscale tracking pixels and must be treated as an image Asset. */
export const AR_TARGET_MAX_BYTES = 2 * 1024 * 1024;
export const AR_EXPERIENCE_MAX_BYTES = 20 * 1024 * 1024;
export const AR_SCENE_MAX_TARGETS = 8;
export type ArBinding={version:1;kind:'text';text:string}|{version:1;kind:'effect';text:string;effect:'sparkle'|'halo'|'confetti'}|{version:1;kind:'image'|'video';text:string;mime:string;media:Uint8Array};
export type ArBindingMetadata={version:1;kind:ArBinding['kind'];text:string;effect?:'sparkle'|'halo'|'confetti';mime?:string};
export type ImageTarget = {
  targetImage: {width:number;height:number};
  trackingData: unknown[];
  matchingData: unknown[];
};
function invalid():never {throw new Error('invalid_ar_target');}
const number = (v:unknown,min:number,max:number,integer=false):v is number =>
  typeof v==='number' && Number.isFinite(v) && v>=min && v<=max && (!integer || Number.isInteger(v));
function object(v:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||!keys.every(k=>Object.hasOwn(v,k)))invalid();
  return v as Record<string,unknown>;
}
function array(v:unknown,min:number,max:number):unknown[] {
  if(!Array.isArray(v)||v.length<min||v.length>max)invalid(); return v;
}

/** Preflight before the decoder allocates arrays/maps. Size alone does not
 * bound nesting or declared collection lengths. Reject extensions and 64-bit
 * integers: this closed image format uses neither. */
function preflight(bytes:Uint8Array){
  let offset=0,nodes=0; const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const take=(size:number)=>{if(size>bytes.length-offset)invalid(); const old=offset;offset+=size;return old;};
  const len=(size:number)=>{const at=take(size);return size===1?view.getUint8(at):size===2?view.getUint16(at):view.getUint32(at);};
  const visit=(depth:number):void=>{
    if(depth>24||++nodes>180000)invalid(); const c=bytes[take(1)];
    if(c<=0x7f||c>=0xe0||[0xc0,0xc2,0xc3].includes(c))return;
    if((c&0xe0)===0xa0){take(c&31);return;}
    let count:number|undefined, map=false;
    if((c&0xf0)===0x90)count=c&15;
    else if((c&0xf0)===0x80){count=c&15;map=true;}
    else if(c===0xdc||c===0xdd)count=len(c===0xdc?2:4);
    else if(c===0xde||c===0xdf){count=len(c===0xde?2:4);map=true;}
    if(count!==undefined){if(count>(map?12:4096))invalid();for(let i=0;i<count*(map?2:1);i++)visit(depth+1);return;}
    if([0xc4,0xc5,0xc6,0xd9,0xda,0xdb].includes(c)){const size=len([0xc4,0xd9].includes(c)?1:[0xc5,0xda].includes(c)?2:4);if(size>(c>=0xd9?4096:16*1024*1024))invalid();take(size);return;}
    const size=({[0xca]:4,[0xcb]:8,[0xcc]:1,[0xcd]:2,[0xce]:4,[0xd0]:1,[0xd1]:2,[0xd2]:4} as Record<number,number>)[c];
    if(!size)invalid();take(size);
  };
  visit(0);if(offset!==bytes.length)invalid();
}
function cluster(raw:unknown,count:number){
  const root=object(raw,['rootNode']);const seen=new Set<number>();let nodes=0;
  function index(v:unknown){const n=typeof v==='string'&&/^(0|[1-9][0-9]{0,3})$/.test(v)?Number(v):v;if(!number(n,0,count-1,true))invalid();return n;}
  function node(raw:unknown,depth:number,isRoot=false):void{
    if(depth>16||++nodes>2048)invalid();
    if(!raw||typeof raw!=='object')invalid();const leaf=(raw as Record<string,unknown>).leaf;
    const value=object(raw,['centerPointIndex','leaf',leaf===true?'pointIndexes':'children']);
    if(typeof leaf!=='boolean')invalid();
    if(value.centerPointIndex!==null)index(value.centerPointIndex);else if(!isRoot)invalid();
    if(leaf){for(const i of array(value.pointIndexes,0,count)){const n=index(i);if(seen.has(n))invalid();seen.add(n);}}
    else for(const child of array(value.children,1,16))node(child,depth+1);
  }
  node(root.rootNode,0,true);if(seen.size!==count)invalid();
}
function target(raw:unknown):ImageTarget{
  const value=object(raw,['targetImage','trackingData','matchingData']);const image=object(value.targetImage,['width','height']);
  if(!number(image.width,64,1024,true)||!number(image.height,64,1024,true))invalid();
  let pixels=0,totalPoints=0;
  for(const raw of array(value.trackingData,1,4)){
    const t=object(raw,['data','scale','width','height','points']);
    if(!number(t.width,16,1024,true)||!number(t.height,16,1024,true)||!number(t.scale,0.01,4))invalid();
    if(!(t.data instanceof Uint8Array)||t.data.length!==t.width*t.height)invalid();pixels+=t.data.length;if(pixels>1500000)invalid();
    for(const raw of array(t.points,4,1024)){const p=object(raw,['x','y']);if(!number(p.x,0,t.width)||!number(p.y,0,t.height))invalid();}
  }
  for(const raw of array(value.matchingData,1,12)){
    const m=object(raw,['maximaPoints','minimaPoints','maximaPointsCluster','minimaPointsCluster','width','height','scale']);
    if(!number(m.width,8,1024,true)||!number(m.height,8,1024,true)||!number(m.scale,0.001,4))invalid();
    for(const maxima of [true,false]){
      const points=array(m[maxima?'maximaPoints':'minimaPoints'],0,2048);totalPoints+=points.length;if(totalPoints>8192)invalid();
      for(const raw of points){const p=object(raw,['maxima','x','y','scale','angle','descriptors']);
        if(p.maxima!==maxima||!number(p.x,0,m.width)||!number(p.y,0,m.height)||!number(p.scale,0.001,256)||!number(p.angle,-Math.PI*2,Math.PI*2))invalid();
        for(const d of array(p.descriptors,21,21))if(!number(d,0,4294967295,true))invalid();
      }
      cluster(m[maxima?'maximaPointsCluster':'minimaPointsCluster'],points.length);
    }
  }
  if(totalPoints<12)invalid();return value as unknown as ImageTarget;
}
function binding(raw:unknown):ArBinding{
  if(!raw||typeof raw!=='object')invalid();const kind=(raw as Record<string,unknown>).kind;
  const keys=kind==='text'?['version','kind','text']:kind==='effect'?['version','kind','text','effect']:['version','kind','text','mime','media'];
  const b=object(raw,keys);if(b.version!==1||typeof b.text!=='string'||Array.from(b.text).length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(b.text))invalid();
  if(kind==='text'){if(!b.text.trim())invalid();}
  else if(kind==='effect'){if(!['sparkle','halo','confetti'].includes(String(b.effect)))invalid();}
  else if(kind==='image'||kind==='video'){
    if(!(b.media instanceof Uint8Array)||!b.media.length||b.media.length>(kind==='image'?2:16)*1024*1024)invalid();
    const p=b.media;
    if(kind==='image'){
      const png=b.mime==='image/png'&&[137,80,78,71,13,10,26,10].every((v,i)=>p[i]===v);
      const jpeg=b.mime==='image/jpeg'&&p[0]===255&&p[1]===216&&p[2]===255;
      const webp=b.mime==='image/webp'&&String.fromCharCode(...p.subarray(0,4))==='RIFF'&&String.fromCharCode(...p.subarray(8,12))==='WEBP';
      if(!png&&!jpeg&&!webp)invalid();
    }else if(!(b.mime==='video/mp4'&&p.length>=12&&String.fromCharCode(...p.subarray(4,8))==='ftyp')&&!(b.mime==='video/webm'&&[26,69,223,163].every((v,i)=>p[i]===v)))invalid();
  }else invalid();return b as unknown as ArBinding;
}
export function inspectArExperience(bytes:Uint8Array):{target:ImageTarget;binding?:ArBinding}{
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<32||bytes.byteLength>AR_EXPERIENCE_MAX_BYTES)invalid();
  preflight(bytes);
  const raw=decode(bytes,{maxStrLength:4096,maxBinLength:16*1024*1024,maxArrayLength:4096,maxMapLength:12});
  const packet=object(raw,raw&&typeof raw==='object'&&Object.hasOwn(raw,'freedomContent')?['v','dataList','freedomContent']:['v','dataList']);
  if(packet.v!==2)invalid();const image=target(array(packet.dataList,1,1)[0]);
  if(encode({v:2,dataList:[image]}).length>AR_TARGET_MAX_BYTES)invalid();
  return {target:image,...(packet.freedomContent!==undefined?{binding:binding(packet.freedomContent)}:{})};
}
export function inspectArTarget(bytes:Uint8Array):ImageTarget{return inspectArExperience(bytes).target;}
export function bindingMetadata(b:ArBinding):ArBindingMetadata{
  return {version:1,kind:b.kind,text:b.text,...(b.kind==='effect'?{effect:b.effect}:{}),...(b.kind==='image'||b.kind==='video'?{mime:b.mime}:{})};
}
export function createArExperience(pattern:Uint8Array,content?:ArBinding):Uint8Array{
  const bytes=encode({v:2,dataList:[inspectArTarget(pattern)],...(content?{freedomContent:content}:{})});inspectArExperience(bytes);return bytes;
}
export function combineArTargets(packets:readonly Uint8Array[]):Uint8Array{
  if(!packets.length||packets.length>AR_SCENE_MAX_TARGETS)invalid();
  return encode({v:2,dataList:packets.map(inspectArTarget)});
}
