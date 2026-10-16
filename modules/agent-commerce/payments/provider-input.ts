import type { Pool } from 'pg';
import { isolatedTransaction, clearTenantContext } from '../../../packages/resource-scopes/tenant-transaction.js';
import { bindStore } from '../checkout/authority.js';
import { parseForm } from '../providers/ecpay/index.js';
import { resolveProviderAccountRoute } from './entry-routes.js';
import { listUsableCredentialVersions, loadServiceCredentials } from './accounts.js';
import type { CommerceCredentialKeyring } from './credentials.js';
export interface PaymentAccount {
  account_id: string;
  tenant_id: string;
  instance_id: string;
  merchant_id: string;
  environment: 'sandbox' | 'live';
}
export async function readProviderForm(request: Request): Promise<Uint8Array | null> {
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*(?:"[A-Za-z0-9_-]+"|[A-Za-z0-9_-]+))?\s*$/i.test(request.headers.get('Content-Type') ?? ''))
    return null;
  const reader = request.body?.getReader();
  if (!reader)
    return null;
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      length += value.byteLength;
      if (length > 16384) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    parseForm(body);
    return body;
  }
  catch {
    return null;
  }
  finally {
    reader.releaseLock();
  }
}
export function resolvePaymentAccount(pool: Pool, ref: string): Promise<PaymentAccount | null> {
  return isolatedTransaction(pool, async (q) => {
    const route = await resolveProviderAccountRoute(q, ref);
    if (!route)
      return null;
    await clearTenantContext(q);
    await bindStore(q, route.tenant_id);
    return (await q.query<PaymentAccount>('SELECT account_id,tenant_id,instance_id,merchant_id,environment FROM commerce_provider_accounts WHERE account_id=$1 AND tenant_id=$2 AND instance_id=$3', [route.account_id, route.tenant_id, route.instance_id])).rows[0] ?? null;
  });
}
export async function paymentVerificationKeys(pool: Pool, account: PaymentAccount, ring: CommerceCredentialKeyring | null) {
  if (!ring)
    throw Error('payment_credentials_unavailable');
  return isolatedTransaction(pool, async (q) => {
    await clearTenantContext(q);
    await bindStore(q, account.tenant_id);
    const versions = await listUsableCredentialVersions(q, { accountId: account.account_id, purpose: 'payment' });
    if (!versions.length)
      throw Error('payment_credentials_unavailable');
    const credentials = [];
    for (const version of versions)
      credentials.push(await loadServiceCredentials(q, ring, { accountId: account.account_id, purpose: 'payment', credentialVersion: version }));
    return credentials;
  });
}
