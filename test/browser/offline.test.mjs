import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(await page.eval(async () => (await caches.match("/api/doc?path=other.md"))?.ok ?? false), true);

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
