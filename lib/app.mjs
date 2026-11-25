/**
 * The viewer as handle(Request) → Response.
 *
 * The Mac's Node server and the Worker's fetch handler both call this. The
 * caller passes a DocSource, the comment store, and who is asking:
 * `{ kind: "human" | "agent" | "sync", author, session? }`. Checking an
 * Access JWT is the caller's job. The Mac passes a human. A sync identity
 * has no route here (spec import is a later change) and gets 403.
 *
 * Human writes still need the page's Origin. On the Mac that is http:// plus
 * one of allowedHosts. Set publicOrigin (https://<PUBLIC_HOST>) for the
 * Worker. Every write is JSON (415) and at most 64 KiB (413).
 */
import path from "node:path";
import { sha256 } from "peanut/anchors/markdown-block";
import { listCatalog } from "./catalog.mjs";
import { validSpecKey } from "./docs.mjs";
import { renderCommentBody, renderMarkdown } from "./render.mjs";
import { docKey, isWaitingOn, renameStoredDoc, StoreError } from "./store.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const SPEC_BODY_BYTES = 512 * 1024;
const WATCH_INTERVAL_MS = 400;
const STORE_POLL_MS = 100;
const HEARTBEAT_MS = 20_000;

/** The Worker passes watchMs (the spec's 2s change feed). The Mac keeps the defaults. */
function interval(ctx, fallback) {
  const value = ctx?.watchMs;
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}
const THREAD_ROUTE = /^\/api\/comments\/(\d+)\/(messages|status|delete)$/;
const MESSAGE_DELETE_ROUTE = /^\/api\/comments\/(\d+)\/messages\/(\d+)\/delete$/;
const AGENT_THREAD = /^\/api\/agent\/threads\/(\d+)$/;
const AGENT_ACT = /^\/api\/agent\/threads\/(\d+)\/(reply|suggest-resolve)$/;
const HUMAN_STATUSES = new Set(["resolved", "open"]);
const AGENT_NAME = /^[a-z0-9 _-]{1,40}$/;
const NO_THREADS = { version: null, threads: [] };
const encoder = new TextEncoder();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const AGENT_FORBIDDEN = [
  [/^\/api\/comments\/batch\/send$/, "Agents can't send a batch."],
  [/^\/api\/comments\/batch\/discard$/, "Agents can't discard a batch."],
  [/^\/api\/comments\/\d+\/delete$/, "Agents can't delete a thread."],
  [/^\/api\/comments\/\d+\/messages\/\d+\/delete$/, "Agents can't delete a message."],
  [/^\/api\/comments\/\d+\/status$/, "Agents can't resolve or reopen a thread."],
];

class HttpError extends Error {
  constructor(status, message, asJson = false, body = null) {
    super(message);
    this.status = status;
    this.asJson = asJson;
    this.body = body;
  }
}

const bells = new WeakMap();

function typeOf(ext) {
  return TYPES[ext] ?? "application/octet-stream";
}

function json(status, value, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": TYPES[".json"], "Cache-Control": "no-store", ...extra },
  });
}

function text(status, body, type = "text/plain; charset=utf-8", extra = {}) {
  return new Response(body, { status, headers: { "Content-Type": type, "Cache-Control": "no-store", ...extra } });
}

function fail(err, url) {
  if (err instanceof HttpError) {
    if (err.body) return json(err.status, err.body);
    return err.asJson ? json(err.status, { error: err.message }) : text(err.status, err.message);
  }
  if (err instanceof StoreError) {
    const missing = url.pathname.startsWith("/api/agent/") && /^No thread #/.test(err.message);
    return json(missing ? 404 : 400, { error: err.message });
  }
  return null;
}

/**
 * Answers one request. `ctx.identity` is who the caller already authenticated.
 * `ctx.docs` is the DocSource, `ctx.store` the comment store (sync or the
 * async PeanutStore wrapper; agent routes need the async one), `ctx.assets`
 * the viewer's own files.
 */
export async function handle(request, ctx) {
  const url = new URL(request.url);
  try {
    return await dispatch(request, url, ctx);
  } catch (err) {
    const response = fail(err, url);
    if (response) return response;
    throw err;
  }
}

async function dispatch(request, url, ctx) {
  const { identity, allowedHosts } = ctx;
  const { pathname } = url;
  if (allowedHosts && !allowedHosts.has(url.host)) return text(403, "forbidden host");
  if (!identity?.kind) return pathname.startsWith("/api/") ? json(401, { error: "Sign in." }) : text(401, "Sign in.");
  if (identity.kind === "sync" || identity.kind === "admin") {
    return pathname.startsWith("/api/") ? json(403, { error: "This identity can't do that." }) : text(403, "forbidden");
  }
  if (identity.kind === "backup") {
    const specRead = (request.method === "GET" || request.method === "HEAD") && (pathname === "/api/specs" || pathname.startsWith("/api/specs/"));
    if (!specRead) return json(403, { error: "forbidden", message: "The backup token can only read specs." });
  }
  if (pathname === "/api/specs" || pathname.startsWith("/api/specs/")) return specs(request, url, ctx);

  if (request.method === "POST") {
    if (pathname.startsWith("/api/agent/")) return agentWrite(request, url, ctx);
    return humanWrite(request, pathname, ctx);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "method not allowed");
  if (pathname.startsWith("/api/agent/")) return agentRead(request, url, ctx);
  return read(request, url, ctx);
}

function doorbellFor(store, ctx) {
  let bell = bells.get(store);
  if (!bell) {
    bell = createDoorbell(store, interval(ctx, STORE_POLL_MS));
    bells.set(store, bell);
  }
  return bell;
}

/* Writes */

function pageOrigin(request, ctx) {
  let origin;
  try {
    origin = new URL(request.headers.get("origin") ?? "");
  } catch {
    throw new HttpError(403, "Writes must come from mdview's own page.", true);
  }
  const allowed = ctx.publicOrigin ? origin.origin === ctx.publicOrigin : origin.protocol === "http:" && ctx.allowedHosts?.has(origin.host);
  if (!allowed) throw new HttpError(403, "Writes must come from mdview's own page.", true);
}

function requireJson(request) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Writes must be JSON.", true);
}

async function readJson(request, max = MAX_BODY_BYTES) {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > max) throw new HttpError(413, "That request is too large.", true);
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "The request body is not JSON.", true);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, "That request is too large.", true);
    }
    chunks.push(value);
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(concat(chunks)));
  } catch {
    throw new HttpError(400, "The request body is not JSON.", true);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "The request body must be a JSON object.", true);
  }
  return body;
}

function optionalRequestId(body) {
  if (body.requestId === undefined) return undefined;
  if (typeof body.requestId !== "string" || !body.requestId.trim()) throw new HttpError(400, "A requestId must not be empty.", true);
  return body.requestId;
}

function requireRequestId(body) {
  if (typeof body.requestId !== "string" || !body.requestId.trim()) throw new HttpError(400, "A requestId is required.", true);
  return body.requestId;
}

async function humanWrite(request, pathname, ctx) {
  const { identity, store, docs } = ctx;
  if (!store) throw new HttpError(503, "Comments are off because the comment store did not open.", true);
  if (identity.kind === "agent") {
    const banned = AGENT_FORBIDDEN.find(([pattern]) => pattern.test(pathname));
    throw new HttpError(403, banned ? banned[1] : "Agents use the agent API.", true);
  }
  pageOrigin(request, ctx);
  requireJson(request);
  const body = await readJson(request);
  const author = { name: identity.author, kind: "human", session: null };
  const requestId = optionalRequestId(body);

  if (pathname === "/api/comments") {
    if (!Number.isInteger(body.blockIndex)) throw new HttpError(400, "blockIndex must be an integer.", true);
    const doc = await docs.resolve(String(body.path ?? ""));
    if (doc.error) throw new HttpError(doc.status ?? 400, doc.error ?? "Comments go on Markdown files.", true);
    if (doc.kind !== "markdown") throw new HttpError(400, "Comments go on Markdown files.", true);
    const content = await contentFor(store, docs, doc, String(body.sha ?? ""));
    if (content === null) throw new HttpError(409, "This doc changed since you opened it.", true);
    const id = await store.createThread({
      file: doc.key,
      content,
      blockIndex: body.blockIndex,
      quote: String(body.quote ?? ""),
      start: Number.isInteger(body.start) ? body.start : 0,
      body: String(body.body ?? ""),
      author,
      pending: body.pending === true,
      requestId,
    });
    return json(201, { id });
  }
  if (pathname === "/api/comments/batch/send") return json(200, { sent: await store.sendPending(author, { requestId }) });
  if (pathname === "/api/comments/batch/discard") return json(200, { discarded: await store.discardPending(author, { requestId }) });

  const messageMatch = MESSAGE_DELETE_ROUTE.exec(pathname);
  if (messageMatch) {
    const [, id, messageId] = messageMatch;
    await store.deleteMessage(id, messageId, author, { requestId });
    return json(200, { id: Number(id) });
  }

  const match = THREAD_ROUTE.exec(pathname);
  if (!match) throw new HttpError(404, "not found", true);
  const [, id, action] = match;
  const pending = body.pending === true;
  if (action === "messages") {
    await touch(store, docs, id);
    await store.reply(id, String(body.body ?? ""), author, { pending, requestId });
  } else if (action === "delete") {
    await store.deleteThread(id, author, { requestId });
  } else {
    if (!HUMAN_STATUSES.has(body.status)) throw new HttpError(400, 'status must be "resolved" or "open".', true);
    await touch(store, docs, id);
    await store.setStatus(id, body.status, author, undefined, { pending, requestId });
  }
  return json(200, { id: Number(id) });
}

function agentAuthor(identity) {
  if (typeof identity.author !== "string" || !AGENT_NAME.test(identity.author)) {
    throw new HttpError(400, "The agent name must be 1-40 characters: lowercase letters, digits, spaces, _ or -.", true);
  }
  return { name: identity.author, kind: "agent", session: identity.session ?? null };
}

async function agentWrite(request, url, ctx) {
  const { identity, store, docs } = ctx;
  if (identity.kind !== "agent") throw new HttpError(403, "That API is for agents.", true);
  if (!store) throw new HttpError(503, "Comments are off because the comment store did not open.", true);
  const author = agentAuthor(identity);
  requireJson(request);
  const body = await readJson(request);
  const requestId = requireRequestId(body);
  const { pathname } = url;

  if (pathname === "/api/agent/threads") {
    const doc = await docs.resolve(String(body.path ?? ""));
    if (doc.error) throw new HttpError(doc.status ?? 404, doc.error, true);
    if (doc.kind !== "markdown") throw new HttpError(404, "Comments go on Markdown files.", true);
    const message = requireMessage(body.message);
    if (body.line === undefined && (typeof body.quote !== "string" || !body.quote.trim())) {
      throw new HttpError(400, "Give a line or a quote.", true);
    }
    if (body.line !== undefined && !(Number.isInteger(body.line) && body.line >= 1)) {
      throw new HttpError(400, "line must be a line number.", true);
    }
    const content = await docs.readText(doc.file);
    if (content === null) throw new HttpError(404, `No such file: ${body.path}`, true);
    const id = await store.createThread({
      file: doc.key,
      content,
      line: body.line,
      quote: typeof body.quote === "string" ? body.quote : "",
      body: message,
      author,
      requestId,
    });
    return json(201, { id });
  }

  if (pathname === "/api/agent/apply") {
    if (!Array.isArray(body.actions) || !body.actions.length) throw new HttpError(400, "Give a non-empty list of actions.", true);
    const seen = new Set();
    for (const action of body.actions) {
      const id = action && (action.reply ?? action.suggestResolve);
      if (!Number.isInteger(id) || seen.has(id)) continue;
      seen.add(id);
      await touch(store, docs, id);
    }
    const result = await store.apply(body.actions, author, { requestId });
    return json(200, result);
  }

  const act = AGENT_ACT.exec(pathname);
  if (!act) throw new HttpError(404, "not found", true);
  const [, id, action] = act;
  const message = requireMessage(body.message);
  await touch(store, docs, id);
  if (action === "reply") await store.reply(id, message, author, { requestId });
  else await store.setStatus(id, "suggested", author, message, { requestId });
  return json(200, { id: Number(id) });
}

function requireMessage(value) {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "A message is required.", true);
  return value;
}

async function agentRead(request, url, ctx) {
  const { identity, store, docs } = ctx;
  if (identity.kind !== "agent") throw new HttpError(403, "That API is for agents.", true);
  agentAuthor(identity);
  if (!store) throw new HttpError(503, "Comments are off because the comment store did not open.", true);
  const { pathname } = url;

  const one = AGENT_THREAD.exec(pathname);
  if (one) {
    const key = await store.docOf(one[1]);
    await seen(store, docs, key);
    return json(200, present(docs, await store.thread(one[1])));
  }
  if (pathname === "/api/agent/threads") return json(200, { threads: await listThreads(url, store, docs) });
  if (pathname === "/api/agent/wait") return waitForThreads(request, url, store, docs, ctx);
  throw new HttpError(404, "not found", true);
}

async function listThreads(url, store, docs) {
  const scopes = url.searchParams.getAll("scope").map((scope) => scope.trim()).filter(Boolean);
  if (!scopes.length) throw new HttpError(400, "Give a scope.", true);
  const waitingOn = url.searchParams.get("waitingOn");
  if (waitingOn !== null && waitingOn !== "agent" && waitingOn !== "human") {
    throw new HttpError(400, 'waitingOn must be "agent" or "human".', true);
  }
  const all = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
  const items = await collect(store, docs, scopes);
  return items.filter((item) => (all || item.thread.status !== "resolved") && (!waitingOn || isWaitingOn(item.thread, waitingOn)));
}

async function collect(store, docs, scopes) {
  const items = [];
  const seenIds = new Set();
  for (const scope of scopes) {
    const resolved = await docs.scope(scope);
    if (resolved.error) throw new HttpError(resolved.status ?? 400, resolved.error, true);
    const keys = resolved.kind === "file" ? [resolved.key] : await store.keysUnder(resolved.prefix);
    for (const key of keys) {
      await seen(store, docs, key);
      const result = await store.threadsAt(key);
      if (!result) continue;
      for (const thread of result.threads) {
        if (seenIds.has(thread.id)) continue;
        seenIds.add(thread.id);
        items.push(present(docs, { doc: key, version: result.version, thread }));
      }
    }
  }
  return items;
}

async function waitForThreads(request, url, store, docs, ctx) {
  const rawTimeout = url.searchParams.get("timeout");
  if (rawTimeout === null || !/^\d+$/.test(rawTimeout) || Number(rawTimeout) > 55) {
    throw new HttpError(400, "timeout must be a whole number of seconds, at most 55.", true);
  }
  const rawAfter = url.searchParams.get("after") ?? "0";
  if (!/^\d+$/.test(rawAfter)) throw new HttpError(400, "after must be a message id.", true);
  const scopes = url.searchParams.getAll("scope").map((scope) => scope.trim()).filter(Boolean);
  if (!scopes.length) throw new HttpError(400, "Give a scope.", true);
  const timeout = Number(rawTimeout);
  const after = Number(rawAfter);
  const filter = await scopeFilter(docs, scopes);

  const found = async () => {
    const ids = await store.waitingOnAgent({ ...filter, after });
    if (!ids.length) return null;
    const items = [];
    for (const id of ids) {
      await seen(store, docs, await store.docOf(id));
      items.push(present(docs, await store.thread(id)));
    }
    return items;
  };

  let threads = await found();
  if (!threads && timeout > 0) {
    await waitForChange(store, timeout * 1000, request.signal, interval(ctx, STORE_POLL_MS));
    if (!request.signal.aborted) threads = await found();
  }
  if (!threads) return new Response(null, { status: 204 });
  return json(200, { threads });
}

async function scopeFilter(docs, scopes) {
  const files = [];
  const folders = [];
  for (const scope of scopes) {
    const resolved = await docs.scope(scope);
    if (resolved.error) throw new HttpError(resolved.status ?? 400, resolved.error, true);
    if (resolved.kind === "file") files.push(resolved.key);
    else folders.push(resolved.key);
  }
  return { files, folders };
}

function present(docs, found) {
  return {
    document: docs.displayPath(found.doc),
    revision: { seq: found.version.seq, sha256: found.version.sha256, latestSeq: found.version.latestSeq },
    thread: found.thread,
  };
}

function waitForChange(store, ms, signal, pollMs = STORE_POLL_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let token;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      stop();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const stop = store.onWrite(() => finish());
    const poll = setInterval(() => {
      Promise.resolve()
        .then(() => store.changeToken())
        .then((next) => {
          if (token === undefined) token = next;
          else if (next !== token) finish();
        })
        .catch(() => {});
    }, pollMs);
    const timer = setTimeout(finish, ms);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
    Promise.resolve()
      .then(() => store.changeToken())
      .then((value) => {
        if (token === undefined) token = value;
      })
      .catch(() => {});
  });
}

/* Reads */

async function read(request, url, ctx) {
  const { docs, store, assets, identity, initial } = ctx;
  const { pathname } = url;
  if (pathname === "/") {
    const target = "/view/" + String(initial ?? "").split("/").map(encodeURIComponent).join("/");
    return new Response(null, { status: 302, headers: { Location: target } });
  }
  if (pathname === "/manifest.webmanifest") {
    const manifest = await assets.manifest();
    return manifest ? fileResponse(manifest, { "Content-Type": "application/manifest+json; charset=utf-8" }) : text(404, "not found");
  }
  if (pathname === "/sw.js") {
    const worker = await assets.worker();
    return worker ? fileResponse(worker) : text(404, "not found");
  }
  if (pathname === "/view" || pathname.startsWith("/view/") || pathname === "/inbox") {
    const page = await assets.page();
    if (!page) return text(404, "not found");
    return fileResponse(page, { "Content-Security-Policy": pagePolicy(url) });
  }
  if (pathname === "/static/style.css") return text(200, await assets.styles(), TYPES[".css"]);
  if (pathname === "/static/js/vendor/mermaid.min.js") {
    const script = await assets.mermaid();
    return script ? fileResponse(script) : text(404, "not found");
  }
  if (pathname.startsWith("/static/hljs/")) {
    const opened = await assets.hljs(pathname.slice("/static/hljs/".length));
    return opened ? fileResponse(opened) : text(404, "not found");
  }
  if (pathname.startsWith("/static/")) {
    const opened = await assets.file(decodePathname(pathname, "/static/"));
    return opened ? fileResponse(opened) : text(404, "not found");
  }
  if (pathname.startsWith("/raw/")) {
    const abs = docs.resolveRaw(decodePathname(pathname, "/raw/"));
    if (!abs) return text(403, "outside root");
    const opened = await docs.openRaw(abs);
    if (!opened) return text(404, "not found");
    const headers = { "X-Content-Type-Options": "nosniff" };
    if (opened.ext !== ".pdf") headers["Content-Security-Policy"] = "sandbox";
    return fileResponse(opened, headers);
  }
  if (pathname === "/api/info") {
    return json(200, {
      root: docs.root,
      rootName: path.basename(docs.root),
      initial,
      comments: Boolean(store),
      user: store && identity.kind === "human" ? identity.author : null,
    });
  }
  if (pathname === "/api/tree") {
    const files = await docs.listMarkdown();
    return json(200, { files, waiting: await waitingCounts(docs, store, files) });
  }
  if (pathname === "/api/docs") return json(200, await listCatalog(docs.root));
  if (pathname === "/api/doc") return docResponse(url, docs, store);
  if (pathname === "/api/comments") return commentsResponse(url, docs, store);
  if (pathname === "/api/inbox") return json(200, await inbox(docs, store));
  if (pathname === "/api/store-events") {
    if (!store) return text(404, "comments are off");
    return streamStoreEvents(request, doorbellFor(store, ctx));
  }
  if (pathname === "/api/versions") {
    const doc = await docs.resolve(url.searchParams.get("path") ?? "");
    if (doc.error) return json(doc.status, { error: doc.error });
    return json(200, { versions: doc.kind === "markdown" && store ? await store.versions(doc.key) : [] });
  }
  if (pathname === "/api/events") {
    const doc = await docs.resolve(url.searchParams.get("path") ?? "");
    if (doc.kind !== "markdown") return text(404, "not found");
    return streamChanges(request, docs, doc, store, interval(ctx, WATCH_INTERVAL_MS));
  }
  return text(404, "not found");
}

async function docResponse(url, docs, store) {
  const doc = await docs.resolve(url.searchParams.get("path") ?? "");
  if (doc.error) return json(doc.status, { error: doc.error });
  if (doc.kind === "raw") return json(200, { raw: doc.rel });
  const seq = url.searchParams.get("v");
  if (seq) {
    await observeQuietly(store, docs, doc);
    const stored = await store?.versionAt(doc.key, Number(seq));
    if (!stored) return json(404, { error: `No version ${seq} of this doc is stored.` });
    return json(200, {
      path: doc.rel,
      abs: doc.abs,
      mtimeMs: Date.parse(stored.observedAt),
      sha: stored.sha256,
      version: { seq: stored.seq, latestSeq: stored.latestSeq },
      old: stored.seq !== stored.latestSeq,
      ...renderMarkdown(stored.content, doc.rel),
    });
  }
  const [src, mtimeMs] = await Promise.all([docs.readText(doc.file), docs.mtimeMs(doc.file)]);
  if (src === null) throw new Error(`could not read ${doc.rel}`);
  const version = await observeQuietly(store, docs, doc, src);
  return json(200, {
    path: doc.rel,
    abs: doc.abs,
    mtimeMs,
    sha: sha256(src),
    version: version && { seq: version.seq },
    ...renderMarkdown(src, doc.rel),
  });
}

async function commentsResponse(url, docs, store) {
  if (!store) return json(200, NO_THREADS);
  const doc = await docs.resolve(url.searchParams.get("path") ?? "");
  if (doc.error) return json(doc.status, { error: doc.error });
  const pendingCount = await store.pendingCount();
  if (doc.kind !== "markdown") return json(200, { ...NO_THREADS, pendingCount });
  const result = await store.threadsAt(doc.key, { sha: url.searchParams.get("sha") || undefined, includePending: true });
  return json(200, result ? { ...withBodyHtml(result), pendingCount } : { ...NO_THREADS, pendingCount });
}

/** The content with hash `sha`: a stored version, or the file itself when it still matches. */
async function contentFor(store, docs, doc, sha) {
  const stored = await store.contentForSha(doc.key, sha);
  if (stored !== null) return stored;
  const current = await docs.readText(doc.file);
  return current !== null && sha256(current) === sha ? current : null;
}

async function observeQuietly(store, docs, doc, content) {
  if (!store) return null;
  try {
    const text = content === undefined ? await docs.readText(doc.file) : content;
    return (await store.observe(doc.key, text))?.version ?? null;
  } catch (err) {
    console.error(`mdview: could not record a version of ${doc.key}: ${err.message}`);
    return null;
  }
}

/** Records the doc as it reads now, so a message names the version its author saw. */
async function touch(store, docs, threadId) {
  await seen(store, docs, await store.docOf(threadId));
}

async function seen(store, docs, key) {
  const content = await docs.readText(key);
  if (content !== null) await store.observe(key, content);
}

function withBodyHtml(result) {
  return {
    ...result,
    threads: result.threads.map((t) => ({
      ...t,
      messages: t.messages.map((m) => ({ ...m, bodyHtml: renderCommentBody(m.body) })),
    })),
  };
}

/**
 * The viewer page's Content-Security-Policy. Docs render their raw HTML, so
 * without it a handler in any doc would run as mdview's own page.
 */
function pagePolicy(url) {
  return [
    "default-src 'self'",
    `script-src ${url.protocol}//${url.host}/static/js/`,
    "style-src 'self' 'unsafe-inline'",
    "img-src * data: blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Threads waiting on the human, keyed by the path the file list shows, including through a symlink. */
async function waitingCounts(docs, store, files) {
  if (!store?.waitingOnHumanCountsIn) return {};
  const paths = new Map(files.map((rel) => [docKey(path.join(docs.root, rel)), rel]));
  const counts = await store.waitingOnHumanCountsIn(paths.keys());
  return Object.fromEntries([...counts].map(([key, n]) => [paths.get(key), n]));
}

async function inbox(docs, store) {
  if (!store?.waitingOnHumanIn) return { docs: [] };
  const files = await docs.listMarkdown();
  const paths = new Map(files.map((rel) => [docKey(path.join(docs.root, rel)), rel]));
  const groups = await store.waitingOnHumanIn(paths.keys());
  return {
    docs: groups.map(({ doc, threads }) => ({
      path: paths.get(doc),
      threads: threads.map((t) => {
        const last = t.messages.at(-1);
        return {
          id: t.id,
          status: t.status,
          state: t.state,
          quote: t.quote,
          heading: t.heading,
          lines: t.lines,
          messages: t.messages.length,
          last: last && { author: last.author, authorKind: last.authorKind, body: last.body, createdAt: last.createdAt },
        };
      }),
    })),
  };
}

const SPEC_REV = /^\/api\/specs\/(.+)\/revisions\/([0-9a-f]{64})$/;
const SPEC_REVS = /^\/api\/specs\/(.+)\/revisions$/;
const SPEC_MOVE = /^\/api\/specs\/(.+)\/move$/;
const SPEC_ONE = /^\/api\/specs\/(.+)$/;

function specPath(captured) {
  return captured.split("/").map((part) => decodeURIComponent(part)).join("/");
}

function quotedEtag(hash) {
  return `"${hash}"`;
}

function matchSha(header) {
  if (header == null || !String(header).trim()) return null;
  const trimmed = String(header).trim();
  const match = /^(?:W\/)?"?([0-9a-f]{64})"?$/i.exec(trimmed);
  return match ? match[1] : trimmed;
}

function specFail(outcome) {
  throw new HttpError(outcome.status, outcome.message, true, {
    error: outcome.error,
    message: outcome.message,
    ...(outcome.current ? { current: outcome.current } : {}),
  });
}

async function runOnce(store, requestId, fn) {
  if (typeof store?.once === "function") return store.once(requestId, fn);
  return fn(null);
}

async function rememberSpec(store, docs, key) {
  if (!store) return;
  const current = docs.readSpec(key);
  if (current) await store.observe(current.storeKey, current.content);
}

async function specs(request, url, ctx) {
  const { identity, docs, store } = ctx;
  const { pathname } = url;
  const reading = request.method === "GET" || request.method === "HEAD";
  if (!reading && identity.kind === "human") pageOrigin(request, ctx);
  if (!reading && identity.kind === "agent") agentAuthor(identity);
  if (!reading && identity.kind !== "human" && identity.kind !== "agent") {
    throw new HttpError(403, "This identity can't edit specs.", true, { error: "forbidden", message: "This identity can't edit specs." });
  }

  if (reading && pathname === "/api/specs") {
    const since = url.searchParams.get("since");
    if (since && Number.isNaN(Date.parse(since))) throw new HttpError(400, "since must be an ISO time.", true, { error: "bad_request", message: "since must be an ISO time." });
    const project = url.searchParams.get("project") || undefined;
    const prefix = url.searchParams.get("prefix") || undefined;
    return json(200, { specs: await docs.listSpecs({ project, prefix, since: since || undefined }) });
  }

  const revision = SPEC_REV.exec(pathname);
  if (reading && revision) {
    const key = specPath(revision[1]);
    if (!validSpecKey(key)) throw new HttpError(400, "That is not a spec key.", true, { error: "bad_key", message: "That is not a spec key." });
    const text = docs.revisionText(key, revision[2]);
    if (text == null) return json(404, { error: "not_found", message: text === null ? `No spec ${key}.` : `No revision ${revision[2]}.` });
    return new Response(text, { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", ETag: quotedEtag(revision[2]), "Cache-Control": "no-store" } });
  }
  const revisions = SPEC_REVS.exec(pathname);
  if (reading && revisions) {
    const key = specPath(revisions[1]);
    if (!validSpecKey(key)) throw new HttpError(400, "That is not a spec key.", true, { error: "bad_key", message: "That is not a spec key." });
    const list = docs.revisionsOf(key);
    if (!list) return json(404, { error: "not_found", message: `No spec ${key}.` });
    return json(200, { revisions: list });
  }
  const one = SPEC_ONE.exec(pathname);
  if (reading && one) {
    const key = specPath(one[1]);
    if (!validSpecKey(key)) throw new HttpError(400, "That is not a spec key.", true, { error: "bad_key", message: "That is not a spec key." });
    const current = docs.readSpec(key);
    if (!current) return json(404, { error: "not_found", message: `No spec ${key}.` });
    const tag = quotedEtag(current.sha256);
    const none = matchSha(request.headers.get("if-none-match"));
    if (none && none === current.sha256) return new Response(null, { status: 304, headers: { ETag: tag } });
    return new Response(current.content, { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", ETag: tag, "Cache-Control": "no-store" } });
  }

  if (!store) throw new HttpError(503, "Comments are off because the comment store did not open.", true);
  requireJson(request);
  const body = await readJson(request, SPEC_BODY_BYTES);
  const requestId = requireRequestId(body);
  const at = new Date().toISOString();
  const by = identity.author;

  if (request.method === "POST" && pathname === "/api/specs") {
    if (!validSpecKey(body.key)) throw new HttpError(400, "That is not a spec key.", true, { error: "bad_key", message: "That is not a spec key." });
    if (typeof body.content !== "string") throw new HttpError(400, "content must be a string.", true, { error: "bad_request", message: "content must be a string." });
    const outcome = await runOnce(store, requestId, () => {
      const created = docs.createSync({ key: body.key, content: body.content, by, at });
      if (created.status !== 201) specFail(created);
      return { ...created, key: body.key };
    });
    await rememberSpec(store, docs, outcome.key);
    return json(201, { key: outcome.key, sha256: outcome.sha256 }, { ETag: quotedEtag(outcome.sha256) });
  }

  const move = SPEC_MOVE.exec(pathname);
  if (request.method === "POST" && move) {
    const from = specPath(move[1]);
    if (!validSpecKey(from) || !validSpecKey(body.to)) {
      throw new HttpError(400, "That is not a spec key.", true, { error: "bad_key", message: "That is not a spec key." });
    }
    const ifMatch = matchSha(request.headers.get("if-match"));
    const outcome = await runOnce(store, requestId, (db) => {
      const moved = docs.moveSync({ from, to: body.to, ifMatch });
      if (moved.status !== 200) specFail(moved);
      try {
        renameStoredDoc(db, moved.fromKey, moved.toKey);
      } catch (err) {
        docs.moveSync({ from: body.to, to: from, ifMatch: moved.sha256 });
        if (err instanceof StoreError) specFail({ status: 409, error: "exists", message: err.message });
        throw err;
      }
      return { status: 200, key: body.to, sha256: moved.sha256 };
    });
    return json(200, { key: outcome.key }, { ETag: quotedEtag(outcome.sha256) });
  }

  if (request.method === "PUT" && one) {
    const key = specPath(one[1]);
    if (!validSpecKey(key)) throw new HttpError(400, "That is not a spec key.", true, { error: "bad_key", message: "That is not a spec key." });
    if (typeof body.content !== "string") throw new HttpError(400, "content must be a string.", true, { error: "bad_request", message: "content must be a string." });
    const ifMatch = matchSha(request.headers.get("if-match"));
    const outcome = await runOnce(store, requestId, () => {
      const saved = docs.putSync({ key, content: body.content, ifMatch, by, at });
      if (saved.status !== 200) specFail(saved);
      return saved;
    });
    await rememberSpec(store, docs, key);
    return json(200, { sha256: outcome.sha256 }, { ETag: quotedEtag(outcome.sha256) });
  }

  return json(404, { error: "not_found", message: "not found" });
}

function fileResponse(opened, extra = {}) {
  return new Response(opened.body, {
    status: 200,
    headers: {
      "Content-Type": typeOf(opened.ext),
      "Content-Length": String(opened.size),
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

function decodePathname(pathname, prefix) {
  return pathname
    .slice(prefix.length)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

function concat(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/* Live updates */

function tokenNow(store) {
  if (!store) return null;
  try {
    return store.changeToken();
  } catch {
    return null;
  }
}

/**
 * Rings every listener when the store changes: right after this process's own
 * writes, and within STORE_POLL_MS of another process's, which SQLite reports
 * through the change token. It polls only while someone is listening.
 */
function createDoorbell(store, pollMs) {
  const listeners = new Set();
  let token = null;
  let timer = null;
  const ring = () => {
    const value = tokenNow(store);
    const notify = (next) => {
      token = next;
      for (const listener of listeners) listener();
    };
    if (value && typeof value.then === "function") value.then(notify, () => {});
    else notify(value);
  };
  store.onWrite(ring);
  return {
    listen(listener) {
      listeners.add(listener);
      if (!timer) {
        const value = tokenNow(store);
        if (value && typeof value.then === "function") value.then((next) => { token = next; }, () => {});
        else token = value;
        timer = setInterval(() => {
          const value = tokenNow(store);
          const check = (next) => {
            if (next !== token) ring();
          };
          if (value && typeof value.then === "function") value.then(check, () => {});
          else check(value);
        }, pollMs);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

function sse(request, setup) {
  let stop = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let stopped = false;
      const write = (chunk) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* the client has gone */
        }
      };
      const halt = () => {
        if (stopped) return;
        stopped = true;
        stop();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      stop = setup(write) ?? (() => {});
      if (request.signal.aborted) halt();
      else request.signal.addEventListener("abort", halt, { once: true });
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
  });
}

function streamStoreEvents(request, doorbell) {
  return sse(request, (write) => {
    write("retry: 1500\n\n");
    const stopListen = doorbell.listen(() => write("event: change\ndata: \n\n"));
    const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
    return () => {
      stopListen();
      clearInterval(heartbeat);
    };
  });
}

async function streamChanges(request, docs, doc, store, pollMs) {
  const last = await docs.mtimeMs(doc.file);
  let lastToken = await Promise.resolve(tokenNow(store));
  return sse(request, (write) => {
    write("retry: 1500\n\n");
    let checking = false;
    let current = last;
    const watch = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const now = await docs.mtimeMs(doc.file);
        if (now !== current && now !== null) write(`event: change\ndata: ${now}\n\n`);
        current = now;
        const token = await Promise.resolve(tokenNow(store));
        if (token !== lastToken) {
          lastToken = token;
          write("event: comments\ndata: \n\n");
        }
      } finally {
        checking = false;
      }
    }, pollMs);
    const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
    return () => {
      clearInterval(watch);
      clearInterval(heartbeat);
    };
  });
}
