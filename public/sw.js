/**
 * Offline cache for the installed app.
 *
 * The shell (HTML, JS, CSS, and whatever those files point at under /static/,
 * including a mermaid build or a font added later) is crawled from /view/.
 * Docs come from /api/docs: each entry's etag is its content hash, so a poll
 * refetches only the files that changed, plus their rendered /api/doc page and
 * same-origin images at or under the catalog's byte cap.
 *
 * Online, every shell file goes to the network like the page does, so one page
 * load runs one deploy's modules. Serving saved shell files first and refreshing
 * them behind the page let a load link a new doc.js against an old lib/paths.js
 * after a deploy; the missing export stopped every module and left a blank page.
 * Saved shell files are handed over at once only while the network is down.
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
// Set when the last attempt hung, dropped, or got a 5xx; cleared by any real answer.
// While it is set, shell files come straight from the cache instead of each
// waiting out NETWORK_MS.
let networkDown = false;
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
    await save(cache, request, fresh, kind);
  } catch {
    // The saved copy stays. The attempt aborts at NETWORK_MS, so it does not sit on the socket.
  }
}

async function networkFirst(event, url, kind) {
  const cache = await caches.open(kind.shell ? SHELL : DOCS);
  // An image is the same bytes whichever deploy asks for it: hand the saved copy over at
  // once and revalidate behind the page. A shell file is only taken from the cache while
  // the network is down, so an online page never mixes two deploys' modules. Everything
  // else waits up to NETWORK_MS so an awake Mac still wins, then falls back.
  if (kind.raw || (kind.shell && !kind.nav && networkDown)) {
    const cached = await cache.match(event.request.url);
    if (cached) {
      if (kind.raw) {
        const pending = refreshCached(event.request, cache, kind);
        try {
          event.waitUntil(pending);
        } catch {
          // The page already has the saved copy.
        }
      }
      return cached;
    }
  }
  const outcome = await fetchRace(event.request, NETWORK_MS);
  networkDown = !outcome.response || isGateway(outcome.response.status);

  if (outcome.response?.ok) {
    cancelLate();
    const fresh = outcome.response;
    const saved = fresh.clone();
    const shell = kind.nav ? fresh.clone() : null;
    // Hand the page its response now; write the cache behind it. waitUntil can throw
    // once the fetch handler has returned, and that must not turn into an offline miss.
    try {
      event.waitUntil((async () => {
        await save(cache, event.request, saved, kind);
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
      const shell = kind.nav ? late.clone() : null;
      await save(cache, event.request, late, kind);
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
  const alias = cached ? null : docAlias(url);
  if (alias) cached = await cache.match(alias);
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

/**
 * Writes a response the fetch handler got. A shell file other than the page is
 * stored as the network gave it: Firefox checks a script against the page's
 * script-src path (/static/js/) by the response's URL, and a Response rebuilt
 * here has none, so it blocked every saved script and the page came up blank.
 */
function save(cache, request, response, kind) {
  if (kind.raw) return cacheImage(cache, request, response);
  if (kind.shell && !kind.nav) return putAsIs(cache, request, response);
  return putStamped(cache, request, response);
}

/** Stores the network's own response, which keeps its URL. False means the cache rejected it. */
async function putAsIs(cache, request, response) {
  try {
    await cache.put(asRequest(request), response);
    return true;
  } catch {
    return false;
  }
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

/**
 * Crawls the whole shell first and writes it only once every file arrived, so the
 * cache always holds one deploy's files. Writing each file as it came in left a
 * crawl that stopped partway (a dead connect, or a deploy landing mid-crawl, or the
 * page reading the cache during the crawl) with new and old modules side by side.
 */
async function cacheShell() {
  const fetched = await crawlShell();
  if (!fetched) return false;
  const cache = await caches.open(SHELL);
  for (const { url, res } of fetched) {
    // The page itself is stamped so an offline load can say when it was saved.
    if (url === "/view/") await putStamped(cache, url, res);
    else await putAsIs(cache, url, res);
  }
  return true;
}

/** Every shell file reachable from /view/, or null when the network dropped partway. */
async function crawlShell() {
  const queue = ["/view/", "/manifest.webmanifest"];
  const seen = new Set();
  const fetched = [];
  while (queue.length && seen.size < SHELL_LIMIT) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let res;
    let text = "";
    try {
      res = await fetchWithin(url);
      if (!res.ok) continue;
      const type = res.headers.get("content-type") ?? "";
      if (/text|json|javascript|svg|xml/.test(type)) text = await res.clone().text();
    } catch {
      return null;
    }
    fetched.push({ url, res });
    if (text) for (const next of linksIn(text, url)) if (!seen.has(next)) queue.push(next);
  }
  return fetched;
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

/** The cache and fetch URL for a rendered doc and its threads, as the page asks for it, or null when there is no path. */
function docUrl(path) {
  if (!path) return null;
  return `/api/doc?path=${encodeURIComponent(path)}&comments=1`;
}

/**
 * The same doc saved under its other URL: a page asks for `comments=1`, and a
 * cache from before that saved the doc without it.
 */
function docAlias(url) {
  if (url.pathname !== "/api/doc") return null;
  const other = new URL(url);
  if (other.searchParams.has("comments")) other.searchParams.delete("comments");
  else other.searchParams.set("comments", "1");
  return other.href;
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
    const url = docUrl(doc.path);
    if (!url || (prevDocs.get(doc.path) === doc.etag && (await cache.match(url)))) return;
    try {
      const docRes = await fetchWithin(url);
      if (docRes.ok) await putStamped(cache, url, docRes);
    } catch {
      // Keep the previous copy, and stop opening more sockets into a dead host.
      offline = true;
    }
  });
  for (const [path] of prevDocs) {
    const url = docUrl(path);
    if (url && !current.has(path)) await cache.delete(url);
  }

  // The home document is whatever /api/info.initial names; the page loads
  // that path instead of asking for /api/doc?path=, and the catalog already
  // cached it above.

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
