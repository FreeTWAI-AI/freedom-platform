import { readFile,writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as c from '../../contracts/execution/v2/model-credential-ingest.js';
if(process.argv.slice(2).some(v=>v!=='--check'))throw new Error('Only --check is supported.');
for(const [name,schema] of [
  ['credential-ingest-command',c.CredentialIngestCommandSchema],
  ['credential-ingest-issue-input',c.CredentialIngestIssueInputSchema],
  ['credential-ingest-bootstrap-protected-header',c.CredentialIngestBootstrapProtectedHeaderSchema],
  ['credential-ingest-response-protected-header',c.CredentialIngestResponseProtectedHeaderSchema],
  ['credential-ingest-bootstrap-claims',c.CredentialIngestBootstrapClaimsSchema],
  ['credential-ingest-bootstrap-request',c.CredentialIngestBootstrapRequestSchema],
  ['credential-ingest-setup-metadata',c.CredentialIngestSetupMetadataSchema],
  ['credential-ingest-owner-outcome',c.CredentialIngestOwnerOutcomeSchema],
  ['credential-ingest-response-claims',c.CredentialIngestResponseClaimsSchema],
  ['credential-ingest-response-envelope',c.CredentialIngestResponseEnvelopeSchema],
] as const){
  const path=new URL(`../../contracts/execution/v2/${name}.schema.json`,import.meta.url);
  const bytes=JSON.stringify({...z.toJSONSchema(schema),$id:`https://freetwai.com/contracts/execution/v2/${name}`,
    description:'Closed metadata/reference-only credential ingestion shape. No secret, capture readiness, private intent or operational authority.'},null,2)+'\n';
  if(process.argv.includes('--check')){if(await readFile(path,'utf8')!==bytes)throw new Error(`Generated ${name} schema is stale.`);}
  else await writeFile(path,bytes);
}
console.log('Ten credential ingestion schemas checked/generated.');
