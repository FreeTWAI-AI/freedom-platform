// Workflow installation selects this table. Candidate locks/env never choose it.
import { requireCondition as check } from './errors.mjs';
const legacy = '91b943ac61e132fbbce72ea066cb2301aa065600';
const repositories = ['.github', 'FreeTWAI-AI.github.io', 'freedom-growth-automation', 'freedom-project-page',
  'freedom-project-template', 'freedom-skill-registry', 'freedom-storefront', 'freedom-supplier-client'];
export const CONSUMER_HOST_TUPLES = Object.freeze({
  ...Object.fromEntries(repositories.map(name => ['FreeTWAI-AI/' + name,
    Object.freeze({ source: legacy, library_profile: 'legacy-v1', runtime_profile: 'legacy-v1' })])),
  'FreeTWAI-AI/freedom-agent-kit': Object.freeze({ source: '057201218b6d4ae3e96b4ab838677f2b484b55fa',
    library_profile: 'agent-kit-device-cli-v1', runtime_profile: 'agent-kit-device-cli-v1' }),
});
export function consumerHostTuple(repository) {
  check(Object.hasOwn(CONSUMER_HOST_TUPLES, repository), 'unsupported_library_consumer');
  return CONSUMER_HOST_TUPLES[repository];
}
