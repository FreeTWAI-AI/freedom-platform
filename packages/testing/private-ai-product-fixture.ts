import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import type { Pool } from 'pg';
import { DEMO_USERS, DEMO_PASSWORD } from './seed.js';
import { e2eSchema } from './e2e-auth-isolation.js';
import { login } from '../../modules/identity-membership/service.js';
import { withMemberScope } from '../resource-scopes/index.js';
import { transaction } from '../db/transaction.js';
import { createRuntimeRegistrations } from '../../modules/agent-control/runtime-registration.js';
import { createAgentConnections } from '../../modules/agent-control/agent-connections.js';
import { insertInitialRefreshFamily } from '../../modules/agent-control/bootstrap-session-store.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createLocalFixtureModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { createPrivateAiProductTransport } from '../../apps/platform-api/src/private-ai-product.js';
import { FakeObjectStore } from '../asset-storage/fake-store.js';
import type { ModelSelection } from '../../contracts/execution/v1/member-execution.js';

/** Local browser-test fixture only. Neither the product server nor Worker
 * imports this file. All credential bytes and provider responses are synthetic. */
export async function createPrivateAiBrowserFixture(owner: Pool, runtime: Pool, origin: string) {
  const schema = e2eSchema(process.env.FREEDOM_E2E_SCHEMA);
  if (process.env.FREEDOM_E2E_PRIVATE_AI_FIXTURE !== '1'
    || (await owner.query('SELECT current_schema() schema')).rows[0].schema !== schema
    || (await runtime.query('SELECT current_schema() schema')).rows[0].schema !== schema
    || new URL(origin).hostname !== '127.0.0.1') throw new Error('Private AI browser fixture isolation required.');
  const role = (await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (role.rolsuper || role.rolbypassrls) throw new Error('Private AI fixture app must use an ordinary runtime role.');
  const clientId = 'private-ai-browser-fixture';
  const selection: ModelSelection = { providerRef: 'openai', modelRef: 'synthetic-text-model', processingLocation: 'provider_remote',
    artifactCustody: 'platform_asset', credentialCustody: 'platform_vault', engineLocation: 'platform', billingSource: 'user_byok' };
  let providerPosts = 0, providerModelChecks = 0, storePuts = 0;
  class BrowserStore extends FakeObjectStore {
    override async putImmutable(...args: Parameters<FakeObjectStore['putImmutable']>) {
      const value = await super.putImmutable(...args); storePuts++; return value;
    }
  }
  const provider = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== 'Bearer synthetic-browser-fixture-only') { response.writeHead(401); response.end('{}'); return; }
    if (request.method === 'GET' && request.url === '/v1/models/synthetic-text-model') {
      providerModelChecks++; response.end(JSON.stringify({id:selection.modelRef,object:'model',created:0,owned_by:'synthetic-browser-fixture'})); return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404); response.end('{}'); return; }
    let size = 0, raw = ''; request.on('data', chunk => { size += chunk.length; if (size > 32768) request.destroy(); else raw += chunk; });
    request.on('end', async () => {
      try {
        const input = JSON.parse(raw);
        if (input.model !== selection.modelRef || !Array.isArray(input.tools) || input.tools.length
          || input.tool_choice !== 'none' || !Number.isInteger(input.max_output_tokens) || input.max_output_tokens < 8) throw new Error();
        providerPosts++;
        // Test-only provider-response gate, scoped to this isolated schema.
        // Browser tests may hold this advisory key while the real dispatch is
        // pending; ordinary fixture calls pass through immediately.
        const gate = await owner.connect();
        try {
          await gate.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`private-ai-browser-provider/${schema}`]);
        } finally {
          await gate.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`private-ai-browser-provider/${schema}`]); gate.release();
        }
        response.end(JSON.stringify({id:'synthetic-browser-response',object:'response',model:selection.modelRef,status:'completed',
          output:[{id:'synthetic-browser-message',type:'message',role:'assistant',status:'completed',
            content:[{type:'output_text',text:'這是本人可讀的私人 AI 草稿。\n本機合成模型回應，沒有公開分享。',annotations:[]}]}],
          usage:{input_tokens:8,output_tokens:8,total_tokens:16}}));
      } catch { response.writeHead(400); response.end('{}'); }
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Fixture provider bind failed.');
  const close = () => new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); });
  try {
    const { actor } = await login(runtime, DEMO_USERS[0].email, DEMO_PASSWORD);
    const context = await withMemberScope(runtime, { actor, scope:'personal' }, async()=>{}, async(_q,c)=>c);
    await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision,persistence_allowed,retained_byte_limit)
      VALUES($1,$2,'work.private-draft',1,true,1048576)`,[context.scope.scope_id,context.subject_principal.principal_id]);
    await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,
      revision,export_allowed,max_prompt_bytes,max_output_tokens) VALUES($1,$2,$3,'local',$4,$5,1,true,16384,256)`,
    [randomUUID(),context.scope.scope_id,context.subject_principal.principal_id,clientId,JSON.stringify(selection)]);
    const enrollment = createRuntimeRegistrations(runtime,{environment:'local'}), keys = await generateKeyPair('ES256',{extractable:true});
    const challenge = await enrollment.begin(actor,{key:randomUUID(),publicJwk:parseRuntimePublicJwk(await exportJWK(keys.publicKey))});
    const proof = await new CompactSign(new TextEncoder().encode(challenge.payload))
      .setProtectedHeader({alg:'ES256',typ:'freedom-runtime-enrollment+jws'}).sign(keys.privateKey);
    const device = await enrollment.confirm(actor,{key:randomUUID(),challengeId:challenge.challenge_id,proof});
    const connection = await createAgentConnections(runtime,{environment:'local',clientId}).create(actor,{key:randomUUID(),runtimeDeviceId:device.runtimeDeviceId});
    await transaction(runtime,q=>insertInitialRefreshFamily(q,connection.connectionId,new Date(connection.issuedAt),new Date(connection.expiresAt)));
    const host = createLocalFixtureModelStepHost({environment:'local',origin:`http://127.0.0.1:${address.port}`,
      recover:async()=>({generation:'1',expiresAt:new Date(Date.now()+3600000).toISOString()}),
      resolveCredential:async()=>({key:new TextEncoder().encode('synthetic-browser-fixture-only'),expiresAt:new Date(Date.now()+3600000).toISOString()})});
    const transport = await createPrivateAiProductTransport(runtime,{origin,environment:'local',clientId,host,store:new BrowserStore()});
    return { transport, close, evidence:()=>({schema,providerModelChecks,providerPosts,storePuts,app_role_superuser:false,
      evidence_origin:'synthetic_local_fixture',real_provider_calls:false}) };
  } catch (error) { await close(); throw error; }
}
