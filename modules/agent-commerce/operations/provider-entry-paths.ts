const accountRef = '[0-9a-hjkmnp-tv-z]{26}';
const entry = new RegExp(`^(?:/api/v1/provider-callbacks/ecpay/${accountRef}/payment|/pay/ecpay/return/${accountRef})$`);
/** Only these signed POST transports bypass browser Origin/JSON/session gates. */
export function isCommerceProviderEntry(method: string, path: string): boolean { return method === 'POST' && entry.test(path); }
export function isCommerceProviderEntryPath(path: string): boolean {
  return path === '/api/v1/provider-callbacks/ecpay' || path.startsWith('/api/v1/provider-callbacks/ecpay/') || path === '/pay/ecpay/return' || path.startsWith('/pay/ecpay/return/');
}
