import type { Hono } from 'hono';
import { GUIDE_PREFIX, unavailableGuideResponse, type PublicGuideAssets } from '../../../../packages/public-guide-assets/index.js';
export function isGuideAssetPath(path: string): boolean {
  // Reject encoded separator aliases as this namespace, never as SPA navigation.
  // The asset service still accepts only the original exact, digest-addressed URL.
  let decoded=path;
  try { decoded=decodeURIComponent(path).replaceAll('\\','/'); } catch { /* Raw namespace failures remain terminal below. */ }
  return path===GUIDE_PREFIX || path.startsWith(GUIDE_PREFIX+'/') || decoded===GUIDE_PREFIX || decoded.startsWith(GUIDE_PREFIX+'/')
    || path.startsWith(GUIDE_PREFIX+'%');
}
/** Terminal before generic mutation/body readers and SPA fallbacks. */
export function guideAssetResponse(request: Request, assets?: PublicGuideAssets): Promise<Response> | Response {
  return assets ? assets.fetch(request) : unavailableGuideResponse();
}
export function registerGuideReleaseRoute(app: Hono<any>, assets?: PublicGuideAssets): void {
  app.get('/api/v1/guide-packs/release', c => {
    c.header('Cache-Control', 'no-store');
    return c.json(assets?.release ?? { enabled: false });
  });
  app.get('/api/v1/guide-packs/release/:pack',c=>{
    c.header('Cache-Control','no-store');
    const pack=c.req.param('pack');
    if(pack!=='dragon' && pack!=='ai-sister')return c.json({enabled:false});
    return c.json(assets?.releases?.[pack] ?? (assets?.release?.pack===pack?assets.release:{enabled:false}));
  });
}
