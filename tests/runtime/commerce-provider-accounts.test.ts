import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {test} from 'node:test';
import {CommerceCredentialKeyring,sealCredential,unsealCredential,resealCredential,credentialFingerprint,_sealCredentialWithNonceForTest} from '../../modules/agent-commerce/payments/credentials.js';
import {CREDENTIAL_SEAL_VECTOR as vector} from '../../modules/agent-commerce/payments/credential-seal-vector.js';
const randomMaterial=()=>({hash_key:randomBytes(16).toString('hex').slice(0,16),hash_iv:randomBytes(16).toString('hex').slice(0,16),credit_check_code:String(randomBytes(4).readUInt32BE()%100000000).padStart(8,'0')});
const entry=(id='current')=>`${id}:${randomBytes(32).toString('base64')}`;
const context=()=>({account_id:randomUUID(),purpose:'payment' as const,environment:'sandbox' as const,credential_version:1});
test('keyring parse enforces canonical opaque 1..8 entries and fixed errors',()=>{
  assert.equal(CommerceCredentialKeyring.parse(undefined),null);assert.equal(CommerceCredentialKeyring.parse(''),null);
  const one=entry(),eight=Array.from({length:8},(_,i)=>entry('key'+i)).join(',');
  for(const raw of [one,eight]){const ring=CommerceCredentialKeyring.parse(raw)!;assert.equal(ring.activeKeyId,raw.split(':')[0]);assert(!JSON.stringify(ring).includes(raw));assert(!inspect(ring).includes(raw));assert.deepEqual(Object.keys(ring),['activeKeyId']);}
  for(const raw of [eight+','+entry('ninth'),one+','+one,entry('BAD'),entry('-bad'),entry('a'.repeat(33)),one+' ',one+',',one.replace('=', ''),`bad:${randomBytes(31).toString('base64')}`,`bad:${randomBytes(33).toString('base64')}`,one.replace(':',': '),':',one+':extra']){
    assert.throws(()=>CommerceCredentialKeyring.parse(raw),(e:unknown)=>e instanceof Error&&e.message==='Invalid commerce credential keyring.'&&!e.message.includes(raw));
  }
});
test('sealing binds every AAD component and validates integrity; keys rotate without losing old rows',()=>{
  const old=entry('old'),next=entry('next'),ring=CommerceCredentialKeyring.parse(old)!,both=CommerceCredentialKeyring.parse(next+','+old)!;
  const ctx=context(),material=randomMaterial(),sealed=sealCredential(ring,ctx,material);
  assert.deepEqual(unsealCredential(ring,ctx,sealed),material);assert.deepEqual(unsealCredential(both,ctx,sealed),material);
  for(const changed of [{account_id:randomUUID()},{purpose:'invoice' as const},{environment:'live' as const},{credential_version:2}])assert.throws(()=>unsealCredential(both,{...ctx,...changed},sealed),{message:'Commerce credential unavailable.'});
  for(const row of [{...sealed,key_id:'missing'},{...sealed,sealed:'invalid'},{...sealed,sealed:Buffer.from(sealed.sealed,'base64').fill(0,12,28).toString('base64')}])assert.throws(()=>unsealCredential(both,ctx,row),{message:'Commerce credential unavailable.'});
  const resealed=resealCredential(both,ctx,sealed);assert.equal(resealed.key_id,'next');assert.deepEqual(unsealCredential(CommerceCredentialKeyring.parse(next)!,ctx,resealed),material);
  const input={...material,account_id:ctx.account_id,purpose:ctx.purpose,profile:'ecpay.aio.credit.v1'};
  const fingerprint=credentialFingerprint(ring,input);assert.match(fingerprint,/^[a-f0-9]{64}$/);assert.equal(credentialFingerprint(ring,input),fingerprint);
  assert.notEqual(credentialFingerprint(both,input),fingerprint);assert.notEqual(credentialFingerprint(ring,{...input,...randomMaterial()}),fingerprint);
});
test('synthetic sealed vector interoperates with a deterministic internal seam',()=>{
  const ring=CommerceCredentialKeyring.parse(vector.keyring)!;
  assert.deepEqual(unsealCredential(ring,vector.context,vector.row),vector.material);
  assert.deepEqual(_sealCredentialWithNonceForTest(ring,vector.context,vector.material,Buffer.from(Array.from({length:12},(_,i)=>i))),vector.row);
});
