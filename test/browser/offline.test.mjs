import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { startViewer } from "../helpers/viewer.mjs";
import { select } from "../helpers/viewer-page.mjs";

const chrome = sharedChrome();

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PLAN = `# Plan

A sentence to comment on.

![dot](dot.png)

See [other](other.md).
`;

const OTHER = `# Other

Hello offline.
`;

test("a saved doc opens offline, with the time it was cached and comments disabled", { skip: chromeMissing, timeout: 60_000 }, async (t) => {
  const viewer = await startViewer({
    files: { "plan.md": PLAN, "other.md": OTHER, "dot.png": PNG },
    initial: "plan.md",
    port: 47620,
  });
  t.after(() => viewer.close());
  const page = await (await chrome()).open(viewer.url);
  t.after(() => page.close());
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));

  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Plan"), { what: "the doc to render" });
  await page.waitFor(() => window.__mdviewSync?.ok === true, { timeout: 20_000, what: "the vault to cache" });
  const scope = await page.eval(async () => (await navigator.serviceWorker.getRegistration())?.scope);
  assert.equal(scope, new URL("/", viewer.url).href);

  // A reload is controlled by the worker that just finished saving.
  await page.goto(viewer.url);
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Plan") && navigator.serviceWorker.controller, {
    timeout: 20_000,
    what: "the worker to control the page",
  });
  assert.equal(await page.eval(() => document.querySelector("#offline").hidden), true);
  assert.equal(await page.eval(async () => (await caches.match("/raw/dot.png"))?.status ?? 0), 200);
  assert.equal(await page.eval(async () => (await caches.match("/api/doc?path=other.md&comments=1"))?.ok ?? false), true);

  await viewer.disconnect();
  await viewer.write("plan.md", "# Plan\n\nCHANGED ONLINE ONLY\n");
  await viewer.write("other.md", "# Other\n\nCHANGED TOO\n");

  await page.eval(() => document.querySelector('a.file[data-path="other.md"]').click());
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Other"), { what: "the other doc, from the cache" });
  const offline = await page.eval(() => ({
    body: document.querySelector("#doc").innerText,
    banner: document.querySelector("#offline-status").textContent,
    note: document.querySelector(".offline-note").textContent,
    hidden: document.querySelector("#offline").hidden,
    live: document.querySelector("#live").title,
  }));
  assert.equal(offline.hidden, false);
  assert.match(offline.body, /Hello offline/);
  assert.doesNotMatch(offline.body, /CHANGED/);
  assert.match(offline.banner, /^Offline — saved at \d{1,2}:\d{2}/);
  assert.match(offline.note, /Comment posting is off until you're back/);
  assert.match(offline.live, /offline/);

  await select(page, "Hello offline");
  await page.eval(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "M", code: "KeyM", metaKey: true, shiftKey: true, bubbles: true }));
  });
  assert.equal(await page.eval(() => getComputedStyle(document.querySelector("#comment-btn")).display), "none");
  assert.equal(await page.eval(() => document.querySelector("#composer").hidden), true);

  await page.goto(new URL("/view/plan.md", viewer.url).href);
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Plan") && !document.querySelector("#offline").hidden, {
    timeout: 20_000,
    what: "a full reload from the cache",
  });
  assert.match(await page.eval(() => document.querySelector("#doc").innerText), /A sentence to comment on/);
  assert.doesNotMatch(await page.eval(() => document.querySelector("#doc").innerText), /CHANGED/);
  await page.waitFor(() => {
    const img = document.querySelector("#doc img");
    return img && img.complete && img.naturalWidth > 0;
  }, { what: "the cached image" });
});

const FILES = { "plan.md": PLAN, "other.md": OTHER, "dot.png": PNG };

/** A cached vault with the worker in control. `other.md` has been saved, and not opened as its own page. */
async function openCached(t, port) {
  const viewer = await startViewer({ files: FILES, initial: "plan.md", port });
  t.after(() => viewer.close());
  const page = await (await chrome()).open(viewer.url);
  t.after(() => page.close());
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Plan"), { what: "the doc to render" });
  await page.waitFor(() => window.__mdviewSync?.ok === true, { timeout: 20_000, what: "the vault to cache" });
  await page.goto(viewer.url);
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Plan") && navigator.serviceWorker.controller, {
    timeout: 20_000,
    what: "the worker to control the page",
  });
  return { viewer, page };
}

/** Listens on mdview's port after it has stopped. `respond` writes the socket, or leaves it open. */
function occupy(port, respond) {
  const sockets = new Set();
  let answered = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      if (!respond) return;
      answered += 1;
      respond(socket);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        get answered() {
          return answered;
        },
        close() {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

function gateway(port, status) {
  const reason = status === 504 ? "Gateway Timeout" : "Bad Gateway";
  const body = reason;
  return occupy(port, (socket) => {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  });
}

/** Opens `rel` while mdview is gone and reports how long the cached page took. */
async function openSaved(page, url) {
  const started = Date.now();
  const arrived = await Promise.race([
    page.goto(url).then(() => "loaded"),
    new Promise((resolve) => setTimeout(() => resolve("slow"), 15_000)),
  ]);
  assert.equal(arrived, "loaded", "the navigation never left the hung connect");
  await page.waitFor(
    () => document.querySelector("#doc h1")?.textContent.includes("Other") && document.querySelector("#offline").hidden === false,
    { timeout: 12_000, what: "the cached doc and its banner" },
  );
  const text = await page.eval(() => document.querySelector("#doc").innerText);
  assert.match(text, /Hello offline/);
  assert.doesNotMatch(text, /CHANGED/);
  assert.match(await page.eval(() => document.querySelector("#offline-status").textContent), /^Offline — saved at \d/);
  return Date.now() - started;
}

test("a connect that never answers serves a cached doc, including one whose view URL was never opened", { skip: chromeMissing, timeout: 45_000 }, async (t) => {
  const { viewer, page } = await openCached(t, 47630);
  const otherUrl = new URL("/view/other.md", viewer.url).href;
  assert.equal(await page.eval(async (url) => (await caches.match(url)) != null, otherUrl), false);
  assert.equal(await page.eval(async () => (await caches.match("/api/doc?path=other.md&comments=1"))?.ok ?? false), true);
  await viewer.write("other.md", "# Other\n\nCHANGED TOO\n");

  await viewer.disconnect();
  const blocker = await occupy(Number(new URL(viewer.url).port));
  t.after(() => blocker.close());

  const elapsed = await openSaved(page, otherUrl);
  assert.ok(elapsed < 15_000, `fell back in ${elapsed}ms`);

  const syncStarted = Date.now();
  await page.eval(() => {
    window.__mdviewSync = null;
    navigator.serviceWorker.controller.postMessage({ type: "sync" });
  });
  await page.waitFor(() => window.__mdviewSync?.ok === false, { timeout: 8_000, what: "sync to give up while the connect hangs" });
  assert.ok(Date.now() - syncStarted < 8_000, `sync took ${Date.now() - syncStarted}ms`);
  assert.match(await page.eval(() => document.querySelector("#doc").innerText), /Hello offline/);
});

test("a 502 from the proxy serves the cached doc instead of the gateway error", { skip: chromeMissing, timeout: 45_000 }, async (t) => {
  const { viewer, page } = await openCached(t, 47631);
  const otherUrl = new URL("/view/other.md", viewer.url).href;
  await viewer.write("other.md", "# Other\n\nCHANGED TOO\n");
  await viewer.disconnect();
  const proxy = await gateway(Number(new URL(viewer.url).port), 502);
  t.after(() => proxy.close());

  const elapsed = await openSaved(page, otherUrl);
  assert.ok(elapsed < 10_000, `fell back in ${elapsed}ms`);
  assert.ok(proxy.answered >= 1, "the proxy never returned a 502");
  assert.equal(await page.eval(() => document.body.innerText.includes("Bad Gateway")), false);
});
