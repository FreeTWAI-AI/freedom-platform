// Reproducible app-icon export: the original brand image is contained, never cropped or redrawn.
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const directory=new URL('../apps/portal-web/public/brand/',import.meta.url);
const original=await readFile(new URL('freedom-workshop.webp',directory));
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();
  for(const size of [180,192,512]){
    const base64=await page.evaluate(async({source,size})=>{
      const image=new Image();image.src=`data:image/webp;base64,${source}`;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
      const context=canvas.getContext('2d');if(!context)throw Error('Canvas export unavailable');
      context.fillStyle='#08090b';context.fillRect(0,0,size,size);
      const width=size*.70,height=width*image.naturalHeight/image.naturalWidth;
      context.drawImage(image,(size-width)/2,(size-height)/2,width,height);
      return canvas.toDataURL('image/png').split(',')[1];
    },{source:original.toString('base64'),size});
    await writeFile(new URL(`app-icon-${size}.png`,directory),Buffer.from(base64,'base64'));
    console.log(`Original brand contained in ${size}x${size} app icon`);
  }
}finally{await browser.close();}
