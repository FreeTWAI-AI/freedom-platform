#!/usr/bin/env node
import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadManifest} from './lib/manifest.mjs';
import {planIsolatedCandidate} from './lib/isolated-candidate.mjs';

export function runCandidateAdmission(args) {
  try {
    if(args.length && !(args.length===2&&args[0]==='--request'&&args[1]&&!args[1].startsWith('--')))throw Error();
    const path=args.length?resolve(args[1]):fileURLToPath(new URL('./candidate/isolated-request.example.json',import.meta.url));
    const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>65536)throw Error();
    const report=planIsolatedCandidate(JSON.parse(readFileSync(path,'utf8')),loadManifest());
    return {exitCode:report.structural?2:1,report};
  } catch {return {exitCode:1,report:{schema:'freedom.isolated-candidate-admission/v1',status:'invalid',code:'candidate_request_unavailable',deployment_authority:false,execution_authority:false,provider_mutations:0,database_connections:0,remote_acceptance:'not_run'}};}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {exitCode,report}=runCandidateAdmission(process.argv.slice(2));process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=exitCode;
}
