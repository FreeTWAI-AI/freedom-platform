import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';
import {generateTotpSecret,totpProvisioningUri} from '../../apps/portal-web/src/modules/totp-setup.js';

test('local provisioning uses 20 secure random bytes and uppercase unpadded base32',t=>{
  const random=t.mock.method(globalThis.crypto,'getRandomValues',(array:Uint8Array)=>{
    assert(array instanceof Uint8Array);assert.equal(array.length,20);
    array.set(new TextEncoder().encode('12345678901234567890'));
    return array;
  });
  assert.equal(generateTotpSecret(),'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(random.mock.callCount(),1);
});

test('authenticator import URI encodes the account and standard TOTP parameters',()=>{
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const uri=new URL(totpProvisioningUri(secret,'member+synthetic@example.test'));
  assert.equal(uri.protocol,'otpauth:');assert.equal(uri.hostname,'totp');
  assert.equal(decodeURIComponent(uri.pathname.slice(1)),'自由工坊:member+synthetic@example.test');
  assert.deepEqual(Object.fromEntries(uri.searchParams),{secret,issuer:'自由工坊',algorithm:'SHA1',digits:'6',period:'30'});
});

test('login repeats credentials with either authenticator or backup code and preserves totp_required',async t=>{
  const requests:{email:string;password:string;code?:string}[]=[];
  t.mock.method(globalThis,'fetch',async(_url:unknown,options?:RequestInit)=>{
    requests.push(JSON.parse(String(options?.body)));
    return requests.length===1?Response.json({code:'totp_required'},{status:401}):Response.json({csrf_token:'synthetic-token',user:{user_id:'synthetic-member'}});
  });
  const client=new PortalClient();let unauthorized=0;
  client.onUnauthorized=()=>{unauthorized++};
  await assert.rejects(client.login('member@example.test','synthetic-password'),cause=>cause instanceof ApiError&&cause.code==='totp_required');
  await client.login('member@example.test','synthetic-password','012345');
  await client.login('member@example.test','synthetic-password','synthetic-backup-code');
  assert.deepEqual(requests,[
    {email:'member@example.test',password:'synthetic-password'},
    {email:'member@example.test',password:'synthetic-password',code:'012345'},
    {email:'member@example.test',password:'synthetic-password',code:'synthetic-backup-code'},
  ]);
  assert.equal(unauthorized,0);assert.equal(client.csrfToken,null,'login caller applies only completed sessions');
});
