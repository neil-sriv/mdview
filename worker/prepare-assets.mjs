/**
 * Writes the files the Worker serves that the Mac builds on each request:
 * the bundled stylesheet, and the two highlight.js themes the page links.
 * Output is gitignored. Run before `vitest` and before a deploy.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleCss } from "../lib/css-bundle.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hljs = path.join(root, "node_modules", "highlight.js", "styles");
const themes = path.join(root, "public", "vendor-hljs");
const vendor = path.join(root, "public", "vendor");

await fs.mkdir(themes, { recursive: true });
await fs.mkdir(vendor, { recursive: true });
await fs.copyFile(path.join(hljs, "github.css"), path.join(themes, "github.css"));
await fs.copyFile(path.join(hljs, "github-dark.css"), path.join(themes, "github-dark.css"));
await fs.copyFile(path.join(root, "node_modules", "mermaid", "dist", "mermaid.min.js"), path.join(vendor, "mermaid.min.js"));
const css = await bundleCss(path.join(root, "public", "styles", "index.css"));
await fs.writeFile(path.join(root, "public", "style.css"), css);
