import type { Context } from 'hono';
import type { AdminAccessVerifier } from '../../../modules/platform-admin/access.js';
import type { PasswordEmailSender } from '../../../modules/identity-membership/password-recovery.js';
import type { EventEmailSender } from '../../../modules/community/events.js';
import type {GuildReviewer} from '../../../modules/community/guild-discovery.js';
import type { ObjectStore } from '../../../packages/asset-storage/index.js';

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
  /** Read-only GitHub token for public repository counts; never logged or returned. */
  githubMetricsToken: () => string | undefined;
  /** GitHub App webhook secret. Undefined leaves only that route answering 503. */
  maintainerWebhookSecret: () => string | undefined;
  adminVerifier: AdminAccessVerifier;
  /** Deterministic auth rate-limit key: a trusted client IP or SHARED_NETWORK_KEY. */
  sourceNetwork: (c: Context) => string;
  /** Hostnames accepted on inbound requests. */
  allowedHosts: ReadonlySet<string>;
  /** Origin for canonical/share URLs, development guidance, published-skill links and upload examples. */
  publicOrigin: string;
  /** Configured transactional email sender. Undefined keeps password recovery closed. */
  passwordEmailSender?: PasswordEmailSender;
  /** Public event participation details are sent only when a mail adapter exists. */
  eventEmailSender?: EventEmailSender;
  guildReviewer?: GuildReviewer;
  /** Explicit server port; absent keeps asset-backed reads unavailable. No mode activation. */
  avatarAssetStore?: ObjectStore;
  /** Explicit host-installed private Work/model product transport. No ambient
   * credentials or default Worker activation; it owns its bounded HTTP body. */
  privateAiProduct?: (request: Request) => Promise<Response>;
  /** Extra non-secret fields merged into /api/v1/health. */
  health?: Readonly<Record<string, string | null>>;
  /** Clock for promotion days. Tests inject a fixed instant. */
  now?: () => Date;
  /** Link-preview fetch. Production calls global fetch unbound; tests pass a fixture. */
  linkPreviewFetch?: (input: string, init?: RequestInit) => Promise<Response>;
};
