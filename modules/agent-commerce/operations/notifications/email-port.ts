import type {PoolClient} from 'pg';
export type CommerceOutboundEmailTemplate = 'order_confirmed' | 'paid_unallocatable' | 'order_access';
export interface QueueCommerceEmailInput {
  template: CommerceOutboundEmailTemplate;
  tenantId: string;
  instanceId: string;
  orderId: string;
  applicationId?: string | null;
  accessRequestId?: string | null;
}
export interface CommerceEmailOutbox {
  queue(q: PoolClient, input: QueueCommerceEmailInput): Promise<{emailId: string} | null>;
}
export type CommerceEmailErrorCode =
  | 'invalid_message'
  | 'recipient_not_allowed'
  | 'sender_not_verified'
  | 'rate_limited'
  | 'send_failed';
export type CloudflareEmailErrorCode =
  | 'E_VALIDATION_ERROR'
  | 'E_RECIPIENT_NOT_ALLOWED'
  | 'E_SENDER_NOT_VERIFIED'
  | 'E_TOO_MANY_RECIPIENTS'
  | 'E_RATE_LIMIT_EXCEEDED';
export interface CommerceEmailMessage {
  to: string;
  subject: string;
  text: string;
  replyTo: string | null;
}
export interface CommerceEmailSender {
  send(message: CommerceEmailMessage): Promise<void>;
}
export class CommerceEmailSendError extends Error {
  readonly code: CommerceEmailErrorCode;
  constructor(code: CommerceEmailErrorCode | CloudflareEmailErrorCode = 'send_failed') {
    const mapped = mapCommerceEmailErrorCode({code});
    super(mapped);
    this.name = 'CommerceEmailSendError';
    this.code = mapped;
  }
}
export function mapCommerceEmailErrorCode(error: unknown): CommerceEmailErrorCode {
  const raw =
    error instanceof CommerceEmailSendError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error && typeof (error as {code: unknown}).code === 'string'
        ? (error as {code: string}).code
        : '';
  switch (raw) {
    case 'E_VALIDATION_ERROR':
    case 'E_TOO_MANY_RECIPIENTS':
    case 'invalid_message':
      return 'invalid_message';
    case 'E_RECIPIENT_NOT_ALLOWED':
    case 'recipient_not_allowed':
      return 'recipient_not_allowed';
    case 'E_SENDER_NOT_VERIFIED':
    case 'sender_not_verified':
      return 'sender_not_verified';
    case 'E_RATE_LIMIT_EXCEEDED':
    case 'rate_limited':
      return 'rate_limited';
    default:
      return 'send_failed';
  }
}
export function isPermanentCommerceEmailError(code: CommerceEmailErrorCode): boolean {
  return (
    code === 'invalid_message' ||
    code === 'recipient_not_allowed' ||
    code === 'sender_not_verified'
  );
}
/** The M1 runtime installs no email adapter. Never send inside a SQL transaction. */
export interface CommerceAccessEmail {to:string;accessUrl:string;displayNumber:string}
export interface CommerceEmailPort {sendOrderAccess(message:CommerceAccessEmail):Promise<void>}
export class FixtureEmailSender implements CommerceEmailPort {
  readonly messages:CommerceAccessEmail[]=[];
  async sendOrderAccess(message:CommerceAccessEmail) {this.messages.push({...message});}
}
