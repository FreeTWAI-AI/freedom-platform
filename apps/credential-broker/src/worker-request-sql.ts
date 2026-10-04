import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool} from 'pg';
/** Opaque evidence stays isolate-local; sockets/clients always belong to request. */
export function brokerRequestSql(){
  const context=new AsyncLocalStorage<{cipher:Pool;executor:Pool}>();
  function port(kind:'cipher'|'executor'):Pool{
    return Object.freeze({query(...args:unknown[]){const pool=context.getStore()?.[kind];if(!pool)throw new Error('broker_request_unavailable');return (pool.query as Function).apply(pool,args);},
      connect(...args:unknown[]){const pool=context.getStore()?.[kind];if(!pool)throw new Error('broker_request_unavailable');return (pool.connect as Function).apply(pool,args);}}) as unknown as Pool;
  }
  return Object.freeze({cipher:port('cipher'),executor:port('executor'),run<T>(pools:{cipher:Pool;executor:Pool},operation:()=>Promise<T>){return context.run(pools,operation);}});
}
