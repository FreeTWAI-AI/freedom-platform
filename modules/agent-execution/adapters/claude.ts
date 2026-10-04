import { z } from 'zod';
import { isAbsolute, normalize } from 'node:path';
import { snapshotBoundedBytes } from '../../../packages/asset-storage/index.js';
import { AdapterFault, parseAdapterTextInput, parseModelJson, assertOutputText,
  type CliArtifact, type CliProbe, type CliObservation, type AdapterAssessment,
  type PreparedCliInvocation, type DecodedModelText, type AdapterIssue } from './common.js';

const version='2.1.288',sha256='0298068b686e7fdbaf9402a7a587bb7f49c0b0e084de09f69145a0719207640c';
const fullModel=z.string().min(1).max(96).regex(/^claude-[a-z0-9]+(?:-[a-z0-9]+)+$(?![\s\S])/);
function assessment(authentication:AdapterAssessment['authentication']='unknown',blockers:readonly AdapterIssue[]=['effective_tool_policy_unavailable'],installedVersion?:string):AdapterAssessment {
  return Object.freeze({route:'claude_subscription',support:'unsupported',authentication,blockers:Object.freeze([...blockers]),
    ...(installedVersion===undefined?{}:{installedVersion}),operational_authority:false});
}
function chosen(raw:unknown) {
  const input=parseAdapterTextInput(raw),s=input.selection;
  if(s.providerRef!=='anthropic'||s.credentialCustody!=='official_cli'||s.engineLocation!=='runtime_local'||s.processingLocation!=='provider_remote'
    ||!fullModel.safeParse(s.modelRef).success)throw new AdapterFault('unsupported_selection');
  if(s.billingSource!=='user_cli')throw new AdapterFault('billing_route_mismatch');
  return input;
}
function observation(raw:CliObservation):CliObservation {
  try {
    if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).some(k=>typeof k!=='string'||!['exitCode','signal','stdout','stderr'].includes(k)))throw new Error();
    const d:Record<string,PropertyDescriptor>=Object.getOwnPropertyDescriptors(raw);
    if(Object.keys(d).length!==4||Object.values(d).some(v=>!v.enumerable||!('value'in v)))throw new Error();
    if(d.exitCode.value!==null&&(!Number.isInteger(d.exitCode.value)||d.exitCode.value<0||d.exitCode.value>255)
      ||d.signal.value!==null&&typeof d.signal.value!=='string')throw new Error();
    return {exitCode:d.exitCode.value,signal:d.signal.value,stdout:snapshotBoundedBytes(d.stdout.value,32768),stderr:snapshotBoundedBytes(d.stderr.value,8192)};
  }catch(error){if((error as {code?:string})?.code==='too_large')throw new AdapterFault('response_limit');throw new AdapterFault('invalid_response');}
}
function cliVersion(raw:CliObservation):string {
  const o=observation(raw);
  if(o.exitCode!==0||o.signal!==null||o.stdout.byteLength>128)throw new AdapterFault('unsupported_version');
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(o.stdout);}catch{throw new AdapterFault('unsupported_version');}
  if(text!==version+' (Claude Code)\n'&&text!==version+' (Claude Code)')throw new AdapterFault('unsupported_version');
  return version;
}
/** Private bounded CLI codec and metadata probes. No current profile can prove
 * effective subscription policy; invoke deliberately has no process/model port. */
export function createClaudeSubscriptionAdapter(options:{artifact:CliArtifact;probe:CliProbe}) {
  let artifact:CliArtifact,probe:CliProbe['probe'];
  try {
    if(!options||Object.getPrototypeOf(options)!==Object.prototype||Reflect.ownKeys(options).some(k=>typeof k!=='string'||!['artifact','probe'].includes(k)))throw new Error();
    const d:Record<string,PropertyDescriptor>=Object.getOwnPropertyDescriptors(options);
    if(Object.keys(d).length!==2||Object.values(d).some(v=>!v.enumerable||!('value'in v)))throw new Error();
    const a=d.artifact.value,p=d.probe.value;
    if(!a||Object.getPrototypeOf(a)!==Object.prototype||Reflect.ownKeys(a).some(k=>typeof k!=='string'||!['executable','sha256','version'].includes(k)))throw new Error();
    const ad:Record<string,PropertyDescriptor>=Object.getOwnPropertyDescriptors(a);
    if(Object.keys(ad).length!==3||Object.values(ad).some(v=>!v.enumerable||!('value'in v)))throw new Error();
    if(typeof ad.executable.value!=='string'||ad.executable.value.length>4096||!isAbsolute(ad.executable.value)
      ||normalize(ad.executable.value)!==ad.executable.value||/[\\\x00-\x20\x7f]/.test(ad.executable.value))throw new Error();
    artifact=Object.freeze({executable:ad.executable.value,sha256:ad.sha256.value,version:ad.version.value});
    if(!p||Object.getPrototypeOf(p)!==Object.prototype||Reflect.ownKeys(p).length!==1)throw new Error();
    const pd=Object.getOwnPropertyDescriptor(p,'probe');
    if(!pd?.enumerable||!('value'in pd)||typeof pd.value!=='function')throw new Error();
    probe=pd.value.bind(p);
  }catch{throw new AdapterFault('invalid_input');}
  if(artifact.version!==version)throw new AdapterFault('unsupported_version');
  if(artifact.sha256!==sha256)throw new AdapterFault('artifact_mismatch');
  async function inspect():Promise<AdapterAssessment> {
    let installedVersion:string;
    try{installedVersion=cliVersion(await probe('version'));}catch(error){return assessment('unknown',[error instanceof AdapterFault?error.code:'probe_unavailable']);}
    try {
      const help=observation(await probe('help'));
      if(help.exitCode!==0||help.signal!==null)throw new AdapterFault('probe_unavailable');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(help.stdout);
      if(!['--restricted','--safe-mode','--tools','--strict-mcp-config','--permission-prompts','--no-session-persistence'].every(flag=>text.includes(flag)))return assessment('unknown',['unsupported_version'],installedVersion);
      const status=observation(await probe('auth_status'));
      if(status.signal!==null||![0,1].includes(status.exitCode??-1))throw new AdapterFault('probe_unavailable');
      if(status.stdout.byteLength>8192)throw new AdapterFault('response_limit');
      const parsed=z.object({loggedIn:z.boolean(),authMethod:z.enum(['none','claude.ai','oauth_token','api_key','api_key_helper','third_party'])}).passthrough().safeParse(parseModelJson(status.stdout));
      if(!parsed.success||parsed.data.loggedIn!==(status.exitCode===0))throw new AdapterFault('invalid_response');
      // Saved account/provider/billing metadata is never an authentication proof.
      const auth=parsed.data.loggedIn&&parsed.data.authMethod==='claude.ai'?'local_observed_subscription':parsed.data.loggedIn&&['api_key','api_key_helper'].includes(parsed.data.authMethod)?'local_observed_api_key':'unavailable';
      return assessment(auth,auth==='local_observed_subscription'?['effective_tool_policy_unavailable']:['authentication_unavailable','effective_tool_policy_unavailable'],installedVersion);
    }catch(error){return assessment('unknown',[error instanceof AdapterFault?error.code:'probe_unavailable','effective_tool_policy_unavailable'],installedVersion);}
  }
  function prepare(raw:unknown):PreparedCliInvocation {
    const input=chosen(raw);
    const settings=JSON.stringify({disableAllHooks:true,disableClaudeAiConnectors:true,autoMemoryEnabled:false,availableModels:[input.selection.modelRef],fallbackModel:[],switchModelsOnFlag:false});
    const argv=Object.freeze(['--print','--restricted','--safe-mode','--setting-sources','','--settings',settings,'--tools','',
      '--disallowedTools','*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--permission-mode','dontAsk','--permission-prompts','none',
      '--no-session-persistence','--disable-slash-commands','--no-chrome','--model',input.selection.modelRef,'--input-format','text','--output-format','json','--max-turns','1']);
    return Object.freeze({kind:'cli_text_candidate',argv,stdin:new TextEncoder().encode(input.prompt),environment:Object.freeze({CLAUDE_CODE_MAX_OUTPUT_TOKENS:String(input.maxOutputTokens),CLAUDE_CODE_MAX_RETRIES:'0',DISABLE_UPDATES:'1',DISABLE_TELEMETRY:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'false'}),assessment:assessment(),operational_authority:false});
  }
  function decode(rawObservation:CliObservation,raw:unknown):DecodedModelText {
    const input=chosen(raw),o=observation(rawObservation);
    if(o.signal!==null||o.exitCode===null)throw new AdapterFault('outcome_unknown');
    if(o.exitCode!==0)throw new AdapterFault('outcome_unknown');
    const tokens=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),cost=z.number().finite().nonnegative();
    const usageSchema=z.object({inputTokens:tokens,outputTokens:tokens,cacheReadInputTokens:tokens.optional(),
      cacheCreationInputTokens:tokens.optional(),webSearchRequests:z.literal(0).optional(),costUSD:cost.optional(),
      contextWindow:tokens.optional(),maxOutputTokens:tokens.optional()}).strict();
    const aggregateUsage=z.object({input_tokens:tokens,output_tokens:tokens,cache_creation_input_tokens:tokens.optional(),
      cache_read_input_tokens:tokens.optional(),cache_creation:z.object({ephemeral_1h_input_tokens:tokens,ephemeral_5m_input_tokens:tokens}).strict().optional(),
      server_tool_use:z.object({web_search_requests:z.literal(0),web_fetch_requests:z.literal(0)}).strict().optional(),
      service_tier:z.string().max(64).nullable().optional(),inference_geo:z.string().max(96).nullable().optional()}).strict();
    // This candidate requests one text-only turn, never structured-output tools.
    // Unknown fields are incompatible evidence rather than ignorable metadata.
    const parsed=z.object({type:z.literal('result'),subtype:z.literal('success'),is_error:z.literal(false),result:z.string().min(1),
      num_turns:z.literal(1).optional(),permission_denials:z.tuple([]).optional(),stop_reason:z.literal('end_turn').nullable().optional(),
      modelUsage:z.record(z.string(),usageSchema),usage:aggregateUsage.optional(),session_id:z.string().min(1).max(256).optional(),
      uuid:z.string().min(1).max(256).optional(),duration_ms:tokens.optional(),duration_api_ms:tokens.optional(),total_cost_usd:cost.optional()
    }).strict().safeParse(parseModelJson(o.stdout));
    if(!parsed.success)throw new AdapterFault('invalid_response');
    const names=Object.keys(parsed.data.modelUsage);
    if(names.length!==1||names[0]!==input.selection.modelRef)throw new AdapterFault('model_mismatch');
    const usage=parsed.data.modelUsage[input.selection.modelRef];
    if(usage.outputTokens>input.maxOutputTokens)throw new AdapterFault('response_limit');
    // Cache/read counters and cost metadata are deliberately not inferred into
    // totalTokens. The text remains untrusted, with no Result/policy authority.
    return Object.freeze({text:assertOutputText(parsed.data.result),modelRef:input.selection.modelRef,reportedModelRef:input.selection.modelRef,
      usage:Object.freeze({inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,totalTokens:null}),evidence:'unverified_provider_output',operational_authority:false});
  }
  async function invoke(raw:unknown):Promise<never> {chosen(raw);throw new AdapterFault('execution_authority_unavailable');}
  return Object.freeze({inspect,prepare,decode,invoke});
}
