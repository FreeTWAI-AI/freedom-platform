import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../contracts/execution/v1/bootstrap.js';
import { BrokerModelSelectionSchema, ModelCredentialMetadataSchema, ModelCredentialReadSchema,
  type ModelCredentialRead } from '../../contracts/execution/v2/model-credential.js';
import { MemberModelSettingsOverviewSchema } from '../../contracts/execution/v2/member-model-settings.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';

const Configuration = z.object({ environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema,
  selections: z.array(BrokerModelSelectionSchema).max(50) }).strict();
type BrokerModelSelection = z.infer<typeof BrokerModelSelectionSchema>;
const ActorBinding = z.object({ user_id: OpaqueId, community_id: OpaqueId,
  session_hash: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/) }).strict();
const owned = 'owner_user_id=$1 AND owner_principal_id=$2 AND scope_id=$3 AND environment=$4 AND client_id=$5';
const credentialColumns = `credential_id AS "credentialId",model_connection_id AS "modelConnectionId",model_version::text AS "modelVersion",
  generation::text AS generation,aggregate_version::text AS "aggregateVersion",state,selection,recovery_generation::text AS "recoveryGeneration",
  issued_at AS "issuedAt",expires_at AS "expiresAt",terminal_at AS "terminalAt",replacement_credential_id AS "replacementCredentialId",false AS operational_authority`;

function captureActor(raw: Actor): Actor {
  const descriptors = raw && Object.getOwnPropertyDescriptors(raw);
  if (!descriptors || ['user_id','community_id','session_hash'].some(key => !descriptors[key] || !('value' in descriptors[key])))
    throw new Error('invalid_member_model_settings_actor');
  return Object.freeze(ActorBinding.parse(Object.fromEntries(['user_id','community_id','session_hash'].map(key => [key,descriptors[key].value])))) as Actor;
}

/** SQL-only member history. Configured choices carry no provider or execution authority. */
export function createMemberModelSettings(pool: Pool, raw: { environment: RuntimeEnvironment; clientId: string; selections: readonly BrokerModelSelection[] }) {
  const configuration = freezeTree(Configuration.parse(snapshotInput(raw)));
  async function current<T>(rawActor: Actor, read: (q: PoolClient, values: unknown[]) => Promise<T>) {
    const actor = captureActor(rawActor);
    try {
      return await withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context) => {
        requireCondition((await q.query(`SELECT user_id FROM users WHERE user_id=$1
          AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)`,[actor.user_id])).rowCount === 1,
          403,'onboarding_required','Complete onboarding.');
        const result = await read(q,[actor.user_id,context.subject_principal.principal_id,context.scope.scope_id,configuration.environment,configuration.clientId]);
        await assertCurrentSessionClock(q,actor);
        return result;
      });
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw new Problem(503,'member_model_settings_unavailable','Metadata source unavailable.');
    }
  }
  async function rows(q: PoolClient, sql: string, values: unknown[]) {
    return (await q.query(sql,values)).rows.map(row => Object.fromEntries(Object.entries(row)
      .map(([key,value]) => [key,value instanceof Date ? value.toISOString() : value])));
  }
  return Object.freeze({
    readOverview(actor: Actor) {
      return current(actor,async(q,values) => {
        const connections = await rows(q,`SELECT connection_id AS "connectionId",runtime_device_id AS "runtimeDeviceId",state,
          aggregate_version::text AS "aggregateVersion",expires_at AS "expiresAt" FROM agent_connections
          WHERE ${owned} ORDER BY issued_at DESC,connection_id LIMIT 50`,values);
        const models = await rows(q,`SELECT model_connection_id AS "modelConnectionId",connection_id AS "connectionId",runtime_device_id AS "runtimeDeviceId",
          family_id AS "familyId",environment,client_id AS "clientId",selection,state,aggregate_version::text AS "aggregateVersion",
          created_at AS "createdAt",false AS operational_authority FROM model_connections
          WHERE ${owned} ORDER BY created_at DESC,model_connection_id LIMIT 50`,values);
        const credentials = await rows(q,`SELECT ${credentialColumns} FROM broker_model_credentials
          WHERE ${owned} ORDER BY issued_at DESC,credential_id LIMIT 50`,values);
        const parsed = MemberModelSettingsOverviewSchema.safeParse({profile:'member-model-settings/v1',connections,models,credentials,
          selectionOptions:configuration.selections,setup:{state:'unavailable'},limit:50,operational_authority:false});
        if (!parsed.success) throw new Error('invalid_member_model_settings_metadata');
        return freezeTree(parsed.data);
      });
    },
    readCredential(actor: Actor, rawInput: ModelCredentialRead) {
      const input = ModelCredentialReadSchema.parse(snapshotInput(rawInput));
      return current(actor,async(q,values) => {
        const row = (await rows(q,`SELECT ${credentialColumns} FROM broker_model_credentials WHERE ${owned} AND credential_id=$6`,[...values,input.credentialId]))[0];
        requireCondition(row,404,'not_found','Credential not found.');
        const parsed = ModelCredentialMetadataSchema.safeParse(row);
        if (!parsed.success) throw new Error('invalid_member_model_settings_metadata');
        return freezeTree(parsed.data);
      });
    },
  });
}
