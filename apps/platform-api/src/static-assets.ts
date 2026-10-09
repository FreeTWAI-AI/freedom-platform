export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const FAST_PATH_ASSET_EXTENSIONS = new Set(['js', 'css', 'woff', 'woff2', 'png', 'jpg', 'jpeg', 'webp', 'svg', 'ico']);

export function isFastPathBuildAsset(pathname: string) {
  if (!pathname.startsWith('/assets/')) return false;
  const extensionAt = pathname.lastIndexOf('.');
  if (!FAST_PATH_ASSET_EXTENSIONS.has(pathname.slice(extensionAt + 1))) return false;
  const stem = pathname.slice('/assets/'.length, extensionAt);
  if (/[^A-Za-z0-9_-]/.test(stem)) return false;
  // Filename and hash share an alphabet, including '-'. The first separator
  // after a nonempty filename gives the longest possible hash. Scan once rather
  // than backtracking through overlapping filename/hash regex quantifiers.
  const separatorAt = stem.indexOf('-', 1);
  return separatorAt >= 1 && stem.length - separatorAt - 1 >= 8;
}

// Vite/Rolldown's default hash is eight base64url characters (including - and _).
// Only built asset types qualify; HTML and fixed public filenames remain no-store.
export function isHashedBuildAsset(pathname: string) {
  return /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|wasm|mp4|webm|mp3|ogg|wav)$/.test(pathname);
}
