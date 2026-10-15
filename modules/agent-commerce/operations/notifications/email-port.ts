/** The M1 runtime installs no email adapter. Never send inside a SQL transaction. */
export interface CommerceAccessEmail {to:string;accessUrl:string;displayNumber:string}
export interface CommerceEmailPort {sendOrderAccess(message:CommerceAccessEmail):Promise<void>}
export class FixtureEmailSender implements CommerceEmailPort {
  readonly messages:CommerceAccessEmail[]=[];
  async sendOrderAccess(message:CommerceAccessEmail) {this.messages.push({...message});}
}
