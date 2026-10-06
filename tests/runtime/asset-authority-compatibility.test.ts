import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Pool} from 'pg';
import {createAssetLifecycleWithAuthority,type LifecycleProfile,type LifecyclePrepare} from '../../modules/assets/engine.js';
import {memberLifecycleAuthority} from '../../modules/assets/lifecycle-authority.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {Problem} from '../../packages/shared/problem.js';

test('ASSET-AUTHORITY alternate composition cannot inherit any member/human Asset profile',()=>{
  let touched=false;
  const fail=async()=>{touched=true;throw new Error('unreachable');};
  const authority={...memberLifecycleAuthority,clock:fail};
  for(const [purpose,targetKind,variant,inputMaxBytes,outputMaxBytes] of [
    ['member.avatar','member.avatar','avatar',2097152,131072],
    ['work.private-draft','work.private-result','draft',262144,262144],
    ['member.service-cover','member.service-cover','cover',4194304,524288],
    ['community.event-banner','community.event-banner','banner',524288,524288],
    ['community.event-video','community.event-video','video',20971520,20971520],
    ['community.social-thumbnail','community.social-thumbnail','thumbnail',524288,524288],
    ['community.event-highlight','community.event-highlight.image','image',1048576,1048576],
    ['community.event-highlight','community.event-highlight.thumb','thumb',204800,204800],
  ] as const){
    const profile:LifecycleProfile<LifecyclePrepare,never>={purpose,targetKind,variant,inputMaxBytes,outputMaxBytes,
      retireReplacedAsset:false,parsePrepare:raw=>raw,targetId:()=>{touched=true;throw new Error('unreachable');},
      lockTarget:fail,resolvePolicy:fail,requireCapacity:fail,prepareRepresentation:fail,lockPublication:fail,publish:fail};
    assert.throws(()=>createAssetLifecycleWithAuthority({} as Pool,{store:new FakeObjectStore()},profile,authority),
      error=>error instanceof Problem&&error.code==='asset_authority_profile_invalid');
  }
  assert.equal(touched,false);
});
