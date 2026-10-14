/** Rebuild only the reviewed browser image distribution. Pass the directory
 * containing the four SRI-verified npm dist files + LICENSE. No network or
 * production resource mutation; every upstream byte must match the manifest. */
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {rolldown} from 'rolldown';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..');
const source=resolve(process.argv[2]??''),assets=resolve(root,'apps/portal-web/public/assets');
const manifestPath=resolve(here,'manifest.json'),manifest=JSON.parse(readFileSync(manifestPath));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const upstream={};
for(const [name,sha] of Object.entries(manifest.sourceSha256)){
  const bytes=readFileSync(resolve(source,name));if(hash(bytes)!==sha)throw new Error(`Unreviewed upstream bytes: ${name}`);upstream[name]=bytes.toString();
}
const emitted={};
function emit(prefix,text){const sha=hash(text),name=`${prefix}-${sha.slice(0,8)}.js`;writeFileSync(resolve(assets,name),text);emitted[name]=sha;return name;}
const ui=emit('mindar-ui',upstream['ui-fBadYuor.js']);
let controller=upstream['controller-mGt1s8dJ.js'];
for(const [constant,factory,prefix] of [['IC','A5','mindar-compiler'],['GC','WY','mindar-tracker']]){
  const re=new RegExp(constant==='IC'?`^const ${constant} = "([^"]+)"[^\\n]*\\n`:`^}, ${constant} = "([^"]+)"[^\\n]*\\n`,'m'),match=re.exec(controller);if(!match)throw new Error(`Worker shape changed: ${constant}`);
  const worker=emit(prefix,Buffer.from(match[1],'base64').toString());controller=controller.replace(re,constant==='IC'?'':'};\n');
  const start=controller.indexOf(`function ${factory}(n) {`),end=controller.indexOf('\n}',start)+2;if(start<0||end<2)throw new Error(`Worker factory changed: ${factory}`);
  controller=controller.slice(0,start)+`function ${factory}(n) { return new Worker("/assets/${worker}", {name:n?.name}); }`+controller.slice(end);
}
controller=controller.replaceAll('./ui-fBadYuor.js',`./${ui}`);
const loop='    (async () => {\n      for (; this.processingVideo; ) {';
if(controller.split(loop).length!==2)throw new Error('Processing lifetime shape changed');
// Expose the actual processing lifetime for cancellation, errors and owned
// tensor disposal. Upstream otherwise silently discards this Promise.
controller=controller.replace(loop,'    return (async () => {\n      for (; this.processingVideo; ) {');
const bundle=await rolldown({input:'reviewed-controller',external:[`./${ui}`],plugins:[{name:'reviewed-mindar',resolveId:id=>id==='reviewed-controller'?id:null,load:id=>id==='reviewed-controller'?controller:null}]});
const output=await bundle.generate({format:'es',minify:true,comments:{legal:true},paths:{[ui]:`./${ui}`,[`./${ui}`]:`./${ui}`}});await bundle.close();
const code=output.output.find(item=>item.type==='chunk')?.code;if(!code)throw new Error('Missing browser controller');
const controllerName=emit('mindar-controller',code);
const entry=emit('mindar-image',upstream['mindar-image.prod.js'].replaceAll('./controller-mGt1s8dJ.js',`./${controllerName}`).replaceAll('./ui-fBadYuor.js',`./${ui}`));
const oldNames=Object.keys(manifest.browserAssets);manifest.browserAssets=emitted;
manifest.modifications=manifest.modifications.filter(value=>!value.startsWith('Exposed the processing'));
manifest.modifications.push('Exposed the processing loop Promise for cancellation/error handling and disposal; tracker inference is unchanged.');
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
const descriptorPath=resolve(here,'../freedom.module.json'),descriptor=JSON.parse(readFileSync(descriptorPath));
descriptor.owned_paths=descriptor.owned_paths.filter(path=>!oldNames.some(name=>path===`apps/portal-web/public/assets/${name}`));
descriptor.owned_paths.push(...Object.keys(emitted).map(name=>`apps/portal-web/public/assets/${name}`));writeFileSync(descriptorPath,JSON.stringify(descriptor,null,2)+'\n');
writeFileSync(resolve(root,'apps/portal-web/src/modules/community-ar/sdk-location.ts'),`export const AR_SDK_URL='/assets/${entry}';\n`);
for(const old of oldNames)if(!emitted[old])unlinkSync(resolve(assets,old));
console.log(JSON.stringify({entry,assets:emitted},null,2));
