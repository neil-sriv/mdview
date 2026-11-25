/**
 * The viewer's own files (the page, its scripts, the stylesheet). Spec files
 * go through DocSource; these do not. The Worker serves them from its asset
 * binding instead.
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { bundleCss } from "./css-bundle.mjs";
import { resolveInRoot } from "./files.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "..", "public");
const STYLES_ENTRY = path.join(PUBLIC_DIR, "styles", "index.css");
const HLJS_STYLES = path.join(HERE, "..", "node_modules", "highlight.js", "styles");
const HLJS_THEMES = new Set(["github.css", "github-dark.css"]);
const MERMAID_SCRIPT = path.join(HERE, "..", "node_modules", "mermaid", "dist", "mermaid.min.js");

async function openFile(abs) {
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
    return { body: Readable.toWeb(createReadStream(abs)), size: stat.size, ext: path.extname(abs).toLowerCase() };
  } catch {
    return null;
  }
}

export class FsAssets {
  async styles() {
    return bundleCss(STYLES_ENTRY);
  }

  async hljs(name) {
    if (!HLJS_THEMES.has(name)) return null;
    return openFile(path.join(HLJS_STYLES, name));
  }

  /** A file under public/, or null when it is missing or would leave that folder. */
  async file(rel) {
    const abs = resolveInRoot(PUBLIC_DIR, rel);
    if (!abs) return null;
    return openFile(abs);
  }

  async page() {
    return openFile(path.join(PUBLIC_DIR, "index.html"));
  }

  async manifest() {
    return openFile(path.join(PUBLIC_DIR, "manifest.webmanifest"));
  }

  async worker() {
    return openFile(path.join(PUBLIC_DIR, "sw.js"));
  }

  async mermaid() {
    return openFile(MERMAID_SCRIPT);
  }
}
