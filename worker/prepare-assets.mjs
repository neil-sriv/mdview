/**
 * Writes the files the Worker serves that the Mac builds on each request,
 * then the hashed build the Worker's page links:
 *
 * - public/style.css, public/vendor-hljs/ and public/vendor/mermaid.min.js,
 *   which the unhashed /static/ routes in lib/app.mjs serve (the Mac, and
 *   any page or service worker from before the hashed build).
 * - public/static/build/: one esbuild bundle of public/js/main.js, the two classic
 *   head scripts, the stylesheet, the highlight themes and mermaid, each
 *   named by its content hash. Cloudflare serves these straight from the
 *   asset store (run_worker_first skips /static/build/*), and public/_headers
 *   marks them immutable, so a browser fetches each one once per deploy.
 * - public/shell.html: index.html pointing at those names. The Worker
 *   serves it as the page; the Mac keeps serving index.html and the
 *   unbundled modules.
 *
 * Output is gitignored. Run before `vitest` and before a deploy.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { bundleCss } from "../lib/css-bundle.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const hljs = path.join(root, "node_modules", "highlight.js", "styles");
const themes = path.join(pub, "vendor-hljs");
const vendor = path.join(pub, "vendor");
const out = path.join(pub, "static", "build");

await fs.mkdir(themes, { recursive: true });
await fs.mkdir(vendor, { recursive: true });
await fs.copyFile(path.join(hljs, "github.css"), path.join(themes, "github.css"));
await fs.copyFile(path.join(hljs, "github-dark.css"), path.join(themes, "github-dark.css"));
const mermaid = path.join(root, "node_modules", "mermaid", "dist", "mermaid.min.js");
await fs.copyFile(mermaid, path.join(vendor, "mermaid.min.js"));
const css = await bundleCss(path.join(pub, "styles", "index.css"));
await fs.writeFile(path.join(pub, "style.css"), css);

// A fresh public/static/build/ each run, so old hashes do not pile up in the upload.
await fs.rm(out, { recursive: true, force: true });

/** Writes `body` as public/static/build/<dir>/<name>-<hash><ext> and returns its URL. */
async function emit(dir, name, ext, body) {
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 12);
  const rel = path.posix.join(dir, `${name}-${hash}${ext}`);
  await fs.mkdir(path.join(out, dir), { recursive: true });
  await fs.writeFile(path.join(out, rel), body);
  return `/static/build/${rel}`;
}

const urls = {
  "/static/js/vendor/mermaid.min.js": await emit("js/vendor", "mermaid", ".min.js", await fs.readFile(mermaid)),
  "/static/style.css": await emit("", "style", ".css", css),
  "/static/hljs/github.css": await emit("hljs", "github", ".css", await fs.readFile(path.join(hljs, "github.css"))),
  "/static/hljs/github-dark.css": await emit("hljs", "github-dark", ".css", await fs.readFile(path.join(hljs, "github-dark.css"))),
  "/static/js/recover.js": await emit("js", "recover", ".js", await fs.readFile(path.join(pub, "js", "recover.js"))),
  "/static/js/boot.js": await emit("js", "boot", ".js", await fs.readFile(path.join(pub, "js", "boot.js"))),
};

const built = await esbuild.build({
  entryPoints: [path.join(pub, "js", "main.js")],
  bundle: true,
  format: "esm",
  minify: true,
  target: ["es2022"],
  write: false,
  legalComments: "none",
});
let main = built.outputFiles[0].text;
// The diagram library loads by URL at runtime; point the bundle at its hashed copy.
if (!main.includes("/static/js/vendor/mermaid.min.js")) throw new Error("The bundle no longer names /static/js/vendor/mermaid.min.js.");
main = main.replaceAll("/static/js/vendor/mermaid.min.js", urls["/static/js/vendor/mermaid.min.js"]);
urls["/static/js/main.js"] = await emit("js", "main", ".js", main);

let page = await fs.readFile(path.join(pub, "index.html"), "utf8");
for (const [from, to] of Object.entries(urls)) {
  if (from.includes("mermaid")) continue;
  const quoted = `"${from}"`;
  if (!page.includes(quoted)) throw new Error(`index.html no longer links ${from}.`);
  page = page.replaceAll(quoted, `"${to}"`);
}
await fs.writeFile(path.join(pub, "shell.html"), page);

await fs.writeFile(
  path.join(pub, "_headers"),
  "# Written by worker/prepare-assets.mjs. Every file under /static/build/ is named by its content hash.\n/static/build/*\n  Cache-Control: public, max-age=31536000, immutable\n",
);
