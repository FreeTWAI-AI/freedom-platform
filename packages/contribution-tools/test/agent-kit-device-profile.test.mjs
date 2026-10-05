import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEVICE_CLOSURE, DEVICE_PROFILE, verifyDeviceLaunchClosure } from '../agent-kit-device-profile.mjs';
import { verifyConsumerEntryCoverage } from '../consumer-entry-coverage.mjs';
import { consumerHostTuple } from '../consumer-host-tuples.mjs';
const read = path => readFile(new URL('../../../'+path, import.meta.url));
async function packageCheck(change) {
  const baseline={name:'@freetwai/agent-kit',private:true,type:'module',scripts:{build:'node --check src/cli.mjs',test:'node --test tests/*.test.mjs'}};
  const candidate=structuredClone(baseline);Object.assign(candidate.scripts,{'device:status':'node src/device-cli.mjs',build:'node --check src/cli.mjs && node --check src/device-cli.mjs'});
  change?.(candidate);
  const files=new Map([['package.json',{mode:'100644'}]]);
  return verifyConsumerEntryCoverage({candidateFiles:files,baselineFiles:files,readCandidate:()=>JSON.stringify(candidate),
    readBaseline:()=>JSON.stringify(baseline),entryProfile:DEVICE_PROFILE});
}
test('one explicit host tuple upgrades Kit while all other consumers retain exact legacy source',()=>{
  assert.equal(consumerHostTuple('FreeTWAI-AI/freedom-agent-kit').source,'057201218b6d4ae3e96b4ab838677f2b484b55fa');
  assert.equal(consumerHostTuple('FreeTWAI-AI/freedom-agent-kit').library_profile,DEVICE_PROFILE);
  for(const name of ['freedom-storefront','freedom-supplier-client','FreeTWAI-AI.github.io'])
    assert.equal(consumerHostTuple('FreeTWAI-AI/'+name).source,'91b943ac61e132fbbce72ea066cb2301aa065600');
  assert.throws(()=>consumerHostTuple('candidate-choice'),{code:'unsupported_library_consumer'});
});
test('canonical launcher resolves the exact command and SDK, while private/unused/dead invocations fail closed',async()=>{
  const files=new Map(await Promise.all(DEVICE_CLOSURE.map(async([source,path])=>[path,await read(source)])));
  const evidence=await verifyDeviceLaunchClosure(path=>files.get(path),read);assert.equal(evidence.files.length,3);
  const entry='src/device-cli.mjs', original=files.get(entry);
  for(const mutation of [
    'import "../vendor/freedom-libraries/packages/sdk/machine-device-cli.mjs"; console.log("unused");',
    'import {deviceCliMain} from "../vendor/freedom-libraries/packages/sdk/machine-device-cli.mjs"; if(false)await deviceCliMain(); await fetch("https://platform.example.invalid");',
    original.toString().replace('vendor/freedom-libraries/packages/sdk/machine-device-cli.mjs','src/private-client.mjs'),
    original.toString()+'\nimport "./preload.mjs";\n',
  ]){files.set(entry,Buffer.from(mutation));await assert.rejects(verifyDeviceLaunchClosure(path=>files.get(path),read),{code:'device_launch_closure_mismatch'});}
  files.set(entry,original);
  const sdk=DEVICE_CLOSURE[2][1];files.set(sdk,Buffer.from('export const createMachineDeviceClient=()=>({});'));
  await assert.rejects(verifyDeviceLaunchClosure(path=>files.get(path),read),{code:'device_launch_closure_mismatch'});
});
test('only the declared package entry/build transition passes; hooks, retargets and new registrations fail',async()=>{
  assert.equal((await packageCheck()).status,'passed');
  for(const mutate of [p=>p.scripts['device:status']='node src/private-client.mjs',p=>p.scripts['predevice:status']='node src/preload.mjs',
    p=>p.scripts.build+=' && node src/private-client.mjs',p=>p.bin={'private':'src/private-client.mjs'},
    p=>p.scripts.test='echo passed',p=>p.imports={'#sdk':'./private-client.mjs'}])
    await assert.rejects(packageCheck(mutate),{code:'consumer_entry_registration_changed'});
});
