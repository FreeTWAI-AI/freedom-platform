/** Closed existing-domain media identities. Server-selected; never caller SQL. */
export const DOMAIN_MEDIA = Object.freeze({
  'skill.submission-image': Object.freeze({variants:Object.freeze(['image'] as const)}),
  'community.event-banner': Object.freeze({scopeKind:'community' as const,variants:Object.freeze(['banner'] as const)}),
  'community.event-video': Object.freeze({scopeKind:'community' as const,variants:Object.freeze(['video'] as const)}),
  'community.event-highlight': Object.freeze({variants:Object.freeze(['image','thumb'] as const),atomicVariants:true}),
  'community.social-thumbnail': Object.freeze({variants:Object.freeze(['thumbnail'] as const)}),
  'member.service-cover': Object.freeze({variants:Object.freeze(['cover'] as const)}),
});
export type DomainMediaPurpose = keyof typeof DOMAIN_MEDIA;
export type DomainMediaVariant = typeof DOMAIN_MEDIA[DomainMediaPurpose]['variants'][number];
export interface MediaSourceIdentity {
  readonly purpose: DomainMediaPurpose; readonly targetId: string; readonly variant: DomainMediaVariant;
  readonly expectedDomainVersion: string; readonly sourceSha256: string;
}
export function validDomainVariant(purpose:DomainMediaPurpose,variant:string):boolean {
  return Object.hasOwn(DOMAIN_MEDIA,purpose)&&(DOMAIN_MEDIA[purpose].variants as readonly string[]).includes(variant);
}
