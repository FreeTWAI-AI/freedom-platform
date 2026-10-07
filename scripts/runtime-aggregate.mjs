import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { readBounded, parseJson } from '../packages/contribution-tools/io.mjs';
import { aggregateRuntimePartitions } from '../packages/contribution-tools/suite-runner.mjs';

const args = process.argv.slice(2);
const [count, rest] = args[0] === '--partition-count' ? [args[1], args.slice(2)] : ['4', args];
if (!['4','6'].includes(count) || rest.length !== 4 || rest[0] !== '--input-dir' || !rest[1] || rest[2] !== '--output' || !rest[3]) {
  console.error('invalid_runtime_aggregate_arguments'); process.exit(2);
}
const partitionCount = Number(count);
let report;
try {
  const fragments = [];
  for (let index=0;index<partitionCount;index++) fragments.push(parseJson(await readBounded(resolve(rest[1]),`runtime-partition-${index}.json`,16_000_000),{maxBytes:16_000_000,maxNodes:500_000}));
  report = await aggregateRuntimePartitions(process.cwd(),fragments,{partitionCount});
} catch { report={check_id:'runtime.full',status:'failed',reason:'runtime_partition_artifacts_unavailable',gate_enforced:false,merge_authorized:false}; }
const output=resolve(rest[3]);await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(report)+'\n');
console.log(JSON.stringify({check_id:report.check_id,status:report.status,reason:report.reason,test_count:report.test_count,evidence_sha256:report.evidence_sha256,gate_enforced:false,merge_authorized:false}));
process.exitCode=report.status==='passed'?0:1;
