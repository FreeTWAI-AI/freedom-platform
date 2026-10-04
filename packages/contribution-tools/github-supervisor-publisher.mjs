// Operator-installed composition only; never load this module from candidate bytes.
import { createGithubAppPublisher } from './github-app-publisher.mjs';
import { runHostVerification } from './github-trusted-adapter.mjs';

function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function requireThat(value) { if (!value) throw new Error('publisher_supervisor_configuration_invalid'); }
function envelope(value) {
  requireThat(typeof value === 'string' || Buffer.isBuffer(value));
  requireThat(Buffer.byteLength(value) <= 2_000_000);
  return Buffer.from(value);
}

/** Supervisor supplies purpose-signed bytes, never a verdict/report or credentials. */
export function createSignedSupervisorPublisher(config, ports) {
  requireThat(exact(config, ['adapterConfig', 'publisherConfig']) &&
    exact(ports, ['appRequest', 'installationRequest', 'supervisor']) &&
    Object.values(ports).every(value => typeof value === 'function'));
  // The adapter configuration contains public trust keys, source pins and host
  // paths only. Capture it before any asynchronous supervisor or API call.
  const adapter = structuredClone(config.adapterConfig);
  const publisher = structuredClone(config.publisherConfig);
  requireThat(adapter.repository === publisher.repository && adapter.app_id === publisher.app_id &&
    adapter.check_name === publisher.check_name);
  const { appRequest, installationRequest, supervisor } = ports;
  return createGithubAppPublisher(publisher, {
    appRequest, installationRequest,
    async verify(binding) {
      const signed = await supervisor(binding);
      requireThat(exact(signed, ['jobEnvelope', 'observationsEnvelope']));
      const job = envelope(signed.jobEnvelope), observations = envelope(signed.observationsEnvelope);
      // This invokes the real signature checks, externally pinned installation,
      // bare Git graph, approved-policy pins and closed suite-evidence validator.
      // Missing evidence stays unavailable; no synthesized pass callback exists.
      const result = await runHostVerification(adapter, job, observations);
      return result.report;
    }
  });
}
