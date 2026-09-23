import {randomUUID} from 'node:crypto';
import type {MiddlewareHandler} from 'hono';

export type OnboardingDiagnostic={
  event:'onboarding_request';request_id:string;cf_ray:string|null;
  stage:'answers'|'evaluate'|'complete';status:number;elapsed_ms:number;
};

/** Transport evidence only: never log identities, answers, headers or payloads. */
export function onboardingDiagnostics(emit:(entry:OnboardingDiagnostic)=>void=entry=>console.info(JSON.stringify(entry))):MiddlewareHandler{
  return async(c,next)=>{
    const match=/^\/api\/v1\/me\/onboarding\/(answers|evaluate|complete)$/.exec(c.req.path);
    if(c.req.method!=='POST'||!match)return next();
    const requestId=randomUUID(),started=performance.now(),ray=c.req.header('CF-Ray')??'';
    const cfRay=/^[a-f0-9]{16}-[A-Z0-9]{3,5}$/.test(ray)?ray:null;
    c.header('X-Freedom-Request-ID',requestId);
    try{await next();}
    finally{
      // A broken log destination must not turn a committed save into an error.
      try{emit({event:'onboarding_request',request_id:requestId,cf_ray:cfRay,stage:match[1] as OnboardingDiagnostic['stage'],status:c.res.status,elapsed_ms:Math.max(0,Math.round(performance.now()-started))});}catch{}
    }
  };
}
