import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pageLabelForIssue,labelIssue} from '../../scripts/label-page-issue.js';
import {developmentPages} from '../../modules/development/pages.js';
import {pageHelp} from '../../apps/portal-web/src/page-help.js';

test('human help covers every page and avoids source paths',()=>{
  assert.deepEqual(Object.keys(pageHelp).sort(),developmentPages.map(page=>page.id).sort());
  for(const help of Object.values(pageHelp)){
    assert.ok(help.summary.length>15&&help.steps.length>=2);
    assert.doesNotMatch([help.summary,...help.steps,help.note].join(' '),/apps\/portal-web|modules\/|npm run|page:[a-z]/);
  }
});

test('page label parser accepts only one known marker on an issue',()=>{
  assert.equal(pageLabelForIssue({body:'Hello <!-- freedom-page:account -->'}),'page:account');
  assert.equal(pageLabelForIssue({body:'<!-- freedom-page:unknown -->'}),null);
  assert.equal(pageLabelForIssue({body:'<!-- freedom-page:home --><!-- freedom-page:account -->'}),null);
  assert.equal(pageLabelForIssue({body:'<!-- freedom-page:home -->',pull_request:{}}),null);
});

test('GitHub label automation creates and applies a missing page label once',async()=>{
  const calls:{url:string;method:string;body:string}[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input),method=init?.method??'GET',body=String(init?.body??'');calls.push({url,method,body});
    if(url.endsWith('/issues/42'))return Response.json({number:42,body:'<!-- freedom-page:account -->',labels:[]});
    if(url.endsWith('/labels/page%3Aaccount'))return new Response(null,{status:404});
    if(url.endsWith('/issues/42/labels')&&method==='POST')return Response.json([{name:'page:account'}]);
    if(url.endsWith('/labels')&&method==='POST')return Response.json({name:'page:account'},{status:201});
    throw Error(`Unexpected ${method} ${url}`);
  };
  assert.deepEqual(await labelIssue({fetcher,token:'synthetic',number:42}),{status:'labeled',label:'page:account'});
  assert.equal(calls.length,4);
  assert.deepEqual(JSON.parse(calls[3].body),{labels:['page:account']});
  assert.ok(calls.every(call=>call.url.startsWith('https://api.github.com/repos/FreeTWAI-AI/freedom-platform/')));
});
