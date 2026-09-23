// Synthetic GitHub responses for the dedicated browser-test server only.
// Real Platform routes, authentication, migrations and PostgreSQL are exercised.
export function collaborationGitHubFixture(input:string|URL|Request):Response {
  const url=new URL(input instanceof Request?input.url:String(input));
  const base='/repos/FreeTWAI-AI/video-autopilot-kit';
  if(url.origin!=='https://api.github.com')throw Error('Unexpected test outbound host');
  if(url.pathname===base)return Response.json({id:1382968090,full_name:'FreeTWAI-AI/video-autopilot-kit',private:false,visibility:'public',archived:false});
  if(url.pathname===base+'/issues')return Response.json([{number:1,title:'建立可重現的剪輯測試素材',body:'## 完成條件\n提供授權清楚的合成素材、README 與可重跑的檢查。',state:'open',labels:[{name:'good first issue'}],assignees:[]}]);
  if(url.pathname===base+'/pulls')return Response.json([{number:8,title:'補上剪輯測試說明',user:{id:12345,login:'contributor-demo',type:'User'},merged_at:'2026-09-23T08:00:00Z',merge_commit_sha:'b'.repeat(40)}]);
  throw Error('Unexpected outbound GitHub test request: '+url.pathname);
}
