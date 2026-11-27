/**
 * Rendered docs by (deploy, sha256, path): first this isolate's memory, then
 * the colo's Cache API. The key names the deploy, so a renderer change in a
 * new deploy never serves an old render, and the sha means a spec edit never
 * does either. Nothing has to be purged.
 */
const MEMORY = new Map();
const MEMORY_LIMIT = 64;
const TTL_S = 7 * 24 * 3600;

export function renderCache(env, ctx, timing) {
  const deploy = env.CF_VERSION_METADATA?.id ?? "dev";
  const cache = globalThis.caches?.default ?? null;
  const keyOf = (sha, rel) => `${deploy}/${sha}/${rel}`;
  const requestOf = (key) => new Request(`https://render-cache.mdview.internal/${encodeURIComponent(key)}`);
  return {
    async get(sha, rel) {
      const key = keyOf(sha, rel);
      if (MEMORY.has(key)) {
        timing?.note("render", "memory");
        return MEMORY.get(key);
      }
      if (!cache) return null;
      try {
        const hit = await cache.match(requestOf(key));
        if (!hit) return null;
        const value = await hit.json();
        remember(key, value);
        timing?.note("render", "cache");
        return value;
      } catch {
        return null;
      }
    },
    put(sha, rel, value) {
      const key = keyOf(sha, rel);
      remember(key, value);
      timing?.note("render", "miss");
      if (!cache) return;
      const response = new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${TTL_S}` } });
      ctx.waitUntil(cache.put(requestOf(key), response).catch(() => {}));
    },
  };
}

function remember(key, value) {
  MEMORY.delete(key);
  MEMORY.set(key, value);
  if (MEMORY.size > MEMORY_LIMIT) MEMORY.delete(MEMORY.keys().next().value);
}
