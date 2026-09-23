import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocol,schemas,operations } from '../contracts/preview/v1/definition.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(root,'contracts/preview/v1');
const hash=b=>createHash('sha256').update(b).digest('hex');
const protocolHash=hash(JSON.stringify(protocol));
const metadata={protocol:protocol.version,revision:protocol.revision,protocol_sha256:protocolHash,operations:Object.keys(operations),authentication:protocol.auth,external_job_execution:false,public_checkout:false};
const files={};
async function emit(name,contents){const target=resolve(out,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,contents);files[name]={sha256:hash(contents),bytes:Buffer.byteLength(contents)};}
const pretty=v=>JSON.stringify(v,null,2)+'\n';
const paths={};
for(const [id,op]of Object.entries(operations)){
 const parameters=[...op.path.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string',...(m[1]==='id'?{format:'uuid'}:{pattern:'^[a-z][a-z0-9_]{1,100}$'})}}));
 if(op.idempotent)parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{8,128}$'}});
 if(op.concurrency!=='none')parameters.push({name:'If-Match',in:'header',required:op.concurrency==='required',schema:{type:'string',pattern:'^"[1-9][0-9]*"$'}});
 if(op.method==='POST'){parameters.push({name:'Origin',in:'header',required:true,schema:{type:'string',format:'uri'}});if(op.auth)parameters.push({name:'X-CSRF-Token',in:'header',required:true,schema:{type:'string'}});}
 const content=name=>({'application/json':{schema:{$ref:`#/components/schemas/${name}`}}});
 (paths[op.path]??={})[op.method.toLowerCase()]={operationId:id,summary:id,security:op.auth?[{MemberSession:[]}]:[],parameters,...(op.body?{requestBody:{required:true,content:content(op.body)}}:{}),responses:{[op.status]:{description:'Implemented preview response',content:content(op.response)},default:{description:'Structured problem; conflict is never automatically retried',content:content('Problem')}},'x-idempotent-command':op.idempotent,'x-concurrency':op.concurrency};
}
await emit('openapi.json',pretty({openapi:'3.1.1',info:{title:'Freedom implemented member module API subset',version:protocol.revision,description:'Member-session module API subset. Registration/onboarding and scoped read-connections have separate interface documents. Public checkout, production OAuth and leased executors are not implemented by this bundle.'},servers:[{url:'/api/v1'}],paths,components:{schemas,securitySchemes:{MemberSession:{type:'apiKey',in:'cookie',name:'freedom_local_session'}}}}));
await emit('metadata.json',pretty(metadata));
await emit('protocol.mjs',`// GENERATED. Change definition.mjs and rebuild in freedom-platform.\nexport const protocol=${pretty(protocol)};\nexport const protocolSha256=${JSON.stringify(protocolHash)};\n`);
for(const name of ['client.mjs','schema.mjs'])await emit(name,await readFile(resolve(root,'packages/sdk',name)));
function ts(s){if(s.$ref)return s.$ref.split('/').at(-1);if(s.anyOf)return s.anyOf.map(ts).join(' | ');if('const'in s)return JSON.stringify(s.const);if(s.enum)return s.enum.map(v=>JSON.stringify(v)).join(' | ');if(s.type==='array')return `Array<${ts(s.items??{})}>`;if(s.type==='object'){const entries=Object.entries(s.properties??{}).map(([k,v])=>`${JSON.stringify(k)}${s.required?.includes(k)?'':'?'}: ${ts(v)}`);if(s.additionalProperties!==false)entries.push('[key: string]: unknown');return `{ ${entries.join('; ')} }`;}return ({integer:'number',number:'number',string:'string',boolean:'boolean',null:'null'})[s.type]??'unknown';}
const dts=Object.entries(schemas).map(([name,s])=>`export type ${name} = ${ts(s)};`).join('\n')+'\nexport interface Operations {\n'+Object.entries(operations).map(([id,op])=>` ${id}: { response: ${op.response}; body: ${op.body??'never'} };`).join('\n')+'\n}\n'+`export interface ClientOptions {baseUrl:string;appOrigin?:string;fetcher?:typeof fetch;cookie?:string;csrfToken?:string;timeoutMs?:number}\nexport interface CallOptions<B> {params?:Record<string,string>;body?:B;idempotencyKey?:string;version?:number}\nexport class PlatformError extends Error {status:number;code:string}\nexport class PlatformClient {constructor(options:ClientOptions);call<K extends keyof Operations>(operationId:K,options?:CallOptions<Operations[K]['body']>):Promise<Operations[K]['response']>;assertCompatible():Promise<Protocol>;static loginDemo(options:ClientOptions & {email:string;password:string}):Promise<PlatformClient>}\nexport const protocol: {version:string;revision:string;operations:Record<string,unknown>};\n`;
await emit('client.d.mts',dts);
for(const name of ['project-manifest.schema.json','skill-package.schema.json','event-envelope.schema.json'])await emit('schemas/'+name,await readFile(resolve(root,'docs/platform-plan/contracts',name)));
await writeFile(resolve(out,'bundle.json'),pretty({format:'freedom.contract-bundle/v1',protocol:protocol.version,revision:protocol.revision,protocol_sha256:protocolHash,files}));
// SDK source is tested against the same generated protocol, not an independent definition.
await writeFile(resolve(root,'packages/sdk/protocol.mjs'),await readFile(resolve(out,'protocol.mjs')));
await writeFile(resolve(root,'packages/sdk/client.d.mts'),dts);
console.log(`Built ${Object.keys(operations).length} operations and ${Object.keys(files).length} exact bundle artifacts.`);
