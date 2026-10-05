/** Reproducible, local-only import of the owner's approved AI Sister artwork.
 * Reads committed blobs from a supplied checkout; never changes that checkout,
 * fetches credentials, generates artwork, uploads objects or enables a release. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
if(args.length!==6 || args[0]!=='--source-repo' || args[2]!=='--wardrobe-root' || args[4]!=='--inventory' || [args[1],args[3],args[5]].some(value=>!value||value.startsWith('-')))throw Error('Usage: tsx scripts/import-ai-sister-guides.ts --source-repo <local-checkout> --wardrobe-root <approved-wardrobe-directory> --inventory <read-only-validation.json>');
const sourceRepo=resolve(args[1]),wardrobeRoot=resolve(args[3]);
const inventoryBytes=await readFile(resolve(args[5]));
const inventory=JSON.parse(inventoryBytes.toString('utf8')) as {sourceCommit:string;items:{key:string;persona:string;theme:string;status:string;assets:Record<string,{exists:boolean}>;poseMeta:Record<string,boolean>;validatedSha256:{normalized:string|null;poses:Record<string,string|null>}}[]};
const approvals=JSON.parse(await readFile(resolve(wardrobeRoot,'wardrobe_approval.json'),'utf8')) as {items:Record<string,{status:string}>};
const source={repository:'https://github.com/teddashh/Multi-Ai-Chatapp',commit:'563461cd61cbd35e7cb2b844cf804b774775c4bf'};
const version='ai-sister-v1-20261005';
const roster=[
  ['claude','Claude','姊妹','溫柔地整理思路，陪你找到下一步。',null,null],
  ['chatgpt','ChatGPT','姊妹','把想法拆成步驟，一起動手試試看。',null,null],
  ['gemini','Gemini','姊妹','換個角度探索，把靈感串在一起。',null,null],
  ['grok','Grok','姊妹','直球說重點，也別忘了保持好奇心。',null,null],
  ['deepseek','DeepSeek','閨蜜','先釐清條件，再一步步解開問題。','DeepSeek.png','DeepSeek.Expressions.png'],
  ['qwen','Qwen','閨蜜','整理資訊與表達，讓想法更清楚。','Qwen.png','Qwen.Expressions.png'],
  ['mistral','Mistral','閨蜜','俐落地抓住重點，留點空間給創意。','Mistral.png','Mistral.Expressions.png'],
  ['venice','Llama','閨蜜','帶著開放的想法，找找不同的路。','Llama.png','Llama.Expressions.png'],
  ['sakana','Sakana','閨蜜','從小小的嘗試，發現新的可能。','Sakana.png','Sakana.Expressions.png'],
  ['perplexity','Perplexity','閨蜜','從入口與來源開始，一起把線索理清。','Perplexity.png','Perplexity.Expressions.png'],
  ['glm','GLM','閨蜜','把事情安排妥當，穩穩往前走。','GLM_Profile.png',null],
  ['kimi','Kimi','閨蜜','慢慢讀懂細節，讓每一步都有著落。','Kimi.Profile.v1.2.png',null],
  ['hunyuan','Hunyuan','閨蜜','串起彼此的想法，一起完成作品。','Hunyuan.Profile.v1.2.png',null],
  ['minimax','MiniMax','閨蜜','讓創意變得具體，從一個小作品開始。','MiniMax.Profile.v1.2.png',null],
  ['nemotron','Nemotron','閨蜜','先核對流程與條件，再踏實完成工作。','Nemotron.Profile.v1.2.png',null],
  ['cohere','Cohere','閨蜜','整理合作的脈絡，讓大家更容易接上話。','Cohere.Profile.v1.2.png',null],
  ['mimo','MiMo','閨蜜','把日常待辦拆小，一件一件輕鬆完成。','MiMo.Profile.v1.2.png',null],
] as const;
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const blob=(path:string)=>execFileSync('git',['-C',sourceRepo,'show',`${source.commit}:${path}`],{maxBuffer:32*1024*1024});
const themes=[['tech','科技'],['finance','財經'],['politics','公共事務'],['education','教育'],['health','健康'],['environment','環境'],['law','法律'],['relationship','人際'],['family','居家'],['workplace','職場'],['science','科學'],['culture','文化'],['sports','運動'],['food','美食'],['travel','旅行'],['psychology','心理'],['philosophy','哲學'],['international','國際'],['media','媒體'],['festival','節慶']] as const;
if(inventory.sourceCommit!==source.commit)throw Error('Wardrobe validator source mismatch');
const assets:{logicalId:string;sha256:string;byteLength:number;mime:'image/webp';width:number;height:number}[]=[];
const provenance:{logicalId:string;sourcePath:string;sourceSha256:string;sha256:string;transform:object;receiptSha256?:string;sourceKind:string}[]=[];
const characters:Record<string,object>={};
async function art(id:string,part:string,path:string,maxSize:number,wardrobe=false,expectedSha256?:string|null){
  const original=wardrobe?await readFile(resolve(wardrobeRoot,path)):blob(path);
  if(expectedSha256 && digest(original)!==expectedSha256)throw Error(`Source bytes changed: ${path}`);
  const receipt=wardrobe?await readFile(resolve(wardrobeRoot,path.replace(/\.png$/,'.json'))).catch(()=>null):null;
  const logicalId=`${id}/${part}`;
  const transform={resize:{width:maxSize,height:maxSize,fit:'inside',withoutEnlargement:true},format:'webp',quality:82,effort:4};
  const {data,info}=await sharp(original,{limitInputPixels:4096*4096,failOn:'warning'}).rotate().resize(maxSize,maxSize,{fit:'inside',withoutEnlargement:true}).webp({quality:82,effort:4}).toBuffer({resolveWithObject:true});
  await mkdir(resolve(root,'assets/guide-packs',version,id),{recursive:true});
  await writeFile(resolve(root,'assets/guide-packs',version,logicalId+'.webp'),data);
  assets.push({logicalId,sha256:digest(data),byteLength:data.length,mime:'image/webp',width:info.width,height:info.height});
  provenance.push({logicalId,sourcePath:path,sourceKind:wardrobe?'approved-admin-wardrobe-snapshot':'git-blob',sourceSha256:digest(original),sha256:digest(data),transform,...(receipt?{receiptSha256:digest(receipt)}:{})});
  return logicalId;
}
async function importCharacter([id,name,family,intro]:typeof roster[number]){
  const portrait=await art(id,'portrait',`web/public/avatars/${id}.png`,128);
  const outfits=[];
  for(const [theme,label] of themes){
    const item=inventory.items.find(item=>item.persona===id && item.theme===theme);
    if(!item || item.status!=='approved' || approvals.items[item.key]?.status!=='approved' || !item.assets.outfit.exists || ['supported','challenged','victory'].some(pose=>!item.assets[pose].exists||!item.poseMeta[pose]))throw Error(`Unverified wardrobe ${id}/${theme}`);
    const [hero,supported,challenged,victory]=await Promise.all([
      art(id,`${theme}-outfit`,`tachie/outfits_v2_norm/doll_${id}__${theme}.png`,576,true,item.validatedSha256.normalized),
      ...(['supported','challenged','victory'] as const).map(pose=>art(id,`${theme}-${pose}`,`tachie/poses/react/doll_${id}__${theme}__${pose}.png`,576,true,item.validatedSha256.poses[pose])),
    ]);
    outfits.push({id:theme,label,hero,reactions:{wave:supported,think:challenged,cheer:victory},views:[hero,supported,challenged,victory],viewLabels:['日常站姿','鼓勵','思考','開心']});
  }
  const first=outfits[0]!;
  characters[id]={pageId:id,name,title:`AI Sister・${family}`,intro,accent:'var(--blue-ink)',backdropColor:'var(--bg)',portrait,hero:first.hero,frames:[],views:first.views,viewLabels:first.viewLabels,reactions:first.reactions,outfits};
  console.log(`Converted ${id}: 20 outfits and 60 poses`);
}
// Bounded conversion; stable sorting below makes output independent of scheduling.
for(let start=0;start<roster.length;start+=4)await Promise.all(roster.slice(start,start+4).map(importCharacter));
assets.sort((a,b)=>a.logicalId.localeCompare(b.logicalId,'en'));provenance.sort((a,b)=>a.logicalId.localeCompare(b.logicalId,'en'));
const manifest={schema:'freedom.guide-pack/v1',pack:'ai-sister',version,purpose:'platform-public',source,assets};
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const text=json(manifest),manifestSha256=digest(Buffer.from(text));
const packDir='apps/portal-web/src/modules/newcomer-guides/packs/ai-sister';
await mkdir(resolve(root,packDir),{recursive:true});
await writeFile(resolve(root,packDir,'characters.json'),json(Object.fromEntries(roster.map(([id])=>[id,characters[id]]))));
await writeFile(resolve(root,'contracts/guide-packs',version+'.json'),text);
await writeFile(resolve(root,'packages/public-guide-assets/ai-sister-manifest.generated.ts'),`// GENERATED by scripts/import-ai-sister-guides.ts; exact reviewed manifest bytes.\nexport const aiSisterManifestText=${JSON.stringify(text)};\n`);
await writeFile(resolve(root,'apps/portal-web/src/modules/newcomer-guides/ai-sister-release-pin.ts'),`// Exact bytes of contracts/guide-packs/${version}.json.\nexport const AI_SISTER_RELEASE_PIN={pack:'ai-sister',version:'${version}',manifestSha256:'${manifestSha256}',engineContractVersion:1} as const;\n`);
await writeFile(resolve(root,'packages/public-guide-assets/ai-sister-release.ts'),`/** OFF until publication receipts, a separate activation review, CI and merge. */\nexport const AI_SISTER_GUIDE_RELEASE=Object.freeze({enabled:false as boolean,pack:'ai-sister' as const,version:'${version}',manifestSha256:'${manifestSha256}',publisherReceipt:null});\n`);
await mkdir(resolve(root,'docs/design'),{recursive:true});
await writeFile(resolve(root,'docs/design/ai-sister-guide-art-manifest.json'),json({schema:'freedom.ai-sister-art-provenance/v1',source,version,manifestSha256,owner:'teddashh',authorization:'Owner requested reuse of their AI Sister characters for the Freedom Platform newcomer guide.',characterCount:17,canonicalIdentityNote:'venice is the upstream ID for the character displayed as Llama; ChatGPT retains its public name.',wardrobe:{source:'AI Sister Admin / 角色設計 / 服裝',validatorCommit:source.commit,inventorySha256:digest(inventoryBytes),approvedOutfits:340,validatedPoses:1020},processing:'Existing committed portraits and owner-approved wardrobe snapshot; size/format conversion preserves complete composition and alpha. No new image generation, cropping, inferred views or synthetic animation frames.',tool:{name:'sharp',version:sharp.versions.sharp},assets:provenance}));
console.log(JSON.stringify({pack:manifest.pack,version,characters:roster.length,assets:assets.length,bytes:assets.reduce((sum,asset)=>sum+asset.byteLength,0),manifestSha256,uploaded:false}));
