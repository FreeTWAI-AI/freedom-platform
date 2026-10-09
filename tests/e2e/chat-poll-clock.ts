import {expect,type Page} from './fixtures.js';

/** Advance one timer tick only after the preceding browser activity response settled. */
export function chatPollClock(page:Page,activityPath:string){
  let requests=0;
  page.on('request',request=>{if(request.method()==='GET'&&new URL(request.url()).pathname===activityPath)requests++;});
  const poll=async(action:()=>Promise<unknown>)=>{
    const before=requests;
    const answered=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname===activityPath);
    await action();const response=await answered;
    expect(response.ok()).toBe(true);expect(await response.finished()).toBeNull();
    // A protocol round-trip after body completion lets the fetch/JSON promise
    // chain update the schedule before the next virtual timer tick.
    await page.evaluate(()=>Promise.resolve());expect(requests).toBe(before+1);
  };
  return {
    get requests(){return requests;},
    poll,
    async tick(due:boolean){
      if(due)return poll(()=>page.clock.runFor(1000));
      const before=requests;await page.clock.runFor(1000);
      await page.evaluate(()=>Promise.resolve());expect(requests).toBe(before);
    },
  };
}
