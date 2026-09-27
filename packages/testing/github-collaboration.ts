// Synthetic GitHub responses for the dedicated browser-test server only.
// Real Platform routes, authentication, migrations and PostgreSQL are exercised.
export function collaborationGitHubFixture(input:string|URL|Request):Response {
  const url=new URL(input instanceof Request?input.url:String(input));
  const base='/repos/FreeTWAI-AI/video-autopilot-kit';
  if(url.origin!=='https://api.github.com')throw Error('Unexpected test outbound host');
  if(url.pathname==='/repos/FreeTWAI-AI/freedom-platform/issues')return Response.json([
    {number:12,title:'讓會員首頁的文字更清楚',body:'頁面標記：page:home\n\n<!-- freedom-page:home -->',state:'open',created_at:'2026-09-25T12:00:00Z',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/12',user:{login:'member-demo'},labels:[]},
    {number:13,title:'改善手機導覽',body:'<!-- freedom-page:home -->',state:'open',created_at:'2026-09-26T12:00:00Z',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/pull/13',user:{login:'contributor-demo'},labels:[],pull_request:{url:'https://api.github.com/repos/FreeTWAI-AI/freedom-platform/pulls/13'}},
  ]);
  if(url.pathname==='/repos/FreeTWAI-AI/freedom-platform/events')return Response.json([
    {id:'page-test-1',type:'IssuesEvent',actor:{login:'member-demo'},created_at:'2026-09-25T12:00:00Z',payload:{action:'opened',issue:{number:12,title:'讓會員首頁的文字更清楚',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/12'}}},
    {id:'page-test-2',type:'PullRequestEvent',actor:{login:'contributor-demo'},created_at:'2026-09-26T12:00:00Z',payload:{action:'opened',pull_request:{number:13,title:'改善手機導覽',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/pull/13'}}},
    {id:'page-test-3',type:'PullRequestReviewEvent',actor:{login:'maintainer-demo'},created_at:'2026-09-26T13:00:00Z',payload:{action:'created',pull_request:{number:13,title:'改善手機導覽',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/pull/13'},review:{state:'approved',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/pull/13#pullrequestreview-3'}}},
    {id:'page-test-4',type:'IssueCommentEvent',actor:{login:'designer-demo'},created_at:'2026-09-26T14:00:00Z',payload:{action:'created',issue:{number:12,title:'讓會員首頁的文字更清楚',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/12'},comment:{body:'願意接手設計\n\n<!-- freedom-design-claim -->',html_url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/12#issuecomment-4'}}},
  ]);
  if(url.pathname===base)return Response.json({id:1382968090,full_name:'FreeTWAI-AI/video-autopilot-kit',private:false,visibility:'public',archived:false});
  if(url.pathname===base+'/issues')return Response.json([{number:1,title:'建立可重現的剪輯測試素材',body:'## 完成條件\n提供授權清楚的合成素材、README 與可重跑的檢查。',state:'open',labels:[{name:'good first issue'}],assignees:[]}]);
  if(url.pathname===base+'/pulls')return Response.json([{number:8,title:'補上剪輯測試說明',user:{id:12345,login:'contributor-demo',type:'User'},merged_at:'2026-09-23T08:00:00Z',merge_commit_sha:'b'.repeat(40)}]);
  throw Error('Unexpected outbound GitHub test request: '+url.pathname);
}
