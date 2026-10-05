/** One namespace classifier for the platform installer and private product.
 * Classification only reserves a path; each purpose-specific child retains
 * exact method, origin, credential and bounded-body admission. */
const families=Object.freeze({
  'private-work':{purpose:'work',installed:false},
  'execution-runs':{purpose:'prerequisites',installed:false},
  'model-connections':{purpose:'prerequisites',installed:false},
  'execution-grants':{purpose:'prerequisites',installed:false},
  'execution-attempts':{purpose:'prerequisites',installed:false},
  'model-step-overview':{purpose:'member-model',installed:true},
  'model-step-approvals':{purpose:'member-model',installed:true},
  'model-steps':{purpose:'member-model',installed:true},
  'credential-ingests':{purpose:'ingest',installed:true},
  'model-settings':{purpose:'settings',installed:true},
  'model-credentials':{purpose:'settings',installed:true},
  'device-authorizations':{purpose:'bootstrap',installed:true},
  'agent-connections':{purpose:'bootstrap',installed:true},
} as const);
export type PrivateAiPurpose='work'|'prerequisites'|'member-model'|'ingest'|'settings'|'bootstrap'|'machine-model';
export interface PrivateAiPath {readonly purpose:PrivateAiPurpose;readonly requiresInstallation:boolean;readonly normalized:boolean}
const matches=(path:string,base:string)=>path===base||path.startsWith(base+'/')||path.startsWith(base+':');
function owned(path:string):Omit<PrivateAiPath,'normalized'>|undefined{
  if(matches(path,'/execution-api/v1/model-steps'))return {purpose:'machine-model',requiresInstallation:true};
  if(path==='/execution-api/v1'||path.startsWith('/execution-api/v1/'))return {purpose:'bootstrap',requiresInstallation:true};
  for(const [family,value] of Object.entries(families))if(matches(path,'/api/v1/me/'+family))return {purpose:value.purpose,requiresInstallation:value.installed};
}
export function classifyPrivateAiPath(path:string):PrivateAiPath|undefined{
  const normalized=!/[?#%\\\x00-\x20\x7f-\uffff]/.test(path),direct=owned(path);
  if(direct)return Object.freeze({...direct,normalized});
  // Encoded aliases are reserved solely to reject them, never dispatched after
  // decoding. A second encoding layer is rejected by the same bounded check.
  let alias=path;
  for(let i=0;i<2&&alias.includes('%');i++){try{alias=decodeURIComponent(alias);}catch{return undefined;}const found=owned(alias);if(found)return Object.freeze({...found,normalized:false});}
  return undefined;
}
const headers=Object.freeze({'Cache-Control':'private, no-store','Pragma':'no-cache','Vary':'Origin, Cookie, Authorization, DPoP',
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Cross-Origin-Resource-Policy':'same-origin'});
/** Terminal installer boundary. Missing optional legacy families continue on
 * their existing member router; newly installed-only families cannot do so. */
export function installedPrivateAiResponse(request:Request,installed?:((request:Request)=>Promise<Response>)):Promise<Response>|Response|null{
  const path=classifyPrivateAiPath(new URL(request.url).pathname);if(!path)return null;
  const reject=(status:number,code:string)=>Response.json({type:'about:blank',title:code,status,code,detail:'Request could not be completed.'},{status,headers});
  if(!path.normalized)return reject(403,'host_rejected');
  if(installed)return installed(request);
  return path.requiresInstallation?reject(503,'private_ai_product_unavailable'):null;
}
