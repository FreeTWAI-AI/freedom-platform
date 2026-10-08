import {useCallback,useLayoutEffect,useRef,useState,type DependencyList} from 'react';
import './LocalAction.css';

type Result<T>={status:'done';value:T}|{status:'failed';error:unknown}|{status:'busy'|'stale'};

/** One unresolved browser capability per caller; owner changes suppress its late UI result.
 * Calls the capability directly before awaiting, retaining the click's user activation.
 * Clipboard/system-share operations cannot be aborted; they remain locked until ACK. */
export function useLocalAction(owner:DependencyList){
  const [pending,setPending]=useState<string|null>(null);
  const active=useRef<symbol|null>(null),epoch=useRef(0),mounted=useRef(false);
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
  useLayoutEffect(()=>{epoch.current++;},owner);
  const run=useCallback(async<T,>(key:string,operation:()=>Promise<T>):Promise<Result<T>>=>{
    if(active.current!==null||!mounted.current)return {status:'busy'};
    const token=Symbol(),generation=epoch.current;active.current=token;setPending(key);
    try{
      const value=await operation();
      return mounted.current&&generation===epoch.current?{status:'done',value}:{status:'stale'};
    }catch(error){
      return mounted.current&&generation===epoch.current?{status:'failed',error}:{status:'stale'};
    }finally{
      if(active.current===token){active.current=null;if(mounted.current)setPending(null);}
    }
  },[]);
  return {pending,run};
}
