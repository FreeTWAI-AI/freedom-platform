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
export interface WorkerEmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text: string;
    replyTo?: string;
  }): Promise<unknown>;
}
export function createWorkerEmailSender(binding: WorkerEmailBinding): CommerceEmailSender {
  return {
    async send({to, subject, text, replyTo}) {
      try {
        await binding.send({
          to,
          from: 'no-reply@mail.freetwai.com',
          subject,
          text,
          ...(replyTo ? {replyTo} : {}),
        });
      } catch (error) {
        throw new CommerceEmailSendError(mapCommerceEmailErrorCode(error));
      }
    },
  };
}
/** Never touches the network. Can be configured to fail the next N sends with a given code. */
export class FixtureEmailSender implements CommerceEmailSender {
  readonly messages: CommerceEmailMessage[] = [];
  private remainingFailures = 0;
  private failureCode: CommerceEmailErrorCode = 'send_failed';

  failNext(
    countOrCode: number | CommerceEmailErrorCode | CloudflareEmailErrorCode = 1,
    codeOrCount: CommerceEmailErrorCode | CloudflareEmailErrorCode | number = 'send_failed',
  ): void {
    if (typeof countOrCode === 'string') {
      const count = typeof codeOrCount === 'number' ? codeOrCount : 1;
      this.remainingFailures = Math.max(0, Math.trunc(count));
      this.failureCode = mapCommerceEmailErrorCode({code: countOrCode});
      return;
    }
    this.remainingFailures = Math.max(0, Math.trunc(countOrCode));
    const code = typeof codeOrCount === 'string' ? codeOrCount : 'send_failed';
    this.failureCode = mapCommerceEmailErrorCode({code});
  }

  async send(message: CommerceEmailMessage): Promise<void> {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new CommerceEmailSendError(this.failureCode);
    }
    this.messages.push({...message});
  }
}
