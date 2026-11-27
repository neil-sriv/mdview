/**
 * specs.neilsriv.tech. Access is checked here; handle() is the same viewer
 * the Mac runs. The change feed polls changeToken every 2s, which is also
 * how long an agent wait waits between checks: both are RPCs into the one
 * store object, and onWrite cannot cross that boundary.
 */
import { handle } from "../lib/app.mjs";
import { identify } from "./access.js";
import { AssetSource, IMMUTABLE } from "./assets.js";
import { deliverOutbox } from "./deliver.js";
import { R2DocSource } from "./docs.js";
import { renderCache } from "./render-cache.js";
import { pruneRequests, remoteStore } from "./store.js";
import { Timing } from "./timing.js";

export { PeanutStore } from "./store.js";

const WATCH_MS = 2000;

export default {
  async fetch(request, env, ctx) {
    const auth = await identify(request, env);
    if (auth.response) return auth.response;
    const url = new URL(request.url);
    const assets = new AssetSource(env.ASSETS);
    // The hashed build normally never reaches the Worker (run_worker_first skips
    // /static/build/*). When it does, answer it the way the asset store would.
    if (url.pathname.startsWith("/static/build/") && (request.method === "GET" || request.method === "HEAD")) {
      const built = await assets.built(url.pathname);
      if (built) {
        const headers = new Headers(built.headers);
        headers.set("Cache-Control", IMMUTABLE);
        return new Response(request.method === "HEAD" ? null : built.body, { status: 200, headers });
      }
    }
    const started = Date.now();
    const timing = url.pathname.startsWith("/api/") ? new Timing() : null;
    const docs = new R2DocSource(timing ? timing.wrap(env.BUCKET, "r2") : env.BUCKET);
    const store = timing ? timing.wrap(remoteStore(env), "store") : remoteStore(env);
    let response = await handle(request, {
      docs,
      assets,
      store,
      renders: renderCache(env, ctx, timing),
      identity: auth.identity,
      initial: url.pathname === "/" || url.pathname === "/api/info" ? await docs.initial() : "",
      allowedHosts: null,
      publicOrigin: `https://${env.PUBLIC_HOST}`,
      watchMs: WATCH_MS,
    });
    if (request.method === "POST" && auth.identity.kind === "human" && response.ok) ctx.waitUntil(deliverOutbox(env));
    if (timing && !(response.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
      response = new Response(response.body, response);
      response.headers.set("Server-Timing", timing.header(Date.now() - started));
    }
    return response;
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(controller.cron === "17 3 * * *" ? pruneRequests(env) : deliverOutbox(env));
  },
};
