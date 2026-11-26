/**
 * Offline cache for the installed app.
 *
 * The shell (HTML, JS, CSS, and whatever those files point at under /static/,
 * including a mermaid build or a font added later) is crawled from /view/.
 * Docs come from /api/docs: each entry's etag is its content hash, so a poll
 * refetches only the files that changed, plus their rendered /api/doc page and
 * same-origin images at or under the catalog's byte cap.
 *
 * Online, a request goes to the network and refreshes the cache. A connect that
 * never answers (the phone can still resolve the Mac over Tailscale) is given
 * up after NETWORK_MS, and a 5xx from the proxy is treated the same way: the
 * cached copy is served and the page is told when it was saved. One timed-out
 * attempt is left running so a late response can still refresh the cache; the
 * one before it is aborted, and the sync crawl aborts too, so a dead connect
 * cannot hold the phone's whole connection pool. Event streams are left alone
 * so live reload fails and retries on its own, and /sw.js is never cached so
 * the browser can update this script.
 */

const SHELL = "mdview-shell";
const DOCS = "mdview-docs";
const FALLBACK_IMAGE_BYTES = 2 * 1024 * 1024;
const SHELL_LIMIT = 400;
const FETCH_LIMIT = 6;
const NETWORK_MS = 3000;

const READ_APIS = new Set(["/api/doc", "/api/docs", "/api/tree", "/api/info", "/api/inbox"]);

let syncing = null;
let imageCap = FALLBACK_IMAGE_BYTES;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "sync") event.waitUntil(syncAll());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw.js" || url.pathname === "/api/events" || url.pathname === "/api/store-events") return;

  const nav = request.mode === "navigate" && isAppPath(url.pathname);
  const shell = nav || url.pathname.startsWith("/static/") || url.pathname === "/manifest.webmanifest";
  const api = READ_APIS.has(url.pathname);
  const raw = url.pathname.startsWith("/raw/");
  if (!shell && !api && !raw) return;
  event.respondWith(networkFirst(event, url, { nav, shell, api, raw }));
});

function isAppPath(pathname) {
  return pathname === "/" || pathname === "/inbox" || pathname === "/view" || pathname.startsWith("/view/");
}

function signals(url, nav) {
  return nav || url.pathname === "/api/doc" || url.pathname === "/api/info" || url.pathname === "/api/tree";
}

/** A proxy in front of a stopped mdview answers 502/503/504. Any 5xx is that case. */
function isGateway(status) {
  return status >= 500 && status <= 599;
}

/**
 * Races `request` against `ms`. On timeout the fetch is still running: its
 * controller aborts it only when a newer attempt takes the one late-refresh slot.
 */
function fetchRace(request, ms) {
  const controller = new AbortController();
  const network = fetch(request, { signal: controller.signal });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([
    network.then((response) => ({ response })).catch((error) => ({ error })),
    timeout,
  ]).then((outcome) => {
    if (outcome !== "timeout") clearTimeout(timer);
    return outcome === "timeout" ? { timeout: true, controller, network } : outcome;
  });
}

/** Aborts at `ms`, so the sync crawl cannot sit on a dead Tailscale connect. */
function fetchWithin(resource, ms = NETWORK_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(resource, { signal: controller.signal, cache: "no-store" }).finally(() => clearTimeout(timer));
}

// The single timed-out page fetch still allowed to finish and refresh the cache.
let lateRefresh = null;

function adoptLate(controller, network, onOk) {
  lateRefresh?.abort();
  lateRefresh = controller;
  return network
    .then(async (late) => {
      if (lateRefresh === controller) lateRefresh = null;
      await onOk(late);
    })
    .catch(() => {
      if (lateRefresh === controller) lateRefresh = null;
    });
}

function cancelLate() {
  lateRefresh?.abort();
  lateRefresh = null;
}

async function refreshCached(request, cache, kind) {
  try {
    const fresh = await fetchWithin(request);
    if (!fresh.ok || isGateway(fresh.status)) return;
    if (kind.raw) await cacheImage(cache, request, fresh);
    else await putStamped(cache, request, fresh);
  } catch {
    // The saved copy stays. The attempt aborts at NETWORK_MS, so it does not sit on the socket.
  }
}

async function networkFirst(event, url, kind) {
  const cache = await caches.open(kind.shell ? SHELL : DOCS);
  // Shell files and images are already on the phone after the first save. Hand them over
  // at once and revalidate behind the page; a navigation or a read API waits up to NETWORK_MS
  // so an awake Mac still wins, then falls back.
  if (!kind.nav && !kind.api) {
    const cached = await cache.match(event.request.url);
    if (cached) {
      const pending = refreshCached(event.request, cache, kind);
      try {
        event.waitUntil(pending);
      } catch {
        // The page already has the saved copy.
      }
      return cached;
    }
  }
  const outcome = await fetchRace(event.request, NETWORK_MS);

  if (outcome.response?.ok) {
    cancelLate();
    const fresh = outcome.response;
    const saved = fresh.clone();
    const shell = kind.nav ? fresh.clone() : null;
    // Hand the page its response now; write the cache behind it. waitUntil can throw
    // once the fetch handler has returned, and that must not turn into an offline miss.
    try {
      event.waitUntil((async () => {
        if (kind.raw) await cacheImage(cache, event.request, saved);
        else await putStamped(cache, event.request, saved);
        if (shell) await putStamped(cache, "/view/", shell);
      })());
    } catch {
      // The next sync writes anything this request did not.
    }
    if (signals(url, kind.nav)) void tell(event.clientId, { type: "online" });
    return fresh;
  }

  // A real 404 or 403 is the server talking. A 5xx, a hang, or a dropped connect is not.
  if (outcome.response && !isGateway(outcome.response.status)) return outcome.response;
  outcome.response?.body?.cancel?.();

  if (outcome.timeout) {
    const pending = adoptLate(outcome.controller, outcome.network, async (late) => {
      if (!late.ok || isGateway(late.status)) return;
      if (kind.raw) {
        await cacheImage(cache, event.request, late);
        return;
      }
      const shell = kind.nav ? late.clone() : null;
      await putStamped(cache, event.request, late);
      if (shell) await putStamped(cache, "/view/", shell);
    });
    try {
      event.waitUntil(pending);
    } catch {
      // The refresh still runs; losing the lifetime extension only drops a late write.
    }
  }
  return serveCached(event, url, kind, cache);
}

async function serveCached(event, url, kind, cache) {
  // Match by URL. A navigation request's mode would miss the GET entry we stored.
  // A /view/<doc> URL opened cold has no entry of its own; the shell at /view/ does,
  // and the page then reads the doc from the cached /api/doc response.
  let cached = await cache.match(event.request.url);
  if (!cached && kind.nav) cached = await cache.match("/view/");
  if (cached && signals(url, kind.nav)) {
    await tell(event.clientId, {
      type: "offline",
      cachedAt: cached.headers.get("X-Mdview-Cached-At"),
      doc: url.pathname === "/api/doc",
    });
  }
  if (cached) return cached;
  return new Response("Offline, and this page has not been saved.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Caches an image response when it is an image within the cap. False means the cache rejected it. */
async function cacheImage(cache, request, response) {
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) return true;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > imageCap) return true;
  const blob = await response.blob();
  if (blob.size > imageCap) return true;
  return putBlob(cache, request, blob, response);
}

async function putStamped(cache, request, response) {
  return putBlob(cache, request, await response.blob(), response);
}

async function putBlob(cache, request, blob, response) {
  const headers = new Headers(response.headers);
  headers.set("X-Mdview-Cached-At", new Date().toISOString());
  headers.set("Content-Length", String(blob.size));
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  try {
    await cache.put(asRequest(request), new Response(blob, { status: 200, statusText: "OK", headers }));
    return true;
  } catch {
    // QuotaExceededError: stop filling the phone. Docs are written before images.
    return false;
  }
}

function asRequest(request) {
  // A navigation request cannot be stored: its mode is "navigate". Key by URL only.
  const url = typeof request === "string" ? new URL(request, self.location.origin).href : request.url;
  return new Request(url);
}

async function tell(clientId, message) {
  if (!clientId) return;
  const client = await self.clients.get(clientId);
  client?.postMessage(message);
}

async function tellAll(message) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

function syncAll() {
  if (!syncing) {
    syncing = doSync().finally(() => {
      syncing = null;
    });
  }
  return syncing;
}

async function doSync() {
  try {
    const shellOk = await cacheShell();
    // A dead connect stops here. Continuing would open a fetch per file and pin the page's pool.
    if (!shellOk) throw new Error("offline");
    const cached = await cacheDocs();
    await tellAll({ type: "synced", ok: true, docs: cached });
  } catch (err) {
    await tellAll({ type: "synced", ok: false, error: String(err?.message ?? err) });
  }
}

function linksIn(text, url) {
  const base = new URL(url, self.location.origin);
  const found = new Set();
  const accept = (pathname) => {
    if (pathname.startsWith("/static/") || pathname === "/manifest.webmanifest" || pathname === "/view/") found.add(pathname);
  };
  for (const match of text.matchAll(/(?:["'`(])(\/static\/[^"'`()\s?#]+)/g)) accept(match[1]);
  if (base.pathname.endsWith(".js")) {
    // Only real module specifiers: `from "./x.js"`, `import "./x.js"`, `import("./x.js")`.
    // Any quoted "./x.js" also matched the module ids esbuild leaves in the
    // vendored mermaid bundle (`"../../node_modules/.pnpm/…js"`), 45 404s a sync.
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.\.?\/[^"']+\.js)["']/g)) accept(new URL(match[1], base).pathname);
  }
  if (base.pathname.endsWith(".css")) {
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      if (!match[1].startsWith("data:")) accept(new URL(match[1], base).pathname);
    }
  }
  return [...found];
}

async function cacheShell() {
  const cache = await caches.open(SHELL);
  const queue = ["/view/", "/manifest.webmanifest"];
  const seen = new Set();
  while (queue.length && seen.size < SHELL_LIMIT) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let res;
    try {
      res = await fetchWithin(url);
    } catch {
      return false;
    }
    if (!res.ok) continue;
    const type = res.headers.get("content-type") ?? "";
    const textual = /text|json|javascript|svg|xml/.test(type);
    const text = textual ? await res.clone().text() : "";
    await putStamped(cache, url, res);
    if (text) for (const next of linksIn(text, url)) if (!seen.has(next)) queue.push(next);
  }
  return true;
}

async function mapPool(items, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(FETCH_LIMIT, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  });
  await Promise.all(workers);
}

async function readJson(cache, url) {
  const hit = await cache.match(url);
  if (!hit) return null;
  try {
    return await hit.json();
  } catch {
    return null;
  }
}

async function cacheDocs() {
  const res = await fetchWithin("/api/docs");
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const catalog = await res.json();
  if (Number.isFinite(catalog.imageBytes)) imageCap = catalog.imageBytes;
  const cache = await caches.open(DOCS);
  const previous = await readJson(cache, "/api/docs");
  const prevDocs = new Map((previous?.docs ?? []).map((doc) => [doc.path, doc.etag]));
  const prevImages = new Map((previous?.images ?? []).map((img) => [img.url, img.etag]));
  await putStamped(cache, "/api/docs", new Response(JSON.stringify(catalog), { headers: { "Content-Type": "application/json" } }));

  const current = new Set(catalog.docs.map((doc) => doc.path));
  let offline = false;
  await mapPool(catalog.docs, async (doc) => {
    if (offline) return;
    const url = `/api/doc?path=${encodeURIComponent(doc.path)}`;
    if (prevDocs.get(doc.path) === doc.etag && (await cache.match(url))) return;
    try {
      const docRes = await fetchWithin(url);
      if (docRes.ok) await putStamped(cache, url, docRes);
    } catch {
      // Keep the previous copy, and stop opening more sockets into a dead host.
      offline = true;
    }
  });
  for (const [path] of prevDocs) {
    if (!current.has(path)) await cache.delete(`/api/doc?path=${encodeURIComponent(path)}`);
  }

  // The folder index the home screen opens, which the page asks for as an empty path.
  if (!offline) {
    try {
      const indexRes = await fetchWithin("/api/doc?path=");
      if (indexRes.ok) await putStamped(cache, "/api/doc?path=", indexRes);
    } catch {
      offline = true;
    }
  }

  if (!offline) {
    for (const url of ["/api/tree", "/api/info", "/api/inbox"]) {
      try {
        const apiRes = await fetchWithin(url);
        if (apiRes.ok) await putStamped(cache, url, apiRes);
      } catch {
        offline = true;
        break;
      }
    }
  }

  let quota = false;
  const currentImages = new Set();
  await mapPool(catalog.images ?? [], async (img) => {
    currentImages.add(img.url);
    if (quota || img.size > imageCap) return;
    if (offline || (prevImages.get(img.url) === img.etag && (await cache.match(img.url)))) return;
    try {
      const imgRes = await fetchWithin(img.url);
      if (!imgRes.ok) return;
      const saved = await cacheImage(cache, img.url, imgRes);
      if (saved === false) quota = true;
    } catch {
      offline = true;
    }
  });
  for (const [url] of prevImages) if (!currentImages.has(url)) await cache.delete(url);
  return catalog.docs.length;
}
