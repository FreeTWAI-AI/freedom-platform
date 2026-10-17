import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';

const rings=new WeakMap<CommerceCredentialKeyring,ReadonlyMap<string,Buffer>>();
const redacted='[CommerceCredentialKeyring redacted]';
const invalidRing=()=>new Error('Invalid commerce credential keyring.');
const unavailable=()=>new Error('Commerce credential unavailable.');
export class CommerceCredentialKeyring {
  private constructor(public readonly activeKeyId:string,keys:ReadonlyMap<string,Buffer>){rings.set(this,keys);Object.freeze(this);}
  static parse(raw:string|undefined):CommerceCredentialKeyring|null {
    if(raw===undefined||raw==='')return null;
    if(typeof raw!=='string'||/\s/.test(raw))throw invalidRing();
    const entries=raw.split(','),keys=new Map<string,Buffer>();
    if(entries.length<1||entries.length>8)throw invalidRing();
    for(const entry of entries){
      const parts=entry.split(':');
      if(parts.length!==2||!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(parts[0])||keys.has(parts[0]))throw invalidRing();
      const bytes=Buffer.from(parts[1],'base64');
      if(bytes.length!==32||bytes.toString('base64')!==parts[1])throw invalidRing();
      keys.set(parts[0],bytes);
    }
    return new CommerceCredentialKeyring(entries[0].split(':')[0],keys);
  }
  toJSON(){return redacted;}
  toString(){return redacted;}
  [Symbol.for('nodejs.util.inspect.custom')](){return redacted;}
}
export interface CredentialContext {account_id:string;purpose:'payment'|'logistics'|'invoice';environment:'sandbox'|'live';credential_version:number}
export interface CredentialMaterial {hash_key:string;hash_iv:string;credit_check_code?:string}
export interface SealedCredential {key_id:string;sealed:string}
function materialOf(value:unknown,purpose:CredentialContext['purpose']):CredentialMaterial {
  if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable();
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['hash_key','hash_iv','credit_check_code'].includes(k))
    ||typeof v.hash_key!=='string'||!/^[A-Za-z0-9]{16}$/.test(v.hash_key)
    ||typeof v.hash_iv!=='string'||!/^[A-Za-z0-9]{16}$/.test(v.hash_iv)
    ||('credit_check_code' in v&&(purpose!=='payment'||typeof v.credit_check_code!=='string'||!/^\d{8}$/.test(v.credit_check_code))))throw unavailable();
  return {hash_key:v.hash_key,hash_iv:v.hash_iv,...('credit_check_code' in v?{credit_check_code:v.credit_check_code as string}:{})};
}
const aad=(ctx:CredentialContext)=>Buffer.from(`freedom.commerce-provider-credential.v1:${ctx.account_id}:${ctx.purpose}:${ctx.environment}:${ctx.credential_version}`);
function keyOf(keyring:CommerceCredentialKeyring,id:string):Buffer {
  const key=rings.get(keyring)?.get(id);if(!key)throw unavailable();return key;
}
function sealWithNonce(keyring:CommerceCredentialKeyring,ctx:CredentialContext,material:CredentialMaterial,nonce:Buffer):SealedCredential {
  if(nonce.length!==12)throw unavailable();
  const value=materialOf(material,ctx.purpose),cipher=createCipheriv('aes-256-gcm',keyOf(keyring,keyring.activeKeyId),nonce);
  cipher.setAAD(aad(ctx));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return {key_id:keyring.activeKeyId,sealed:Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64')};
}
export function sealCredential(keyring:CommerceCredentialKeyring,ctx:CredentialContext,material:CredentialMaterial):SealedCredential {
  return sealWithNonce(keyring,ctx,material,randomBytes(12));
}
/** Internal deterministic vector seam. Runtime callers use sealCredential. */
export const _sealCredentialWithNonceForTest=sealWithNonce;
export function unsealCredential(keyring:CommerceCredentialKeyring,ctx:CredentialContext,row:SealedCredential):CredentialMaterial {
  try {
    const raw=Buffer.from(row.sealed,'base64');
    if(raw.length<29||raw.toString('base64')!==row.sealed)throw unavailable();
    const decipher=createDecipheriv('aes-256-gcm',keyOf(keyring,row.key_id),raw.subarray(0,12));
    decipher.setAAD(aad(ctx));decipher.setAuthTag(raw.subarray(12,28));
    return materialOf(JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8')),ctx.purpose);
  }catch{throw unavailable();}
}
export function resealCredential(keyring:CommerceCredentialKeyring,ctx:CredentialContext,row:SealedCredential):SealedCredential {
  return sealCredential(keyring,ctx,unsealCredential(keyring,ctx,row));
}
export function credentialFingerprint(keyring:CommerceCredentialKeyring,input:{account_id:string;purpose:CredentialContext['purpose'];profile:string}&CredentialMaterial):string {
  const material=materialOf({hash_key:input.hash_key,hash_iv:input.hash_iv,...(input.credit_check_code!==undefined?{credit_check_code:input.credit_check_code}:{})},input.purpose);
  const derived=createHmac('sha256',keyOf(keyring,keyring.activeKeyId)).update('freedom.commerce-credential-fingerprint.v1').digest();
  return createHmac('sha256',derived).update(JSON.stringify([input.account_id,input.purpose,input.profile,material.hash_key,material.hash_iv,material.credit_check_code??null])).digest('hex');
}
