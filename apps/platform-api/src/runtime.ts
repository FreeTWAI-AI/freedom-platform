import type { PublicGuideAssets } from '../../../packages/public-guide-assets/index.js';
import type {EventHighlightAssetService} from '../../../modules/assets/event-highlight.js';
import type {SkillImageAssetService} from '../../../modules/assets/skill-image.js';
import type {SocialThumbnailAssetService} from '../../../modules/assets/social-thumbnail.js';
import type {EventVideoAssetService} from '../../../modules/assets/event-video.js';
import type {EventBannerAssetService} from '../../../modules/assets/event-banner.js';
import type { Context } from 'hono';
import type { AdminAccessVerifier } from '../../../modules/platform-admin/access.js';
import type { PasswordEmailSender } from '../../../modules/identity-membership/password-recovery.js';
import type { EventEmailSender } from '../../../modules/community/events.js';
import type {GuildReviewer} from '../../../modules/community/guild-discovery.js';
import type { ServiceCoverAssetService } from '../../../modules/assets/media-domain.js';
import type { ObjectStore } from '../../../packages/asset-storage/index.js';
import type { ModuleProviderMap } from '../../../modules/module-registry/providers.js';

/** Stable rate-limit key used whenever no trusted network address is available. */
export const SHARED_NETWORK_KEY = 'shared-server';

/**
 * Everything the platform app reads from its host. The Node adapter derives this
 * from process configuration; the Worker adapter builds one per request from its
 * bindings, so no configuration is shared through process-wide state.
 */
export type PlatformRuntime = {
  /** Explicit upgrade policy. Absence closes shop-key operations; never allows legacy. */
  shopKeyPolicy?: 'legacy-compatible'|'purpose-bound-only';
  /** Independently installed read-only platform-public guide release. Never MEDIA. */
  publicGuideAssets?: PublicGuideAssets;
  /** Community new registrations join; read per request. */
  registrationCommunityId: () => string | undefined;
  /** Base64 AES key protecting stored GitHub credentials; never logged or returned. */
  githubTokenKey: () => string | undefined;
  /** Read-only GitHub token for public repository counts; never logged or returned. */
  githubMetricsToken: () => string | undefined;
  /** GitHub App webhook secret. Undefined leaves only that route answering 503. */
  maintainerWebhookSecret: () => string | undefined;
  adminVerifier: AdminAccessVerifier;
  /** Trusted client address or SHARED_NETWORK_KEY; preserves promotion visitor identity. */
  sourceNetwork: (c: Context) => string;
  /** Optional grouped budget key; adapters without it retain sourceNetwork limits. */
  rateLimitNetwork?: (c: Context) => string;
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
  /** Explicit installed cover lifecycle/read store; no ambient activation. */
  serviceCoverAssets?: ServiceCoverAssetService;
  serviceCoverAssetStore?: ObjectStore;
  eventBannerAssets?:EventBannerAssetService;
  eventBannerAssetStore?:ObjectStore;
  eventVideoAssets?:EventVideoAssetService;
  eventVideoAssetStore?:ObjectStore;
  skillImageAssets?:SkillImageAssetService;
  skillImageAssetStore?:ObjectStore;
  socialThumbnailAssets?:SocialThumbnailAssetService;
  socialThumbnailAssetStore?:ObjectStore;
  eventHighlightAssets?:EventHighlightAssetService;
  eventHighlightAssetStore?:ObjectStore;
  /** Explicit host-installed private Work/model product transport. No ambient
   * credentials or default Worker activation; it owns its bounded HTTP body. */
  privateAiProduct?: (request: Request) => Promise<Response>;
  /** Same installed opaque product-derived browser policy. No wire/config DTO. */
  privateAiSetupOrigin?: () => string | undefined;
  /** Extra non-secret fields merged into /api/v1/health. */
  health?: Readonly<Record<string, string | null>>;
  /** Clock for promotion days. Tests inject a fixed instant. */
  now?: () => Date;
  /** Host-enforced preview egress. Node pins a public IP; Workers trusts fixed DNS owners. Absent fails closed. */
  linkPreviewFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Explicit store for tenant Result bytes. Absent refuses upload and content reads. */
  tenantWorkAssetStore?: ObjectStore;
  /** Injected module providers. Hosted work is always registered; tests add synthetic modules. */
  moduleProviders?: ModuleProviderMap;
  /** Release setting for guild launchpad and tenant workspaces. Absent or false leaves those routes unregistered. */
  guildLaunchpadEnabled?: boolean;
  communityDiscoveryEnabled?: boolean;
  /** Explicit release setting for community content search. Absent or false leaves routes unregistered. */
  communitySearchEnabled?: boolean;
  /** Private bookmarks and follows require both this setting and community search. */
  communityRelationsEnabled?: boolean;
};
