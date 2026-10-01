// Link-preview and automation clients. Matching is a case-insensitive substring.
// A bare "line" is intentionally absent: LINE's in-app browser ("Line/14.x") must still count.
// "java/" must not be "java" so "javascript" stays a real browser.
export const PREVIEW_BOT_MARKERS = [
  'bot', 'crawl', 'spider', 'slurp',
  'facebookexternalhit', 'facebot', 'meta-externalagent', 'meta-externalfetcher',
  'twitterbot', 'slackbot', 'discordbot', 'telegrambot', 'whatsapp', 'linkedinbot',
  'line-poker', 'skypeuripreview', 'embedly', 'pinterest', 'vkshare', 'redditbot',
  'google-inspectiontool', 'googleother', 'applebot', 'bingpreview',
  'headless', 'phantomjs', 'python', 'curl', 'wget', 'go-http-client', 'okhttp',
  'java/', 'libwww', 'httpclient', 'axios', 'node-fetch', 'undici',
] as const;

/** Empty or preview-like user agents are not credited. Real in-app browsers are. */
export function isPreviewBot(userAgent: string): boolean {
  const value = userAgent.trim().toLowerCase();
  if (!value) return true;
  return PREVIEW_BOT_MARKERS.some(marker => value.includes(marker));
}
