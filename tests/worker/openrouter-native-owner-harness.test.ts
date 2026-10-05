import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {run} from '../../scripts/verify-openrouter-native-owner.js';

// Exact CLI flow and native bundles, but every provider response/key is generated
// here. The injected transport never calls fetch or accesses a provider network.
test('complete owner acceptance harness preserves Result edit across its second native restart',{timeout:180000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fp-full-owner-harness-'));
  try {
    const receipts=join(directory,'receipts'),ledger=join(directory,'ledger'),key=join(directory,'key'),config=join(directory,'config.json');
    await mkdir(receipts,{mode:0o700});await mkdir(ledger,{mode:0o700});
    const expiresAt=new Date(Date.now()+3600000).toISOString(),model='openai/gpt-4.1-mini';
    await writeFile(key,'sk-or-v1-synthetic-hermetic-owner-only',{mode:0o600});
    await writeFile(join(ledger,'session.json'),JSON.stringify({profile:'private-ai.provider-session-ledger/v1',maxUsd:10,expiresAt,priorReservedUsd:0.10,priorKnownCostUsd:0}),{mode:0o600});
    const {stdout}=await promisify(execFile)('git',['rev-parse','HEAD']);
    await writeFile(config,JSON.stringify({profile:'private-ai.openrouter-owner-acceptance/v1',acknowledgeRealProvider:true,expectedRelease:stdout.trim(),
      keyFile:key,receiptDirectory:receipts,ledgerDirectory:ledger,model,expiresAt,maxUsd:10}),{mode:0o600});
    let posts=0,gets=0;
    const transport:typeof fetch=async(raw,init)=>{
      const url=new URL(String(raw));assert.equal(url.origin,'https://openrouter.ai');
      assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer sk-or-v1-synthetic-hermetic-owner-only');
      if(init?.method==='GET') {
        gets++;
        if(url.pathname==='/api/v1/key')return Response.json({data:{limit:10,limit_remaining:10,limit_reset:'daily',usage:0,expires_at:expiresAt,is_management_key:false}});
        assert.equal(url.pathname,'/api/v1/model/'+model);
        return Response.json({data:{id:model,canonical_slug:model,name:'Synthetic exact model',created:0,context_length:32768,
          architecture:{input_modalities:['text'],output_modalities:['text']},pricing:{prompt:'0.0000004',completion:'0.0000016'},
          top_provider:{is_moderated:true,context_length:32768,max_completion_tokens:128},supported_parameters:['max_completion_tokens','tools','tool_choice']}});
      }
      assert.equal(init?.method,'POST');assert.equal(url.pathname,'/api/v1/chat/completions');assert.equal(++posts,1);
      return Response.json({id:'synthetic-full-harness',object:'chat.completion',created:0,model,
        choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Welcome to our synthetic garden club.'}}],
        usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20,cost:0.000052}});
    };
    const passed=await run(config,{kind:'synthetic_transport',transport});
    const receipt=JSON.parse(await readFile(join(receipts,'receipt.json'),'utf8'));
    assert.equal(passed,true,JSON.stringify({stage:receipt.stage,checkpoint:receipt.checkpoint,status:receipt.lastHttpStatus,checks:receipt.checks}));
    assert.equal(receipt.providerEvidence,'synthetic_test_transport');assert.equal(receipt.status,'pass');
    assert.equal(receipt.checks.ownerResultEditPreservesSource,true);assert.equal(receipt.checks.completedReplayMetadataOnly,true);
    assert.equal(receipt.checks.stop,true);assert.equal(receipt.checks.revoke,true);assert.equal(receipt.cleanup,'completed');
    assert.equal(posts,1);assert.equal(gets,6);assert.equal(receipt.provider.posts,1);assert.equal(receipt.provider.dispatchUnknown,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});
