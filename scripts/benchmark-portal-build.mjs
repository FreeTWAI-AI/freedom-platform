import {readFileSync, realpathSync} from 'node:fs';
import {resolve, relative, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import ts from '@typescript/typescript6';

/** Complete HTML entry/modulepreload + static JS closure; dynamic routes are separate. */
export function measurePortalBuild(directory) {
  const root=realpathSync(directory), html=readFileSync(resolve(root,'index.html'),'utf8');
  const entries=[...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+\.js)["'][^>]*>/g)].map(match=>match[1]);
  if(!entries.length)throw Error('No JavaScript entries');
  const files=new Map();
  function walk(file) {
    const absolute=realpathSync(file), name=relative(root,absolute);
    if(name==='..'||name.startsWith(`..${sep}`)||resolve(absolute)===root)throw Error('Dependency leaves the build directory');
    if(files.has(absolute))return;
    const data=readFileSync(absolute);
    files.set(absolute,{path:name.split(sep).join('/'),bytes:data.length,gzip_bytes:gzipSync(data).length,sha256:createHash('sha256').update(data).digest('hex')});
    const source=ts.createSourceFile(name,data.toString('utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    for(const node of source.statements) {
      if(!(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))||!node.moduleSpecifier||!ts.isStringLiteral(node.moduleSpecifier))continue;
      const specifier=node.moduleSpecifier.text;
      if(!specifier.endsWith('.js'))continue;
      if(!specifier.startsWith('.'))throw Error('Nonlocal dependency');
      walk(resolve(dirname(absolute),specifier));
    }
  }
  for(const entry of entries)walk(resolve(root,entry.replace(/^\//,'')));
  const list=[...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
  return {entries,files:list,bytes:list.reduce((n,file)=>n+file.bytes,0),gzip_bytes:list.reduce((n,file)=>n+file.gzip_bytes,0)};
}
export function comparePortalBuilds(baseline,candidate,maximumRatio=.7) {
  if(!(baseline.gzip_bytes>0&&candidate.gzip_bytes>0&&maximumRatio>0&&maximumRatio<1))throw Error('Invalid measurement');
  const ratio=candidate.gzip_bytes/baseline.gzip_bytes;
  return {baseline,candidate,gzip_ratio:ratio,maximum_ratio:maximumRatio,payload_threshold_passed:ratio<=maximumRatio,scope:'HTML initial static JavaScript closure only; no runtime latency, total installation size, human UX or competitor leadership claim'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==4)throw Error('Usage: node scripts/benchmark-portal-build.mjs BASELINE_DIST CANDIDATE_DIST');
  const baseline=measurePortalBuild(process.argv[2]),candidate=measurePortalBuild(process.argv[3]);
  console.log(JSON.stringify({...comparePortalBuilds(baseline,candidate),eager_baseline_negative_control_rejected:!comparePortalBuilds(baseline,baseline).payload_threshold_passed},null,2));
}
