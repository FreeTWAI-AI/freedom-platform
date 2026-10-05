/** Reviewed code pin, independent of the manifest (the manifest has no self-hash).
 * Both environment publisher receipts are pinned below; deployment still requires the host flag.
 * The explicit host flag and separate native binding are still required. */
export const DRAGON_GUIDE_RELEASE = Object.freeze({
  enabled: true as boolean,
  pack: 'dragon' as const,
  version: 'dragon-v1-20261004',
  manifestSha256: '506d5fe7eb653874286baeb58b3bc47f44e243279104fae2d9a8ada2a65723ee',
  publisherReceipt: 'sha256:b6ee9aa8039e0f98594b94bcd4f24421b7580da2556178de3ab89d6662458005',
});
