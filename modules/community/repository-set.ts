import repositorySet from '../../repositories.lock.json' with {type: 'json'};

// The reviewed lock records published provenance and exact commits. Only its
// static architecture entries need current coordinates for display and sync;
// this is not an alias rule for member input or provider-returned identities.
export const currentArchitectureRepositories = repositorySet.repositories.map(entry => ({
  ...entry,
  repository: entry.repository
    .replace(/^FreeTWAI-AI\//, 'FreeTWAI/')
    .replace(/^FreeTWAI\/FreeTWAI-AI\.github\.io$/, 'FreeTWAI/FreeTWAI.github.io'),
}));
