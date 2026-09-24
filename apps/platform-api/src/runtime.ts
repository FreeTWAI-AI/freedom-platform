import type { Context } from 'hono';
import type { AdminAccessVerifier } from '../../../modules/platform-admin/access.js';

/** Stable rate-limit key used whenever no trusted network address is available. */
export const SHARED_NETWORK_KEY = 'shared-server';

/**
 * Everything the platform app reads from its host. The Node adapter derives this
 * from process configuration; the Worker adapter builds one per request from its
 * bindings, so no configuration is shared through process-wide state.
 */
export type PlatformRuntime = {
  /** Community new registrations join; read per request. */
  registrationCommunityId: () => string | undefined;
  /** Base64 AES key protecting stored GitHub credentials; never logged or returned. */
  githubTokenKey: () => string | undefined;
  adminVerifier: AdminAccessVerifier;
  /** Deterministic auth rate-limit key: a trusted client IP or SHARED_NETWORK_KEY. */
  sourceNetwork: (c: Context) => string;
  /** Hostnames accepted on inbound requests. */
  allowedHosts: ReadonlySet<string>;
  /** Origin for canonical/share URLs, development guidance, published-skill links and upload examples. */
  publicOrigin: string;
  /** Extra non-secret fields merged into /api/v1/health. */
  health?: Readonly<Record<string, string | null>>;
};
