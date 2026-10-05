import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('media restore runner reconciles late create acknowledgement by exact owned name before removing its intent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fp-restore-create-test-'));
  const record = join(directory, 'record.json');
  try {
    writeFileSync(join(directory, 'docker'), `#!${process.execPath}
const fs=require('node:fs'),p=${JSON.stringify(record)},args=process.argv.slice(2);
let s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{calls:[],inspections:0};s.calls.push(args);
const save=()=>fs.writeFileSync(p,JSON.stringify(s));
if(args[0]==='create'){
 s.name=args[args.indexOf('--name')+1];s.socket=/source=([^,]+)/.exec(args[args.indexOf('--mount')+1])[1];s.image=args.find(x=>x.startsWith('postgres:'));save();process.exit(1);
}
if(args[0]==='inspect'){
 s.inspections++;save();if(s.inspections===1)process.exit(1);
 console.log(JSON.stringify([{Id:'a'.repeat(64),Name:'/'+s.name,Config:{Image:s.image,Labels:{'freedom.task':'media-restore-drill','freedom.owner':'run-media-restore-test'}},HostConfig:{NetworkMode:'none',PortBindings:{},Tmpfs:{'/var/lib/postgresql':'rw'}},Mounts:[{Type:'bind',Source:s.socket,Destination:'/pgsocket'}]}]));
}else if(args[0]==='rm'){s.removed=args[2];save();}else{save();process.exit(2);}
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ['scripts/run-media-restore-test.mjs'], { cwd: resolve('.'), env: { ...process.env, PATH: directory + ':' + process.env.PATH }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, 'unknown create acknowledgement remains an actual failed drill');
    const actual = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(actual.calls.filter(a => a[0] === 'create').length, 1, 'never retry unknown creation');
    assert(!actual.calls.some(a => a[0] === 'start'), 'never start a fixture after ambiguous create');
    assert.equal(actual.removed, 'a'.repeat(64));
    assert.equal(actual.calls.find(a => a[0] === 'inspect')[1], actual.name);
    assert.equal(existsSync(actual.socket), false);
    assert.equal(existsSync(join(actual.socket, '..', 'container-intent.json')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
