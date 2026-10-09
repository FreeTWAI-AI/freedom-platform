import type { MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { IMMUTABLE_ASSET_CACHE_CONTROL, isHashedBuildAsset } from './static-assets.js';

/** Decide after the static adapter returns: onFound runs before c.res is finalized. */
export function serveBuildAssets(root: string): MiddlewareHandler {
  return async (c, next) => {
    let found = false;
    const response = await serveStatic({ root, onFound: () => { found = true; } })(c, next);
    if (found && response instanceof Response && ['GET', 'HEAD'].includes(c.req.method)
      && [200, 206, 304].includes(response.status) && isHashedBuildAsset(c.req.path)
      && !/text\/html/i.test(response.headers.get('content-type') ?? '')) {
      response.headers.set('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL);
    }
    return response;
  };
}
