import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transformSync} from 'esbuild';

// Execute the actual load/focus closures with the stale render snapshot React
// supplies when the earlier platform effect starts its replacement request.
const source=readFileSync(new URL('../../apps/portal-web/src/modules/SocialZone.tsx',import.meta.url),'utf8');
function callback(start:string,end:string){
  const from=source.indexOf(start);assert.ok(from>=0,start);
  const to=source.indexOf(end,from);assert.ok(to>from,end);
  return source.slice(from+start.length,to);
}
for(const oldCursor of [null,'old-filter-cursor']){
  test(`notification focus waits for the new unfiltered first page, stale cursor=${oldCursor}`,async()=>{
    let resolve!:(value:unknown)=>void;
    const pending=new Promise(resolveValue=>{resolve=resolveValue;});
    const requests:string[]=[],notices:string[]=[],actions:string[]=[];
    const focusing={current:{id:'target',pages:0} as {id:string;pages:number}|null};
    let visible=false;
    const context:any={URLSearchParams,loadSequence:{current:0},pendingFeedLoad:{current:false},newPosts:{current:[]},
      client:{get:(path:string)=>{requests.push(path);return pending;}},
      setLoading(){},setMore(){},setError(){},setItems(){},setCursor(){},setCanHide(){},
      focusing,loading:false,more:false,platform:'',cursor:oldCursor,FOCUS_PAGE_LIMIT:4,setNotice:(value:string)=>notices.push(value),
      document:{getElementById:()=>visible?{scrollIntoView:()=>actions.push('scroll'),focus:()=>actions.push('focus')}:null},
    };
    const load=callback('const load = useCallback(', ', [client]);');
    const focus=callback('const target = focusing.current;', '}, [items, loading, more, cursor, platform]);');
    runInNewContext(transformSync(`globalThis.load=${load};globalThis.focus=()=>{const target=focusing.current;${focus}}`,{loader:'ts',format:'cjs'}).code,context);
    const request=context.load(''); // earlier useEffect starts first-page refresh
    context.focus(); // later useEffect still sees loading=false and the old cursor
    assert.deepEqual(requests,['/social-posts']);
    assert.deepEqual(notices,[]);
    assert.equal(focusing.current?.id,'target');
    resolve({items:[],next_cursor:null,can_hide:false});await request;
    visible=true;context.focus();
    assert.deepEqual(actions,['scroll','focus']);assert.equal(focusing.current,null);
  });
}
