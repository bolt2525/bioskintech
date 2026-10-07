import { handleBatch, handleFetch, handleMaintenance } from './handlers.ts';

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch {
      return Response.json({ error: 'internal_error' }, { status: 500, headers: { 'cache-control': 'no-store' } });
    }
  },
  async queue(batch, env): Promise<void> {
    await handleBatch(batch, env);
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(handleMaintenance(env));
  },
} satisfies ExportedHandler<Env, unknown>;