/** Read-only drift check for the official skill-book catalog. Run with npm run check:skill-book-upstreams. */
import {appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {communityCatalog, type SkillBook} from '../modules/community/catalog.js';

const shaPattern=/^[a-f0-9]{40}$/;
export type UpstreamCheck={id:string;repository:string;pinned:string;latest?:string;error?:string};

export function githubRepository(url:string):string {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.hostname!=='github.com'||parsed.port||parsed.username||parsed.password||parsed.search||parsed.hash||!/^\/[\w.-]+\/[\w.-]+\/?$/.test(parsed.pathname))throw new Error(`Invalid GitHub repository URL: ${url}`);
  return parsed.pathname.replace(/^\/|\/$/g,'');
}

export function validateSkillBookPin(book:SkillBook):void {
  if(!shaPattern.test(book.source_commit??''))throw new Error(`${book.id}: missing source commit`);
  if(book.guide){
    if(book.guide.source_commit!==book.source_commit)throw new Error(`${book.id}: guide source commit differs from catalog`);
    for(const url of [book.guide.reading_url,...book.guide.source_evidence.map(item=>item.url)]){
      if(!url.includes(`/blob/${book.source_commit}/`))throw new Error(`${book.id}: guide link is not pinned to the source commit: ${url}`);
    }
  }
}

export async function checkSkillBookUpstreams(books:SkillBook[],fetcher:typeof fetch=fetch):Promise<UpstreamCheck[]> {
  const results:UpstreamCheck[]=Array(books.length);
  let next=0;
  const workers=Array.from({length:Math.min(4,books.length)},async()=>{
    while(next<books.length){
      const index=next++,book=books[index];
      const result:UpstreamCheck={id:book.id,repository:book.upstream_url,pinned:book.source_commit??''};
      results[index]=result;
      try{
        validateSkillBookPin(book);
        const repository=githubRepository(book.upstream_url);
        const token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN;
        const response=await fetcher(`https://api.github.com/repos/${repository}/commits?per_page=1`,{headers:{Accept:'application/vnd.github+json',...(token?{Authorization:`Bearer ${token}`}:{})}});
        if(!response.ok)throw new Error(`GitHub API returned HTTP ${response.status}`);
        const commits:unknown=await response.json();
        const sha=Array.isArray(commits)?commits[0]?.sha:undefined;
        if(typeof sha!=='string'||!shaPattern.test(sha))throw new Error('GitHub API returned no default-branch commit');
        result.latest=sha;
      }catch(error){result.error=error instanceof Error?error.message:String(error);}
    }
  });
  await Promise.all(workers);
  return results;
}

export function formatSkillBookUpstreamReport(checks:UpstreamCheck[]):string {
  const changed=checks.filter(check=>check.latest&&check.latest!==check.pinned);
  const errors=checks.filter(check=>check.error);
  const lines=[`# Skill-book upstream drift`,`${checks.length} checked; ${changed.length} changed; ${errors.length} errors.`, ''];
  if(changed.length){
    lines.push('| Book | Pinned | Latest | Compare |','| --- | --- | --- | --- |');
    for(const check of changed){
      const repository=githubRepository(check.repository);
      lines.push(`| ${check.id} | \`${check.pinned.slice(0,12)}\` | \`${check.latest!.slice(0,12)}\` | [review diff](https://github.com/${repository}/compare/${check.pinned}...${check.latest}) |`);
    }
    lines.push('');
  }
  if(errors.length){
    lines.push('## Errors','');
    for(const check of errors)lines.push(`- ${check.id}: ${check.error}`);
    lines.push('');
  }
  if(!changed.length&&!errors.length)lines.push('All catalog pins match their upstream default branches.','');
  lines.push('Review upstream diffs and guide claims before updating pins. This check does not write to GitHub or deploy.');
  return lines.join('\n')+'\n';
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const checks=await checkSkillBookUpstreams(communityCatalog.skill_books);
  const report=formatSkillBookUpstreamReport(checks);
  process.stdout.write(report);
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,report);
  if(checks.some(check=>check.error||check.latest!==check.pinned))process.exitCode=1;
}
