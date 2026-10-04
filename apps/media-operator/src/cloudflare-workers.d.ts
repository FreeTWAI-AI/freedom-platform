// Type-only declaration for the genuine platform module. No runtime shim or alias.
// Native workerd tests exercise the actual WorkerEntrypoint and RPC implementation.
declare module 'cloudflare:workers' {
 export abstract class WorkerEntrypoint<Env=unknown> {
  protected env:Env;
  protected ctx:import('@cloudflare/workers-types').ExecutionContext;
  constructor(ctx:import('@cloudflare/workers-types').ExecutionContext,env:Env);
 }
}
