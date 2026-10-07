import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import type { ClientRequest } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { PreviewFetch } from '../../../modules/community/link-preview.js';
import { normalizeShareUrl } from '../../../packages/shared/share-url.js';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(address, prefix, 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

/** No mapped IPv4, NAT64, transition, documentation or other non-global IPv6. */
export function isPublicPreviewAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

type PreviewLookup = (hostname: string) => Promise<readonly LookupAddress[]>;

/** A fresh socket uses exactly one checked address; TLS and Host retain the URL hostname. */
export function createNodePreviewFetch(resolveHost: PreviewLookup = hostname => lookup(hostname, { all: true, verbatim: true })): PreviewFetch {
  return async (input, init) => {
    const guard = normalizeShareUrl(input);
    if (!guard.ok) throw new Error('preview_destination_rejected');
    const signal = init?.signal;
    signal?.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      let outgoing: ClientRequest | undefined;
      const abort = () => {
        const error = new Error('preview_aborted');
        outgoing?.destroy(error);
        reject(error);
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      void resolveHost(guard.host).then(addresses => {
        if (signal?.aborted) { abort(); cleanup(); return; }
        if (!addresses.length || addresses.some(row => !isPublicPreviewAddress(row.address) || isIP(row.address) !== row.family)) {
          throw new Error('preview_destination_rejected');
        }
        const address = addresses[0];
        outgoing = request(guard.url, {
          agent: false, family: address.family, servername: guard.host,
          headers: { ...Object.fromEntries(new Headers(init?.headers)), 'Accept-Encoding': 'identity' },
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        }, incoming => {
          try {
            const headers = new Headers();
            for (const name of ['content-type', 'content-length', 'content-encoding', 'location']) {
              const value = incoming.headers[name];
              if (typeof value === 'string') headers.set(name, value);
            }
            const status = incoming.statusCode ?? 502;
            const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
            if (!body) incoming.destroy();
            resolve(new Response(body, { status, headers }));
          } catch (error) { incoming.destroy(); outgoing?.destroy(); reject(error); }
        });
        outgoing.once('error', reject);
        outgoing.once('close', cleanup);
        outgoing.end();
      }).catch(error => { cleanup(); reject(error); });
      if (signal?.aborted) { abort(); cleanup(); }
    });
  };
}
