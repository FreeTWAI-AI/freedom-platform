#!/usr/bin/env node
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadManifest,validateManifest} from './lib/manifest.mjs';
import {checkBrokerWranglerConfig} from './lib/broker-wrangler.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
// Fixed repository candidate; no remote credentials, secret flags or execute mode.
try{
  if(process.argv.length!==2)throw Error('This static candidate check accepts no deployment or credential arguments.');
  const manifest=loadManifest(),validation=validateManifest(manifest);if(validation.errors.length)throw Error('Canonical deployment manifest is invalid.');
  const report=checkBrokerWranglerConfig(resolve(root,'wrangler.broker.example.jsonc'),manifest);process.stdout.write(JSON.stringify(report,null,2)+'\n');if(!report.structural)process.exitCode=1;
}catch{process.stderr.write('Broker candidate static check failed.\n');process.exitCode=1;}
