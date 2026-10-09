const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Provisioning material is generated in the browser, never fetched from the API. */
export function generateTotpSecret():string {
  const bytes=crypto.getRandomValues(new Uint8Array(20));
  let bits=0,value=0,secret='';
  for(const byte of bytes){
    value=(value<<8)|byte;bits+=8;
    while(bits>=5){bits-=5;secret+=alphabet[(value>>>bits)&31];}
    value&=(1<<bits)-1;
  }
  return secret;
}

export function totpProvisioningUri(secret:string,account:string):string {
  const issuer='自由工坊';
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?${new URLSearchParams({secret,issuer,algorithm:'SHA1',digits:'6',period:'30'})}`;
}
