import { ECPAY_ORIGINS, findCdnBlockedTerm, type EcpayEnvironment } from '../providers/ecpay/index.js';
import { providerEnvironment } from '../operations/admissions.js';
export interface EcpayPaymentGateway {
  readonly environment: EcpayEnvironment;
  readonly publicBaseUrl: string;
  readonly checkoutAction: string;
}
const fixtureGateways = new WeakSet<EcpayPaymentGateway>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Keep transport configuration independent of credentials and stored payment facts. */
function validPublicUrl(raw: string): URL {
  try {
    const url = new URL(raw), labels = url.hostname.split('.');
    if (raw.length > 200 || /[&<>"'\s]|%26|%3c/i.test(raw) || url.href !== raw || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
      || raw.includes('?') || raw.includes('#') || !/^\/[A-Za-z0-9._~/-]*$/.test(url.pathname) || labels.length < 2 || /^\d+$/.test(labels.at(-1)!)
      || labels.some(label => !(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) || findCdnBlockedTerm(raw) !== null)
      throw Error();
    return url;
  }
  catch {
    throw Error('payment_gateway_invalid');
  }
}
function publicOrigin(origin: string): string {
  const parsed = validPublicUrl(origin + '/');
  if (parsed.origin !== origin)
    throw Error('payment_gateway_invalid');
  return origin;
}
function validEnvironment(environment: EcpayEnvironment): void {
  if (!Object.hasOwn(ECPAY_ORIGINS.payment, environment))
    throw Error('payment_gateway_invalid');
}
export function createEcpayPaymentGateway(environment: EcpayEnvironment, origin: string): EcpayPaymentGateway {
  validEnvironment(environment);
  const gateway = Object.freeze({ environment, publicBaseUrl: publicOrigin(origin), checkoutAction: ECPAY_ORIGINS.payment[environment] + '/Cashier/AioCheckOut/V5' });
  paymentGatewayUrls(gateway, { accountRef: '0'.repeat(26), attemptId: '00000000-0000-0000-0000-000000000000' });
  return gateway;
}
export function createFixturePaymentGateway(input: {
  freedomEnv: 'local' | 'staging' | 'public';
  environment: EcpayEnvironment;
  publicBaseUrl: string;
  checkoutAction: string;
  localOrigin: string;
}): EcpayPaymentGateway {
  if (input.freedomEnv !== 'local')
    throw Error('payment_fixture_requires_local');
  validEnvironment(input.environment);
  try {
    const action = new URL(input.checkoutAction), local = new URL(input.localOrigin);
    if (local.origin !== input.localOrigin || !['http:', 'https:'].includes(local.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)
      || action.href !== input.checkoutAction || action.origin !== local.origin || action.username || action.password || action.search || action.hash)
      throw Error();
  }
  catch {
    throw Error('payment_gateway_invalid');
  }
  const gateway = Object.freeze({ environment: input.environment, publicBaseUrl: publicOrigin(input.publicBaseUrl), checkoutAction: input.checkoutAction });
  paymentGatewayUrls(gateway, { accountRef: '0'.repeat(26), attemptId: '00000000-0000-0000-0000-000000000000' });
  fixtureGateways.add(gateway);
  return gateway;
}
/** Recheck installation as well as construction, so a local fixture cannot be transplanted into another host. */
export function assertPaymentGatewayInstallation(gateway: EcpayPaymentGateway | undefined, freedomEnv: 'local' | 'staging' | 'public', origin: string): void {
  if (!gateway)
    return;
  if (fixtureGateways.has(gateway)) {
    if (freedomEnv !== 'local')
      throw Error('payment_fixture_requires_local');
    if (new URL(gateway.checkoutAction).origin !== origin)
      throw Error('payment_gateway_invalid');
  }
  else {
    const production = createEcpayPaymentGateway(gateway.environment, origin);
    if (gateway.publicBaseUrl !== production.publicBaseUrl || gateway.checkoutAction !== production.checkoutAction)
      throw Error('payment_gateway_invalid');
  }
  if (gateway.environment !== providerEnvironment(freedomEnv))
    throw Error('payment_gateway_invalid');
}
export function paymentGatewayUrls(gateway: EcpayPaymentGateway, input: {
  accountRef: string;
  attemptId: string;
}): {
  returnUrl: string;
  orderResultUrl: string;
  clientBackUrl: string;
} {
  if (!/^[0-9a-hjkmnp-tv-z]{26}$/.test(input.accountRef) || !uuid.test(input.attemptId))
    throw Error('payment_gateway_invalid');
  const urls = {
    returnUrl: `${gateway.publicBaseUrl}/api/v1/provider-callbacks/ecpay/${input.accountRef}/payment`,
    orderResultUrl: `${gateway.publicBaseUrl}/pay/ecpay/return/${input.accountRef}`, clientBackUrl: `${gateway.publicBaseUrl}/pay/ecpay/back/${input.attemptId}`
  };
  for (const url of Object.values(urls))
    validPublicUrl(url);
  return urls;
}
