import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as c from '../../contracts/execution/v2/model-credential.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
for (const [name, schema] of [
  ['model-credential-binding', c.ModelCredentialBindingSchema], ['broker-credential-envelope', c.BrokerCredentialEnvelopeSchema],
  ['model-credential-metadata', c.ModelCredentialMetadataSchema], ['model-credential-create', c.ModelCredentialCreateSchema],
  ['model-credential-rotate', c.ModelCredentialRotateSchema], ['model-credential-read', c.ModelCredentialReadSchema],
  ['model-credential-revoke', c.ModelCredentialRevokeSchema], ['model-credential-resolver-pin', c.ModelCredentialResolverPinSchema],
  ['credential-recovery-header', c.SignedCredentialRecoveryHeaderSchema], ['credential-recovery-state', c.SignedCredentialRecoveryStateSchema],
  ['credential-recovery-floor', c.CredentialRecoveryFloorSchema],
] as const) {
  const path = new URL(`../../contracts/execution/v2/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v2/${name}`,
    description: 'Closed broker-internal structural data only. No raw secret, model readiness, decryption or execution authority is established by parsing.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log('Eleven broker-internal structural credential schemas checked/generated.');
