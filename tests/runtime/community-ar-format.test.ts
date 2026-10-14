import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {decode,encode} from '@msgpack/msgpack';
import {inspectArTarget,inspectArExperience,createArExperience,combineArTargets,AR_TARGET_MAX_BYTES} from '../../packages/asset-storage/ar-target.js';
import {projectTarget} from '../../apps/portal-web/src/modules/community-ar/render.js';

const bytes=readFileSync(new URL('../fixtures/community-ar/card.mind',import.meta.url));
test('AR-FMT-01 actual frozen SDK target is accepted, and media does not enter the inference packet',()=>{
  const shape=inspectArTarget(bytes);assert.deepEqual(shape.targetImage,{width:674,height:372});
  const extended=createArExperience(bytes,{version:1,kind:'text',text:'你好，自由工坊！'});
  assert.equal(inspectArExperience(extended).binding?.kind,'text');
  assert.equal(Object.hasOwn(decode(combineArTargets([extended])) as object,'freedomContent'),false);
});
test('AR-FMT-02 malformed/deep packets, foreign scripts and unsafe geometry are rejected before decoding/inference',()=>{
  assert.throws(()=>inspectArTarget(bytes.subarray(0,-1)));assert.throws(()=>inspectArTarget(new Uint8Array(AR_TARGET_MAX_BYTES+1)));
  const raw=decode(bytes) as any;raw.dataList[0].targetImage.width=Infinity;assert.throws(()=>inspectArTarget(encode(raw)));
  let nested:unknown=0;for(let i=0;i<32;i++)nested=[nested];assert.throws(()=>inspectArTarget(encode(nested)));
  assert.throws(()=>createArExperience(bytes,{version:1,kind:'effect',text:'',effect:'javascript:alert(1)'} as any));
  assert.throws(()=>createArExperience(bytes,{version:1,kind:'image',text:'',mime:'image/svg+xml',media:new TextEncoder().encode('<script/>')}));
});
test('AR-FMT-03 bad descriptor and cluster references cannot reach SDK arrays',()=>{
  const raw=decode(bytes) as any;raw.dataList[0].matchingData[0].maximaPoints[0].descriptors[0]=-1;assert.throws(()=>inspectArTarget(encode(raw)));
  const other=decode(bytes) as any;other.dataList[0].matchingData[0].maximaPointsCluster.rootNode.children[0].pointIndexes[0]=65536;assert.throws(()=>inspectArTarget(encode(other)));
  assert.throws(()=>combineArTargets(Array.from({length:9},()=>bytes)));
});
test('AR-FMT-04 known column-major pose projects onto the video plane; behind-camera/NaN quads are suppressed',()=>{
  const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  assert.deepEqual(projectTarget(identity,identity,[1,1],640,480),[[320,0],[640,0],[640,240],[320,240]]);
  const back=[...identity];back[15]=-1;assert.equal(projectTarget(back,identity,[1,1],640,480),null);
  const bad=[...identity];bad[0]=NaN;assert.equal(projectTarget(bad,identity,[1,1],640,480),null);
});
test('AR-FMT-05 installed self-hosted SDK files retain exact reviewed hashes and no inline worker factory',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../../modules/community-ar/vendor/manifest.json',import.meta.url),'utf8'));
  for(const [name,hash] of Object.entries(manifest.browserAssets)){
    const file=readFileSync(new URL(`../../apps/portal-web/public/assets/${name}`,import.meta.url));
    assert.equal(createHash('sha256').update(file).digest('hex'),hash);
    if(name.startsWith('mindar-controller'))assert.equal(file.toString().includes('data:application/javascript;base64,'),false);
  }
});
