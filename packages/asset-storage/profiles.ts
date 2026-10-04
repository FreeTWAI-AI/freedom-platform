/** Server-selected persistence profiles for existing representations. These are
 * storage compatibility limits, not permission to capture, publish or decode.
 * Backfill preserves original bytes; new uploads keep their domain normalizer. */
const raster = Object.freeze(['image/png','image/jpeg','image/webp'] as const);
export const OBJECT_IO_MAX_BYTES = 20 * 1024 * 1024;
export const MEDIA_OBJECT_PROFILES = Object.freeze({
  'member.avatar': Object.freeze({maxBytes:128*1024,contentTypes:raster,transformVersion:'member.avatar.legacy-bytes.v1',source:'modules/identity-membership/avatars.ts'}),
  'skill.submission-image': Object.freeze({maxBytes:512*1024,contentTypes:raster,transformVersion:'skill.submission-image.legacy-bytes.v1',source:'modules/skill-submissions/payload.ts'}),
  'community.event-banner': Object.freeze({maxBytes:512*1024,contentTypes:raster,transformVersion:'community.event-banner.legacy-bytes.v1',source:'modules/skill-submissions/payload.ts'}),
  'community.event-video': Object.freeze({maxBytes:OBJECT_IO_MAX_BYTES,contentTypes:Object.freeze(['video/mp4','video/webm'] as const),transformVersion:'community.event-video.legacy-bytes.v1',source:'modules/community/events.ts'}),
  'community.event-highlight': Object.freeze({maxBytes:1024*1024,contentTypes:raster,transformVersion:'community.event-highlight.legacy-bytes.v1',source:'modules/community/event-highlights.ts'}),
  'community.event-highlight.thumbnail': Object.freeze({maxBytes:200*1024,contentTypes:raster,transformVersion:'community.event-highlight.thumbnail.legacy-bytes.v1',source:'modules/community/event-highlights.ts'}),
  'community.social-thumbnail': Object.freeze({maxBytes:512*1024,contentTypes:raster,transformVersion:'community.social-thumbnail.legacy-bytes.v1',source:'modules/skill-submissions/payload.ts'}),
  'member.service-cover': Object.freeze({maxBytes:512*1024,contentTypes:raster,transformVersion:'member.service-cover.legacy-bytes.v1',source:'modules/skill-submissions/payload.ts'}),
} as const);
export type MediaObjectProfileId = keyof typeof MEDIA_OBJECT_PROFILES;
export type MediaObjectTransform = typeof MEDIA_OBJECT_PROFILES[MediaObjectProfileId]['transformVersion'];
