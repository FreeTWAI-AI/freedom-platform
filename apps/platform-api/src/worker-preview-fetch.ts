import type { PreviewFetch } from '../../../modules/community/link-preview.js';
import { normalizeShareUrl } from '../../../packages/shared/share-url.js';

const trustedSites: Readonly<Record<string, true>> = {
  'youtube.com': true, 'youtu.be': true, 'instagram.com': true,
  'facebook.com': true, 'fb.watch': true, 'threads.net': true, 'threads.com': true,
  'tiktok.com': true, 'x.com': true, 'twitter.com': true,
};
// These asset namespaces have provider-controlled DNS, not user-selected origins.
const trustedAssets = ['ytimg.com', 'fbcdn.net', 'cdninstagram.com', 'tiktokcdn.com', 'twimg.com'];

/** Workers fetch cannot pin a checked DNS address: trust only these DNS owners, at every hop. */
export const workerPreviewFetch: PreviewFetch = async (input, init) => {
  const guard = normalizeShareUrl(input);
  if (!guard.ok) throw new Error('preview_destination_rejected');
  const site = guard.host.replace(/^www\./, '');
  if (!Object.hasOwn(trustedSites, site) && !trustedAssets.some(domain => guard.host === domain || guard.host.endsWith('.' + domain))) {
    throw new Error('preview_destination_rejected');
  }
  // A redirect never receives an implicit fetch outside the trusted namespace.
  return globalThis.fetch(guard.url, { ...init, redirect: 'manual' });
};
