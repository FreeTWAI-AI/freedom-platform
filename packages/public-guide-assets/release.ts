/** Reviewed code pin, independent of the manifest (the manifest has no self-hash).
 * Actual publisher/provider receipts are absent: production release stays OFF.
 * An environment variable alone cannot turn this release on. */
export const DRAGON_GUIDE_RELEASE = Object.freeze({
  enabled: false as boolean,
  pack: 'dragon' as const,
  version: 'dragon-v1-20261004',
  manifestSha256: '506d5fe7eb653874286baeb58b3bc47f44e243279104fae2d9a8ada2a65723ee',
  publisherReceipt: null,
});
