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
  assert.equal(docUrl("notes/plan.md"), "/api/doc?path=notes%2Fplan.md");
});
