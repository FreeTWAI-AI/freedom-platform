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
/** The M1 runtime installs no email adapter. Never send inside a SQL transaction. */
export interface CommerceAccessEmail {to:string;accessUrl:string;displayNumber:string}
export interface CommerceEmailPort {sendOrderAccess(message:CommerceAccessEmail):Promise<void>}
export class FixtureEmailSender implements CommerceEmailPort {
  readonly messages:CommerceAccessEmail[]=[];
  async sendOrderAccess(message:CommerceAccessEmail) {this.messages.push({...message});}
}
