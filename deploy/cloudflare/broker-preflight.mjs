#!/usr/bin/env node
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {loadManifest,validateManifest} from './lib/manifest.mjs';
import {checkBrokerWranglerConfig} from './lib/broker-wrangler.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
// Existing fixed candidate or explicit filled public-profile check; neither has
// remote credentials, execute mode, provider traffic or authority to enable AI.
try{
  if(process.argv[2]==='--installation'){
    const result=spawnSync(process.execPath,['--import','tsx',resolve(root,'deploy/cloudflare/lib/private-ai-preflight.ts'),...process.argv.slice(3)],{cwd:root,encoding:'utf8',maxBuffer:1024*1024});
    // Child emits only whitelisted report fields or fixed diagnostics. Never
    // forward loader/runtime errors, which can contain an operator input path.
    if(result.status===0||result.status===1){const report=JSON.parse(result.stdout);if(report.schema!=='freedom.private-ai-installation-preflight/v1')throw Error();process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=result.status;}
    else {process.stderr.write('Private AI installation preflight unavailable; check arguments, private file permissions and local tooling.\n');process.exitCode=2;}
  }else{
  if(process.argv.length!==2)throw Error();
  const manifest=loadManifest(),validation=validateManifest(manifest);if(validation.errors.length)throw Error('Canonical deployment manifest is invalid.');
  const report=checkBrokerWranglerConfig(resolve(root,'wrangler.broker.example.jsonc'),manifest);process.stdout.write(JSON.stringify(report,null,2)+'\n');if(!report.structural)process.exitCode=1;
  }
}catch{process.stderr.write('Broker candidate static check failed.\n');process.exitCode=1;}
