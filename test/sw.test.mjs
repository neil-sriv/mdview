import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// public/sw.js is a classic worker script. Load it with a stub `self` and call
// the crawl's link finder directly.
function loadSw() {
  const context = { self: { addEventListener() {}, location: new URL("https://specs.example/sw.js") }, URL, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), context);
  return context;
}

test("the offline crawl follows real module imports and skips module ids inside a bundle", () => {
  const { linksIn } = loadSw();
  const app = `import { a } from "./lib/a.js";\nimport "../b.js";\nconst c = await import("./c.js");\nexport * from "./d.js";`;
  const bundle = `var x=__commonJS({"../../node_modules/.pnpm/vscode-jsonrpc@8.2.0/node_modules/vscode-jsonrpc/lib/common/is.js"(e){}});var y="./not-an-import.js";`;

  assert.deepEqual([...linksIn(app, "/static/js/main.js")].sort(), ["/static/b.js", "/static/js/c.js", "/static/js/d.js", "/static/js/lib/a.js"]);
  assert.deepEqual([...linksIn(bundle, "/static/js/vendor/mermaid.min.js")], []);
});

test("the offline cache does not request a doc with an empty path", () => {
  const { docUrl } = loadSw();
  assert.equal(docUrl(""), null);
  assert.equal(docUrl(undefined), null);
  assert.equal(docUrl("notes/plan.md"), "/api/doc?path=notes%2Fplan.md&comments=1");
});

test("a doc saved with or without its threads answers the other URL offline", () => {
  const { docAlias } = loadSw();
  assert.equal(docAlias(new URL("https://specs.example/api/doc?path=a.md&comments=1")), "https://specs.example/api/doc?path=a.md");
  assert.equal(docAlias(new URL("https://specs.example/api/doc?path=a.md&v=2")), "https://specs.example/api/doc?path=a.md&v=2&comments=1");
  assert.equal(docAlias(new URL("https://specs.example/api/tree")), null);
});

/** A Cache Storage stand-in keyed by absolute URL. */
function fakeCaches(origin) {
  const stores = new Map();
  const abs = (r) => new URL(typeof r === "string" ? r : r.url, origin).href;
  const open = async (name) => {
    if (!stores.has(name)) {
      const m = new Map();
      stores.set(name, {
        m,
        async match(r) { const hit = m.get(abs(r)); return hit ? hit.clone() : undefined; },
        async put(r, res) { m.set(abs(r), res.clone()); },
        async delete(r) { return m.delete(abs(r)); },
        async keys() { return [...m.keys()].map((u) => new Request(u)); },
      });
    }
    return stores.get(name);
  };
  return { open, stores };
}

function shellSite(build) {
  const files = {
    "/view/": [`<link href="/static/build/style-${build}.css"><script src="/static/build/js/main-${build}.js"></script><link href="/static/favicon.svg">`, "text/html"],
    "/manifest.webmanifest": ["{}", "application/manifest+json"],
    [`/static/build/style-${build}.css`]: ["body{}", "text/css"],
    [`/static/build/js/main-${build}.js`]: [`const L="/static/build/js/vendor/mermaid-${"a".repeat(12)}.min.js";`, "text/javascript"],
    [`/static/build/js/vendor/mermaid-${"a".repeat(12)}.min.js`]: [`x="/static/never-fetched.js"`, "text/javascript"],
    "/static/favicon.svg": ["<svg/>", "image/svg+xml"],
  };
  return files;
}

test("a sync reuses saved hashed files, fetches only the rest, and drops an older build's files", async () => {
  const origin = "https://specs.example";
  const context = loadSw();
  const fake = fakeCaches(origin);
  const fetched = [];
  let site = shellSite("111111111111");
  context.caches = fake;
  context.fetch = async (url, init) => {
    const path = new URL(url, origin).pathname;
    fetched.push([path, init?.cache]);
    const file = site[path];
    return file ? new Response(file[0], { headers: { "content-type": file[1] } }) : new Response("no", { status: 404 });
  };
  context.setTimeout = setTimeout;
  context.clearTimeout = clearTimeout;
  context.AbortController = AbortController;
  context.Response = Response;
  context.Request = Request;
  context.Headers = Headers;
  context.Date = Date;

  assert.equal(await context.cacheShell(), true);
  assert.ok(!fetched.some(([p]) => p === "/static/never-fetched.js"), "a .min.js is not scanned for links");
  assert.deepEqual(fetched.filter(([p]) => p.startsWith("/static/build/")).map(([, c]) => c), ["default", "default", "default"]);
  const first = fetched.length;

  fetched.length = 0;
  assert.equal(await context.cacheShell(), true);
  assert.deepEqual(fetched.map(([p]) => p).sort(), ["/manifest.webmanifest", "/static/favicon.svg", "/view/"]);
  assert.ok(first > fetched.length);

  site = shellSite("222222222222");
  fetched.length = 0;
  assert.equal(await context.cacheShell(), true);
  const kept = [...(await fake.open("mdview-shell")).m.keys()].map((u) => new URL(u).pathname).sort();
  assert.deepEqual(kept, [
    "/manifest.webmanifest",
    "/static/build/js/main-222222222222.js",
    `/static/build/js/vendor/mermaid-${"a".repeat(12)}.min.js`,
    "/static/build/style-222222222222.css",
    "/static/favicon.svg",
    "/view/",
  ]);
  assert.ok(!fetched.some(([p]) => p.includes("mermaid")), "the unchanged mermaid build came from the cache");
});
