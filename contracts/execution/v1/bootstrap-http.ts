import { z } from 'zod';
import { DeviceAuthorizationBeginInputSchema, DeviceAuthorizationPollInputSchema, DeviceAuthorizationDecisionInputSchema } from './device-pairing.js';
import { BootstrapRefreshInputSchema, BootstrapSessionNonceInputSchema } from './bootstrap-session.js';

// Closed JSON transport profile, not generic OAuth or execution authority.
export const BootstrapHttpBeginSchema = DeviceAuthorizationBeginInputSchema.omit({ proof: true });
export const BootstrapHttpTokenSchema = z.discriminatedUnion('grantType', [
  DeviceAuthorizationPollInputSchema.omit({ proof: true }).extend({ grantType: z.literal('device_code') }).strict(),
  BootstrapRefreshInputSchema.omit({ proof: true }).extend({ grantType: z.literal('refresh_token') }).strict(),
]);
export const BootstrapHttpNonceSchema = BootstrapSessionNonceInputSchema.omit({ accessToken: true, proof: true });
export const BootstrapHttpDecisionSchema = DeviceAuthorizationDecisionInputSchema.omit({ key: true });
