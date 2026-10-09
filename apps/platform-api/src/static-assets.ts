export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// Vite/Rolldown's default hash is eight base64url characters (including - and _).
// Only built asset types qualify; HTML and fixed public filenames remain no-store.
export function isHashedBuildAsset(pathname: string) {
  return /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|wasm|mp4|webm|mp3|ogg|wav)$/.test(pathname);
}
