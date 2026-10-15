export type ShortVideo = { title: string; url: string; platform: string; description?: string };

/** Curated short videos shown on the community page. Empty until the maintainers add real, public links. */
export const shortVideos: readonly ShortVideo[] = [];

/** Only https links with a title are shown; anything else is dropped rather than rendered as a broken or unsafe link. */
export function visibleShortVideos(items: readonly ShortVideo[]) {
  return items.filter(item => {
    if (!item.title.trim() || !item.platform.trim()) return false;
    try { return new URL(item.url).protocol === 'https:'; } catch { return false; }
  });
}
