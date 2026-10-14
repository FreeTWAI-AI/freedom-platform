import type {ArBindingMetadata} from '../../../../../packages/asset-storage/ar-target';
export type ArContent={title:string;kind:'member'|'event'|'custom';binding?:ArBindingMetadata|null;version:string;pattern_url:string;destination:string;content:{nickname?:string;headline?:string|null;title?:string;description?:string;organizer_name?:string;starts_at?:string;primary_guild?:{name:string}|null;capabilities?:string[]}};
export type Quad=readonly [number,number][];
/** Column-major P × W, target origin bottom-left (same geometry as AR_HAO).
 * Output follows the camera pixel rectangle, independent of CSS / DPR. */
export function projectTarget(world:readonly number[],projection:readonly number[],dimension:readonly [number,number],width:number,height:number):Quad|null{
  if(world.length!==16||projection.length!==16||![...world,...projection,...dimension,width,height].every(Number.isFinite)||width<=0||height<=0)return null;
  const points:[[number,number],[number,number],[number,number],[number,number]]=[[0,dimension[1]],[dimension[0],dimension[1]],[dimension[0],0],[0,0]];
  const result: [number,number][]=[];
  for(const [x,y] of points){
    const v=Array.from({length:4},(_,r)=>world[r]*x+world[4+r]*y+world[12+r]);
    const c=Array.from({length:4},(_,r)=>projection[r]*v[0]+projection[4+r]*v[1]+projection[8+r]*v[2]+projection[12+r]*v[3]);
    if(c[3]<=0.000001)return null;const point:[number,number]=[(c[0]/c[3]+1)*width/2,(1-c[1]/c[3])*height/2];
    if(point.some(n=>!Number.isFinite(n)||Math.abs(n)>Math.max(width,height)*8))return null;result.push(point);
  }
  const area=result.reduce((sum,[x,y],i)=>{const next=result[(i+1)%4];return sum+x*next[1]-next[0]*y;},0)/2;
  return Math.abs(area)>16?result:null;
}
function wrap(c:CanvasRenderingContext2D,text:string,maxWidth:number,lines:number){
  const result:string[]=[];let line='';for(const char of Array.from(text)){if(c.measureText(line+char).width>maxWidth&&line){result.push(line);line='';if(result.length===lines)return [...result.slice(0,-1),result.at(-1)!.slice(0,-1)+'…'];}line+=char;}if(line)result.push(line);return result;
}
export function cardTexture(item:ArContent):HTMLCanvasElement{
  const canvas=document.createElement('canvas');canvas.width=720;canvas.height=450;const c=canvas.getContext('2d')!,family=getComputedStyle(document.body).fontFamily;
  const gradient=c.createLinearGradient(0,0,720,450);gradient.addColorStop(0,'#142415');gradient.addColorStop(1,'#344214');c.fillStyle=gradient;c.fillRect(0,0,720,450);
  c.strokeStyle='#c4ff2d';c.lineWidth=8;c.strokeRect(8,8,704,434);
  c.fillStyle='#c4ff2d';c.font=`600 25px ${family}`;c.fillText(item.kind==='member'?'自由工坊 · 公開名片':item.kind==='event'?'自由工坊 · 公開活動':'自由工坊 · AR 作品',36,58);
  c.fillStyle='#fff';c.font=`700 50px ${family}`;const title=item.content.nickname??item.content.title??item.title;
  wrap(c,title,645,2).forEach((line,i)=>c.fillText(line,36,128+i*62));
  c.font=`400 27px ${family}`;const summary=item.binding?.text??item.content.headline??item.content.primary_guild?.name??item.content.organizer_name??'';
  wrap(c,summary,640,3).forEach((line,i)=>c.fillText(line,36,263+i*38));
  c.fillStyle='#c4ff2d';c.font=`500 23px ${family}`;c.fillText('點「查看內容」開啟完整資料',36,405);return canvas;
}
/** Two affine triangles align a card with the measured target. CSS letterbox
 * uses the same video ratio, so live view and exported photo have one geometry. */
export function drawArCard(context:CanvasRenderingContext2D,texture:CanvasImageSource,quad:Quad,sourceWidth?:number,sourceHeight?:number,targetAspect?:number){
  const width=sourceWidth??(texture as HTMLCanvasElement).width,height=sourceHeight??(texture as HTMLCanvasElement).height;
  // Contain the authored content on the measured plane. Portrait shirts must
  // not stretch a landscape card, image or video into a tall shape.
  if(targetAspect&&Number.isFinite(targetAspect)&&targetAspect>0){
    const ratio=(width/height)/targetAspect,uw=Math.min(1,ratio),vh=Math.min(1,1/ratio),u=(1-uw)/2,v=(1-vh)/2;
    quad=[[u,v],[u+uw,v],[u+uw,v+vh],[u,v+vh]].map(([x,y])=>[
      quad[0][0]*(1-x)*(1-y)+quad[1][0]*x*(1-y)+quad[2][0]*x*y+quad[3][0]*(1-x)*y,
      quad[0][1]*(1-x)*(1-y)+quad[1][1]*x*(1-y)+quad[2][1]*x*y+quad[3][1]*(1-x)*y,
    ] as [number,number]);
  }
  const source=[[0,0],[width,0],[width,height],[0,height]];
  for(const indexes of [[0,1,2],[0,2,3]]){
    const [a,b,c]=indexes.map(i=>source[i]),[p,q,r]=indexes.map(i=>quad[i]);
    const det=(b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]);if(!det)continue;
    const m11=((q[0]-p[0])*(c[1]-a[1])-(r[0]-p[0])*(b[1]-a[1]))/det;
    const m12=((r[0]-p[0])*(b[0]-a[0])-(q[0]-p[0])*(c[0]-a[0]))/det;
    const m21=((q[1]-p[1])*(c[1]-a[1])-(r[1]-p[1])*(b[1]-a[1]))/det;
    const m22=((r[1]-p[1])*(b[0]-a[0])-(q[1]-p[1])*(c[0]-a[0]))/det;
    context.save();context.beginPath();context.moveTo(...p);context.lineTo(...q);context.lineTo(...r);context.closePath();context.clip();
    context.transform(m11,m21,m12,m22,p[0]-m11*a[0]-m12*a[1],p[1]-m21*a[0]-m22*a[1]);context.drawImage(texture,0,0);context.restore();
  }
}
export function drawArEffect(context:CanvasRenderingContext2D,quad:Quad,effect:'sparkle'|'halo'|'confetti',time:number){
  const x=quad.reduce((s,p)=>s+p[0],0)/4,y=quad.reduce((s,p)=>s+p[1],0)/4;
  const radius=Math.max(16,Math.hypot(quad[1][0]-quad[0][0],quad[1][1]-quad[0][1])/2);
  context.save();context.lineWidth=3;context.strokeStyle='#c4ff2d';
  if(effect==='halo'){context.beginPath();context.ellipse(x,y,radius*1.2,radius*.8,Math.sin(time/1000)*.3,0,Math.PI*2);context.stroke();}
  else for(let i=0;i<14;i++){const angle=i*Math.PI*2/14+time/2200,spread=radius*(.85+.25*Math.sin(time/800+i));const px=x+Math.cos(angle)*spread,py=y+Math.sin(angle)*spread;
    context.fillStyle=effect==='confetti'?['#c4ff2d','#34cfff','#ff7eb9'][i%3]:'#c4ff2d';context.beginPath();
    if(effect==='confetti')context.fillRect(px-4,py-4,8,12);else{context.moveTo(px,py-8);context.lineTo(px+3,py-2);context.lineTo(px+8,py);context.lineTo(px+2,py+3);context.lineTo(px,py+8);context.lineTo(px-3,py+2);context.lineTo(px-8,py);context.lineTo(px-2,py-3);context.closePath();context.fill();}
  }context.restore();
}
export async function captureArPhoto(video:HTMLVideoElement,overlay:HTMLCanvasElement):Promise<File>{
  if(video.readyState<2||!video.videoWidth||!video.videoHeight||!video.srcObject)throw new Error('請先開啟相機，等畫面出現後再拍照。');
  const canvas=document.createElement('canvas');const scale=Math.min(1,1920/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
  const c=canvas.getContext('2d')!;c.drawImage(video,0,0,canvas.width,canvas.height);c.drawImage(overlay,0,0,canvas.width,canvas.height);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('照片未產生，請重試。')),'image/jpeg',0.92));
  return new File([blob],`freedom-ar-${new Date().toISOString().replace(/[:.]/g,'-')}.jpg`,{type:'image/jpeg'});
}
