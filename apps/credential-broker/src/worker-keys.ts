import { base64url } from 'jose';
/** Native key identity checks for broker Worker secrets/pins.
 * workerd accepts an Ed25519 private JWK whose public `x` is unrelated to its
 * private `d` and then signs with `d`. A declared public identity is therefore
 * only accepted after a fresh signature by the private key verifies under a key
 * imported from the declared `x` alone.
 * Every `x`/`d` must be canonical unpadded base64url of exactly 32 bytes: a
 * 43-character string has 2 spare pad bits, so noncanonical aliases of the same
 * bytes would otherwise bypass string-based cross-purpose identity checks. */
const separation=new TextEncoder().encode('freedom/credential-broker/private-jwk-identity/v1');
export function canonicalEd25519Component(value:unknown):string{
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$(?![\s\S])/.test(value))throw new Error('broker_key_invalid');
  let bytes:Uint8Array;try{bytes=base64url.decode(value);}catch{throw new Error('broker_key_invalid');}
  try{if(bytes.byteLength!==32||base64url.encode(bytes)!==value)throw new Error('broker_key_invalid');}finally{bytes.fill(0);}
  return value;
}
export interface VerifiedEd25519Signer {readonly privateKey:CryptoKey;readonly publicKey:CryptoKey;readonly x:string}
export async function importVerifiedEd25519Signer(jwk:{kty:'OKP';crv:'Ed25519';x:string;d:string}):Promise<VerifiedEd25519Signer>{
  if(!jwk||jwk.kty!=='OKP'||jwk.crv!=='Ed25519')throw new Error('broker_key_invalid');
  const x=canonicalEd25519Component(jwk.x),d=canonicalEd25519Component(jwk.d);
  const privateKey=await crypto.subtle.importKey('jwk',{kty:'OKP',crv:'Ed25519',x,d},{name:'Ed25519'},false,['sign']);
  const publicKey=await crypto.subtle.importKey('jwk',{kty:'OKP',crv:'Ed25519',x},{name:'Ed25519'},false,['verify']);
  const challenge=crypto.getRandomValues(new Uint8Array(32)),message=new Uint8Array(separation.length+challenge.length);
  message.set(separation);message.set(challenge,separation.length);
  const signature=await crypto.subtle.sign('Ed25519',privateKey,message);
  if(!await crypto.subtle.verify('Ed25519',publicKey,signature,message))throw new Error('broker_key_invalid');
  // A tampered message must fail too; this rules out a verifier that accepts anything.
  message[message.length-1]^=1;
  if(await crypto.subtle.verify('Ed25519',publicKey,signature,message))throw new Error('broker_key_invalid');
  return Object.freeze({privateKey,publicKey,x});
}
/** Imports pinned public keys for one purpose. Each key id and each canonical
 * public `x` must be unique across every purpose registered in `seen`. */
export async function importPinnedEd25519(pins:readonly {keyId:string;publicJwk:{kty:'OKP';crv:'Ed25519';x:string}}[],seen:Set<string>):Promise<Map<string,CryptoKey>>{
  const keys=new Map<string,CryptoKey>();
  for(const pin of pins){
    const x=canonicalEd25519Component(pin.publicJwk.x);
    if(keys.has(pin.keyId)||seen.has(x))throw new Error('broker_key_invalid');seen.add(x);
    keys.set(pin.keyId,await crypto.subtle.importKey('jwk',{kty:'OKP',crv:'Ed25519',x},{name:'Ed25519'},false,['verify']));
  }
  return keys;
}
