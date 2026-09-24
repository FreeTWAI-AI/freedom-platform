import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,PortalClient} from '../../apps/portal-web/src/api.js';
import {GitHubSocialStore,type GitHubConnection,type GitHubStarState} from '../../apps/portal-web/src/modules/github-social-client.js';

const connected:GitHubConnection={configured:true,connected:true,github_user:{id:'101',login:'synthetic-member'}};
const unlinked:GitHubConnection={configured:true,connected:false,github_user:null};
const starPath=(id:string)=>`/me/github/books/${id}/star`;
const star=(id:string,starred=false):GitHubStarState=>({book_id:id,connected:true,starred});
const expired=()=>new ApiError({status:409,code:'github_reconnect_required',message:'請重新連結 GitHub。'});
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
class Client extends PortalClient{
  gets:string[]=[];
  posts:{path:string;body:unknown}[]=[];
  constructor(readonly read:(path:string)=>unknown|Promise<unknown>,readonly write:(path:string,body:unknown)=>unknown|Promise<unknown>=()=>{throw Error('Unexpected mutation');}){super();}
  override async get<T>(path:string){this.gets.push(path);return await this.read(path) as T;}
  override async post<T>(path:string,body:unknown){this.posts.push({path,body});return await this.write(path,body) as T;}
}

test('expired Star read reloads authoritative connection and discards every cached or in-flight private Star',async()=>{
  let accountReads=0;
  const pending=deferred<GitHubStarState>();
  const client=new Client(path=>{
    if(path==='/me/github')return accountReads++?unlinked:connected;
    if(path===starPath('cached'))return star('cached',true);
    if(path===starPath('pending'))return pending.promise;
    if(path===starPath('expired'))throw expired();
    throw Error(`Unexpected GET ${path}`);
  });
  const store=new GitHubSocialStore(client,true);
  await store.loadAccount();await store.loadStar('cached');
  const pendingRead=store.loadStar('pending');
  await store.loadStar('expired');
  assert.deepEqual(store.account.value,unlinked);
  assert.equal(store.star('cached').value,undefined);
  assert.equal(store.star('expired').value,undefined);
  pending.resolve(star('pending',true));await pendingRead;
  assert.equal(store.star('pending').value,undefined,'late old-account response cannot reappear');
  assert.equal(store.star('pending').loading,false);
  assert.equal(accountReads,2);assert.equal(client.posts.length,0);
});

test('a disconnected Star response reconciles with current account instead of assuming it remains disconnected',async()=>{
  let accountReads=0,bookReads=0;
  const relinked={...connected,github_user:{id:'202',login:'new-github-account'}};
  const client=new Client(path=>{
    if(path==='/me/github')return accountReads++?relinked:connected;
    if(path===starPath('book'))return bookReads++?star('book',true):{book_id:'book',connected:false,starred:null};
    throw Error(`Unexpected GET ${path}`);
  });
  const store=new GitHubSocialStore(client,true);
  await store.loadAccount();await store.loadStar('book');
  assert.deepEqual(store.account.value,relinked);
  assert.equal(store.star('book').value,undefined);
  await store.loadStar('book');
  assert.equal(store.star('book').value?.starred,true);
  assert.equal(accountReads,2);assert.equal(bookReads,2);assert.equal(client.posts.length,0);
});

test('expired Star mutation restores OAuth entry and never retries the write',async()=>{
  let accountReads=0;
  const client=new Client(path=>{
    if(path==='/me/github')return accountReads++?unlinked:connected;
    if(path===starPath('book'))return star('book');
    if(path===starPath('other'))return star('other',true);
    throw Error(`Unexpected GET ${path}`);
  },path=>{
    if(path===starPath('book'))throw expired();
    if(path==='/me/github/connect')return {authorization_url:'https://github.com/login/oauth/authorize?client_id=synthetic'};
    throw Error(`Unexpected POST ${path}`);
  });
  const store=new GitHubSocialStore(client,true);
  await store.loadAccount();await store.loadStar('book');await store.loadStar('other');
  await store.toggleStar('book');
  assert.deepEqual(store.account.value,unlinked);
  assert.equal(store.star('book').saving,false);assert.equal(store.star('other').value,undefined);
  await store.toggleStar('book');
  assert.equal(client.posts.length,1);
  assert.deepEqual(client.posts[0],{path:starPath('book'),body:{starred:true,confirmed:true}});
  assert.match(await store.connect('#community'),/^https:\/\/github\.com\/login\/oauth\/authorize/);
  assert.equal(client.gets.filter(path=>path===starPath('book')).length,1);
});

test('a connection removed in another tab is reconciled on connect-required mutation failure',async()=>{
  let accountReads=0;
  const client=new Client(path=>path==='/me/github'?(accountReads++?unlinked:connected):star('book'),()=>{
    throw new ApiError({status:409,code:'github_connect_required',message:'請先連結 GitHub。'});
  });
  const store=new GitHubSocialStore(client,true);
  await store.loadAccount();await store.loadStar('book');await store.toggleStar('book');
  assert.deepEqual(store.account.value,unlinked);assert.equal(client.posts.length,1);
});

test('failed connection reload leaves an explicit recoverable error, not a fictitious linked account',async()=>{
  let accountReads=0;
  const client=new Client(path=>{
    if(path==='/me/github'){
      accountReads++;
      if(accountReads===1)return connected;
      if(accountReads===2)throw new ApiError({status:503,message:'GitHub 連結暫時無法讀取。'});
      return unlinked;
    }
    throw expired();
  });
  const store=new GitHubSocialStore(client,true);
  await store.loadAccount();await store.loadStar('book');
  assert.equal(store.account.value,undefined);assert.match(store.account.error,/暫時無法讀取/);
  assert.equal(store.account.loading,false);
  await store.loadAccount(true);
  assert.deepEqual(store.account.value,unlinked);assert.equal(store.account.error,'');
});

test('permission denial stays visible while retaining confirmed account and never silently retrying mutation',async()=>{
  const denied=new ApiError({status:403,code:'github_permission_required',message:'GitHub 尚未授予 Star 權限。'});
  const client=new Client(path=>path==='/me/github'?connected:star('book'),()=>{throw denied;});
  const store=new GitHubSocialStore(client,true);
  await store.loadAccount();await store.loadStar('book');await store.toggleStar('book');
  assert.deepEqual(store.account.value,connected);
  assert.equal(store.star('book').value?.starred,false);
  assert.equal(store.star('book').error,'目前無法透過平台替這個 Repo 按星，請前往原作 GitHub 操作。');
  assert.doesNotMatch(store.star('book').error,/github_permission_required|原作者尚未|暫時|稍後/);
  assert.equal(store.star('book').saving,false);assert.equal(client.posts.length,1);
  assert.equal(client.gets.filter(path=>path==='/me/github').length,2);
});

test('account refresh clears old Stars when the GitHub identity changes or disconnects',async()=>{
  let accountReads=0;
  const other={...connected,github_user:{id:'202',login:'another-account'}};
  const client=new Client(path=>path==='/me/github'?[connected,other,unlinked][accountReads++]:star('book',true));
  const store=new GitHubSocialStore(client,true);
  await store.loadAccount();await store.loadStar('book');
  await store.loadAccount(true);assert.equal(store.star('book').value,undefined);
  await store.loadStar('book');await store.loadAccount(true);
  assert.equal(store.star('book').value,undefined);assert.deepEqual(store.account.value,unlinked);
});

test('late successful or failed Star mutation cannot overwrite or invalidate a subsequently refreshed account',async()=>{
  for(const outcome of ['success','failure'] as const){
    let accountReads=0;
    const pending=deferred<GitHubStarState>();
    const other={...connected,github_user:{id:'202',login:'another-account'}};
    const client=new Client(path=>path==='/me/github'?(accountReads++?other:connected):star('book'),()=>pending.promise);
    const store=new GitHubSocialStore(client,true);
    await store.loadAccount();await store.loadStar('book');
    const mutation=store.toggleStar('book');
    await store.refreshConnection();
    if(outcome==='success')pending.resolve({...star('book',true),confirmed:true});else pending.reject(expired());
    await mutation;
    assert.deepEqual(store.account.value,other);
    assert.equal(store.star('book').value,undefined);assert.equal(store.star('book').saving,false);
    assert.equal(accountReads,2);assert.equal(client.gets.length,3);assert.equal(client.posts.length,1);
  }
});
