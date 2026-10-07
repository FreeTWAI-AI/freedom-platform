import { parse } from 'hono/utils/cookie';
import { requireCondition } from '../../../packages/shared/problem.js';

/** Origin is trusted host configuration, never a request header. */
export function sessionCookieName(origin:string) {
  return new URL(origin).protocol==='https:'?'__Host-freedom_session':'freedom_local_session';
}

export function readSessionCookie(header:string|undefined,origin:string):string|undefined {
  const name=sessionCookieName(origin),cookies=header??'';
  let matches=0;
  for(const pair of cookies.split(';')) {
    const equals=pair.indexOf('=');
    if(equals!==-1&&pair.slice(0,equals).trim()===name)matches++;
  }
  requireCondition(matches<=1,403,'credential_kind_rejected','登入 Cookie 不明確，請清除本站 Cookie 後重新登入。');
  return parse(cookies,name)[name];
}
