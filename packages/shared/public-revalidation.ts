/** HTTP no-store does not stop bfcache from restoring an already rendered public page. */
export const PUBLIC_REVALIDATION_SCRIPT = `(() => {
  let reloading = false;
  const clear = () => {
    document.body.replaceChildren();
    document.title = '自由工坊';
    for (const meta of document.querySelectorAll('meta[property^="og:"],meta[name^="twitter:"],meta[name="description"]')) meta.remove();
  };
  const refresh = () => {
    if (reloading) return;
    reloading = true;
    clear();
    location.reload();
  };
  window.addEventListener('pagehide', clear);
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
})();`;
export const PUBLIC_REVALIDATION_MARKUP = '<script src="/public-revalidation.js" defer></script>';
