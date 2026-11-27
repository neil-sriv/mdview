import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { startViewer } from "../helpers/viewer.mjs";

// After a deploy, a returning browser holds the last deploy's shell. When one module
// imports a name the other deploy's copy of a file lacks, the module graph fails to
// link, main.js never runs, and the page stays blank until a hard refresh.

const chrome = sharedChrome();
const FILES = { "plan.md": "# Plan\n\nA sentence.\n" };

// lib/paths.js as a deploy before docRequestPath existed: doc.js's import of it cannot link.
const STALE_PATHS = fs
  .readFileSync(new URL("../../public/js/lib/paths.js", import.meta.url), "utf8")
  .replace("export function docRequestPath", "function docRequestPath");

const rendered = () => document.querySelector("#doc h1")?.textContent.includes("Plan") && document.querySelectorAll("#tree a").length > 0;

test("an online page is not handed a saved module from the last deploy", { skip: chromeMissing, timeout: 60_000 }, async (t) => {
  const viewer = await startViewer({ files: FILES, initial: "plan.md", port: 47640 });
  t.after(() => viewer.close());
  const page = await (await chrome()).open(viewer.url);
  t.after(() => page.close());
  await controlledAndSaved(page, viewer);

  // Firefox matches a script against script-src /static/js/ by the response's URL. A
  // Response rebuilt in the worker has none, and every saved script was blocked.
  const urls = await page.eval(async () => {
    const cache = await caches.open("mdview-shell");
    return Promise.all(["/static/js/main.js", "/static/js/boot.js", "/static/js/lib/paths.js"].map(async (u) => (await cache.match(u))?.url ?? null));
  });
  assert.deepEqual(urls.map((u) => u && new URL(u).pathname), ["/static/js/main.js", "/static/js/boot.js", "/static/js/lib/paths.js"]);

  // The saved shell is now the last deploy's, and the server has moved on.
  await page.eval(async (body) => {
    const cache = await caches.open("mdview-shell");
    await cache.put("/static/js/lib/paths.js", new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }));
  }, STALE_PATHS);
  page.errors.length = 0;
  await page.goto(new URL("/view/plan.md", viewer.url).href);
  await page.waitFor(rendered, { timeout: 15_000, what: "the doc to render from the current deploy" });
  assert.deepEqual(page.errors, []);
  assert.equal(await page.eval(() => sessionStorage.getItem("mdview.recovered")), null, "the page needed the recovery reload");
});

test("a page whose modules fail to link drops the saved shell and reloads once", { skip: chromeMissing, timeout: 60_000 }, async (t) => {
  const viewer = await startViewer({ files: FILES, initial: "plan.md", port: 47641 });
  t.after(() => viewer.close());
  const page = await (await chrome()).open(viewer.url);
  t.after(() => page.close());
  await controlledAndSaved(page, viewer);

  // An older worker hands over whatever it saved, which can be a mix of two deploys.
  // Serve the stale file once, below any worker, and let the page find its way back.
  await page.send("Network.enable");
  await page.send("Network.setBypassServiceWorker", { bypass: true });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/static/js/lib/paths.js*" }] });
  let served = 0;
  const unhook = page.on("Fetch.requestPaused", async ({ requestId }) => {
    served += 1;
    if (served === 1) {
      await page.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }],
        body: Buffer.from(STALE_PATHS).toString("base64"),
      });
    } else {
      await page.send("Fetch.continueRequest", { requestId });
    }
  });
  t.after(unhook);

  page.errors.length = 0;
  await page.goto(new URL("/view/plan.md", viewer.url).href);
  await page.waitFor(() => sessionStorage.getItem("mdview.recovered"), { timeout: 15_000, what: "the recovery reload" });
  await page.waitFor(rendered, { timeout: 15_000, what: "the doc to render after the reload" });
  assert.ok(served >= 2, `paths.js was requested ${served} time(s)`);
  assert.ok(page.errors.length >= 1 && page.errors.every((e) => /docRequestPath/.test(e)), `unexpected errors: ${page.errors}`);
});

/** A reload under the worker, which saves each shell file the page asks for. Not the whole sync crawl: that is slow under load. */
async function controlledAndSaved(page, viewer) {
  await page.waitFor(rendered, { what: "the doc to render" });
  await page.waitFor(() => navigator.serviceWorker.controller, { timeout: 20_000, what: "the worker to control the page" });
  await page.goto(viewer.url);
  await page.waitFor(rendered, { what: "the doc to render under the worker" });
  await page.waitFor(async () => {
    const cache = await caches.open("mdview-shell");
    return (await cache.match("/static/js/main.js")) && (await cache.match("/static/js/lib/paths.js"));
  }, { timeout: 20_000, what: "the shell files to be saved" });
}
