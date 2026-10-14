export type ArImage={blob:Blob;previewUrl:string;width:number;height:number;advice:string;contrast:number;coverage:number};
/** On-device decode, orient, bound dimensions, remove metadata. Score is advice,
 * never an inference-success percentage or proof of printed cloth quality. */
export async function prepareArImage(file:File,signal:AbortSignal):Promise<ArImage>{
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024||!file.size)throw new Error('請選擇 8 MB 以下的 JPEG、PNG 或 WebP 圖片。');
  const source=URL.createObjectURL(file),img=new Image();
  try{
    const load=new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('這張圖片無法讀取，請換一張。'));img.src=source;});
    await Promise.race([load,new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))]);
    if(signal.aborted)throw new DOMException('Aborted','AbortError');
    if(Math.min(img.naturalWidth,img.naturalHeight)<128||img.naturalWidth*img.naturalHeight>40_000_000)throw new Error('圖片至少需要 128 × 128 像素，請避免超大型圖片。');
    const scale=Math.min(1,1024/Math.max(img.naturalWidth,img.naturalHeight));
    if(img.naturalWidth/img.naturalHeight>4||img.naturalHeight/img.naturalWidth>4)throw new Error('圖案太細長，請裁成 1:4 到 4:1 之間，讓衣服與手機更容易掃描。');
    const canvas=document.createElement('canvas');canvas.width=Math.round(img.naturalWidth*scale);canvas.height=Math.round(img.naturalHeight*scale);
    if(Math.min(canvas.width,canvas.height)<64)throw new Error('圖案太細長，請改用接近正方形或橫幅的圖片。');
    const context=canvas.getContext('2d');if(!context)throw new Error('這個瀏覽器無法處理圖片。');
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(img,0,0,canvas.width,canvas.height);
    const analysis=document.createElement('canvas');analysis.width=128;analysis.height=Math.max(16,Math.round(canvas.height/canvas.width*128));
    const c=analysis.getContext('2d')!;c.drawImage(canvas,0,0,analysis.width,analysis.height);const pixels=c.getImageData(0,0,analysis.width,analysis.height).data;
    let sum=0,squared=0;const gray=new Float32Array(pixels.length/4),cells=new Set<number>();
    for(let i=0;i<gray.length;i++){gray[i]=(pixels[i*4]+pixels[i*4+1]+pixels[i*4+2])/3;sum+=gray[i];squared+=gray[i]*gray[i];}
    for(let y=1;y<analysis.height-1;y++)for(let x=1;x<analysis.width-1;x++){
      const i=y*analysis.width+x;if(Math.abs(gray[i-1]-gray[i+1])>24&&Math.abs(gray[i-analysis.width]-gray[i+analysis.width])>24)cells.add(Math.floor(x/analysis.width*4)+4*Math.floor(y/analysis.height*4));
    }
    const contrast=Math.sqrt(Math.max(0,squared/gray.length-(sum/gray.length)**2)),coverage=cells.size/16;
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('圖片處理未完成，請重試。')),'image/png'));
    if(signal.aborted)throw new DOMException('Aborted','AbortError');
    return {blob,previewUrl:URL.createObjectURL(blob),width:canvas.width,height:canvas.height,contrast,coverage,
      advice:contrast<20||coverage<0.4?'圖案細節偏少。增加不同大小的文字、線條或照片，並避免重複格紋。':'圖案細節分布可供試掃。請再用實際印刷品確認辨識。'};
  }finally{img.src='';URL.revokeObjectURL(source);}
}
