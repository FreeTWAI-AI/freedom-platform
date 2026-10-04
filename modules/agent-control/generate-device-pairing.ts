import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { DevicePairingBeginClaimsSchema, DevicePairingPollClaimsSchema, DevicePairingProofResultSchema,
  DeviceAuthorizationBeginResultSchema, DeviceAuthorizationReviewSchema, DeviceAuthorizationDecisionResultSchema,
  DeviceAuthorizationPollResultSchema } from '../../contracts/execution/v1/device-pairing.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
const profiles = [
  ['device-pairing-begin-claims', DevicePairingBeginClaimsSchema],
  ['device-pairing-poll-claims', DevicePairingPollClaimsSchema],
  ['device-pairing-proof-result', DevicePairingProofResultSchema],
  ['device-authorization-begin', DeviceAuthorizationBeginResultSchema],
  ['device-authorization-review', DeviceAuthorizationReviewSchema],
  ['device-authorization-decision', DeviceAuthorizationDecisionResultSchema],
  ['device-authorization-poll', DeviceAuthorizationPollResultSchema],
] as const;
for (const [name, schema] of profiles) {
  const path = new URL(`../../contracts/execution/v1/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v1/${name}`,
    description: schema.description ?? 'Closed pairing claim shape only. Real signatures, exact host and DB binding, current time, approval, replay and single consumption must be verified by the trusted service. Not OAuth transport compatibility or execution authority.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log('Seven structural device-pairing schemas checked/generated; no execution authority or production issuer approval.');
