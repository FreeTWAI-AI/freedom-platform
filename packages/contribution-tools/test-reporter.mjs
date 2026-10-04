import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { writeSync } from 'node:fs';
import { artifactPath, parseJson, readBounded, sha256 } from './io.mjs';


const PROGRESS_SCHEMA = 'freedom.test-file-progress/v1';
const PROGRESS_MAX_BYTES = 1_048_576, PROGRESS_MAX_LINE = 2048, PROGRESS_MAX_FILES = 512;
const PROGRESS_COUNTS = ['tests','passed','failed','cancelled','skipped','todo','suites'];
const validCounts = c => c && typeof c==='object' && !Array.isArray(c)
  && Object.keys(c).length===PROGRESS_COUNTS.length && PROGRESS_COUNTS.every(k=>Number.isSafeInteger(c[k])&&c[k]>=0&&c[k]<=20_000)
  && c.tests===['passed','failed','cancelled','skipped','todo'].reduce((n,k)=>n+c[k],0);
function progressPath(path) { artifactPath(path); if (!/\.test\.(?:ts|mjs)$/.test(path)) throw Error('invalid_progress_path'); return path; }
/** Parent validates every byte before emitting a fresh, closed diagnostic. These
 * candidate-process records never participate in final result admission. */
export function createProgressDecoder(expectedSources, emit) {
  const expected=new Map(expectedSources.map(({path,source_sha256})=>[progressPath(path),source_sha256]));
  if(expected.size!==expectedSources.length||expected.size>PROGRESS_MAX_FILES||[...expected.values()].some(d=>! /^[a-f0-9]{64}$/.test(d)))throw Error('invalid_progress_selection');
  const started=new Set(),completed=new Set();let bytes=0,records=0,pending=Buffer.alloc(0),invalid=false,exhausted=false;
  function record(line){
    if(++records>PROGRESS_MAX_FILES*2){invalid=true;exhausted=true;return;}
    try{
      const r=parseJson(line,{maxBytes:PROGRESS_MAX_LINE,maxDepth:3,maxNodes:32});
      const keys=r.event==='started'?['schema','event','path','source_sha256','elapsed_ms']:['schema','event','path','source_sha256','elapsed_ms','counts'];
      if(Object.keys(r).length!==keys.length||!keys.every(k=>Object.hasOwn(r,k))||r.schema!==PROGRESS_SCHEMA||!['started','completed'].includes(r.event)
        ||!expected.has(r.path)||expected.get(r.path)!==r.source_sha256||!Number.isSafeInteger(r.elapsed_ms)||r.elapsed_ms<0||r.elapsed_ms>900_000
        ||(r.event==='started'?started.has(r.path):!started.has(r.path)||completed.has(r.path)||!validCounts(r.counts)))throw Error();
      (r.event==='started'?started:completed).add(r.path);
      // Reconstruct rather than relay parsed bytes or unknown candidate fields.
      emit({schema:PROGRESS_SCHEMA,event:r.event,path:r.path,source_sha256:r.source_sha256,elapsed_ms:r.elapsed_ms,
        ...(r.event==='completed'?{counts:Object.fromEntries(PROGRESS_COUNTS.map(k=>[k,r.counts[k]]))}:{})});
    }catch{invalid=true;}
  }
  return Object.freeze({
    push(chunk){if(exhausted)return;bytes+=chunk.length;if(bytes>PROGRESS_MAX_BYTES){invalid=true;exhausted=true;pending=Buffer.alloc(0);return;}
      pending=Buffer.concat([pending,chunk]);let newline;
      while(!exhausted&&(newline=pending.indexOf(10))!==-1){const line=pending.subarray(0,newline);pending=pending.subarray(newline+1);if(line.length>PROGRESS_MAX_LINE){invalid=true;continue;}record(line);}
      if(pending.length>PROGRESS_MAX_LINE){invalid=true;exhausted=true;pending=Buffer.alloc(0);}
    },
    finish(){return {schema:'freedom.test-file-progress-summary/v1',selected_count:expected.size,started_count:started.size,completed_count:completed.size,incomplete:invalid||pending.length>0||completed.size!==expected.size};},
  });
}
async function fileProgress() {
  const epoch=performance.now();let selected;
  try{
    if(typeof process.env.FREEDOM_TEST_PROGRESS_FILES!=='string')return ()=>{};
    const paths=parseJson(process.env.FREEDOM_TEST_PROGRESS_FILES,{maxBytes:131_072,maxDepth:2,maxNodes:514});
    if(!Array.isArray(paths)||paths.length>PROGRESS_MAX_FILES||new Set(paths).size!==paths.length)throw Error();
    selected=new Map();let total=0;
    for(const path of paths){progressPath(path);const bytes=await readBounded(process.cwd(),path);total+=bytes.length;if(total>32_000_000)throw Error();selected.set(path,sha256(bytes));}
  }catch{return ()=>{};}
  const started=new Set(),completed=new Set();let records=0,total=0,disabled=false;
  return event=>{
    if(disabled)return;
    const d=event.data,path=typeof d?.file==='string'?relative(process.cwd(),d.file):'';
    if(!selected.has(path))return;
    const start=event.type==='test:dequeue'&&d.entryFile===undefined&&d.nesting===0;
    const complete=event.type==='test:summary'&&started.has(path);
    if((!start&&!complete)||(start&&started.has(path))||(complete&&completed.has(path)))return;
    const counts=complete?Object.fromEntries(PROGRESS_COUNTS.map(k=>[k,d.counts?.[k]])):undefined;
    if(complete&&!validCounts(counts))return;
    (start?started:completed).add(path);
    const value={schema:PROGRESS_SCHEMA,event:start?'started':'completed',path,source_sha256:selected.get(path),elapsed_ms:Math.min(900_000,Math.max(0,Math.floor(performance.now()-epoch))),...(complete?{counts}:{})};
    const line=JSON.stringify(value)+'\n';total+=Buffer.byteLength(line);
    if(++records>PROGRESS_MAX_FILES*2||total>PROGRESS_MAX_BYTES){disabled=true;return;}
    try{writeSync(3,line);}catch{disabled=true;}
  };
}

// Structured events avoid accidental TAP/stdout confusion, not hostile-code
// spoofing: this reporter and the tests still run in a candidate-controlled
// local checkout. Never promote these records to authenticated host observations.
export default async function* report(source) {
  const files = [], cases = [], suites = [];
  const progress = await fileProgress();
  for await (const event of source) {
    progress(event);
    if (['test:pass', 'test:fail'].includes(event.type) && ['test', 'suite'].includes(event.data.details?.type)) {
      const d = event.data;
      const file = typeof d.file === 'string' ? relative(process.cwd(), d.file) : '';
      const status = d.skip !== undefined ? 'skipped' : d.todo !== undefined ? 'todo' : event.type === 'test:pass' ? 'passed'
        : ['cancelledByParent', 'testAborted', 'testTimeoutFailure'].includes(d.details.error?.failureType) ? 'cancelled' : 'failed';
      // Locations and runner identifiers, never test names, assertion text,
      // exception messages, stdout, database URLs or ambient environment.
      const identity = JSON.stringify([file, d.details.type, d.line, d.column, d.nesting, d.testNumber, d.testId, d.parentId]);
      (d.details.type === 'suite' ? suites : cases).push({ file, case_sha256: createHash('sha256').update(identity).digest('hex'), status });
    }
    if (event.type !== 'test:summary') continue;
    const { file, counts, success } = event.data;
    if (file) files.push({ file: relative(process.cwd(), file), counts, success });
    else yield JSON.stringify({ counts, success, files, cases, suites }) + '\n';
  }
}
