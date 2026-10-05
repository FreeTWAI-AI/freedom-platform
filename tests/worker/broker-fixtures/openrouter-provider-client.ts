import { exchange } from '../../../apps/credential-broker/src/worker-provider-transport.js';
export default { async fetch(request: Request) {
  const input = await request.json() as { url: string; method: 'GET' | 'POST' };
  try {
    const result = await exchange(new URL(input.url), input.method, { Authorization: 'Bearer SYNTHETIC_OPENROUTER_WORKER_ONLY' },
      input.method === 'POST' ? new TextEncoder().encode(JSON.stringify({ model: 'openai/synthetic', max_completion_tokens: 8, stream: false, tools: [], tool_choice: 'none', provider: { allow_fallbacks: false } })) : undefined);
    return Response.json({ status: result.status, body: new TextDecoder().decode(result.body) });
  } catch (error) { return Response.json({ code: (error as { code?: string }).code ?? 'unavailable' }, { status: 503 }); }
} };
