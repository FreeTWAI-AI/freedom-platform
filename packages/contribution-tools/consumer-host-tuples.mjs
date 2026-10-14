import {matchesRecordedRepository,isPlatformSourceRepository} from './repository-identity.mjs';
// The installed workflow owns the finite supported set. Lock metadata can only
// match one approved tuple; it cannot add a source, profile or runtime policy.
import { requireCondition as check } from './errors.mjs';
const legacy = '91b943ac61e132fbbce72ea066cb2301aa065600';
const repositories = ['.github', 'FreeTWAI.github.io', 'freedom-growth-automation', 'freedom-project-page',
  'freedom-project-template', 'freedom-skill-registry', 'freedom-storefront', 'freedom-supplier-client'];
export const CONSUMER_HOST_TUPLES = Object.freeze({
  ...Object.fromEntries(repositories.map(name => ['FreeTWAI/' + name,
    Object.freeze({ source: legacy, library_profile: 'legacy-v1', runtime_profile: 'legacy-v1' })])),
  'FreeTWAI/freedom-agent-kit': Object.freeze({ source: '057201218b6d4ae3e96b4ab838677f2b484b55fa',
    library_profile: 'agent-kit-device-cli-v1', runtime_profile: 'agent-kit-device-cli-v1' }),
});
export function consumerHostTuple(repository) {
  check(Object.hasOwn(CONSUMER_HOST_TUPLES, repository), 'unsupported_library_consumer');
  return CONSUMER_HOST_TUPLES[repository];
}
export function supportedConsumerHostTuples(repository) {
  const current = consumerHostTuple(repository);
  return repository === 'FreeTWAI/freedom-agent-kit'
    ? Object.freeze([current, Object.freeze({ source: legacy, library_profile: 'legacy-v1', runtime_profile: 'legacy-v1' })])
    : Object.freeze([current]);
}
export function matchSupportedConsumerHostTuple(repository, lock) {
  const matches = supportedConsumerHostTuples(repository).filter(tuple =>
    isPlatformSourceRepository(lock?.source_repository) && matchesRecordedRepository(lock.repository, repository)
    && lock.source_commit === tuple.source && (tuple.library_profile === 'legacy-v1'
      ? lock.format === 'freedom.consumer-libraries/v1' && !Object.hasOwn(lock, 'profile')
      : lock.format === 'freedom.consumer-libraries/v2' && lock.profile === tuple.library_profile));
  check(matches.length === 1, 'consumer_supported_tuple_required');
  return matches[0];
}
