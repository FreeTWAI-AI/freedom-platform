import type {PoolClient} from 'pg';
import {z} from 'zod';
import {Problem} from '../../packages/shared/problem.js';

/** Read-only search, one authorized conversation; never an all-inbox search. */
export const MessageSearchQuery=z.object({
  q:z.string().trim().min(1).max(100),
  limit:z.coerce.number().int().min(1).max(50).default(20),
  cursor:z.uuid().transform(value=>value.toLowerCase()).optional(),
}).strict();
export type MessageSearchPage<T>={items:T[];next_cursor:string|null};
/** SQL parameters keep input literal, including LIKE's own wildcard characters. */
export const messageSearchPattern=(query:string)=>`%${query.replace(/[\\%_]/g,char=>'\\'+char)}%`;

/** Reuse pair/room indexes, with a per-statement bound on a large old history.
 * SET LOCAL ends with this read snapshot; it never changes the pooled session. */
export async function boundedMessageSearch<T>(q:PoolClient,run:()=>Promise<T>):Promise<T>{
  await q.query("SET LOCAL statement_timeout='1500ms'");
  try{return await run();}
  catch(cause){
    if((cause as {code?:string}).code==='57014')throw new Problem(503,'message_search_busy','搜尋暫時忙碌，請換個關鍵字或稍後重試。');
    throw cause;
  }
}
