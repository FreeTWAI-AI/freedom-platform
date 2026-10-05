/** Activation pin binds both full publisher receipts.
 * Deployment still requires review/CI/merge, the host flag and separate native binding. */
export const AI_SISTER_GUIDE_RELEASE = Object.freeze({
  enabled: true as boolean,
  pack: 'ai-sister' as const,
  version: 'ai-sister-v1-20261005',
  manifestSha256: 'b2fbf0d348ac72729c2170a0f95a6c407907fefb1f7bdfaeb7733b0c5a2795c2',
  publisherReceipt: 'sha256:8e7a32f489be6a53f696af7fd2238b1a2340206f4c73385648fac64adfad338e',
});
