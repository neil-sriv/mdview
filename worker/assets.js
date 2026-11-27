/**
 * The viewer's own files, from the Worker's asset binding. Spec files do not
 * come through here. style.css, the highlight themes, shell.html and the
 * hashed files under public/static/build/ are written by worker/prepare-assets.mjs;
 * everything else is public/ as checked in.
 */
const HLJS = new Set(["github.css", "github-dark.css"]);
// What prepare-assets.mjs writes to public/static/build/: <name>-<12 hex>.<ext>.
const HASHED = /^\/static\/build\/(?:[\w-]+\/)*[\w.-]+-[0-9a-f]{12}(?:\.min)?\.(?:js|css)$/;
export const IMMUTABLE = "public, max-age=31536000, immutable";

export class AssetSource {
  constructor(assets) {
    this.assets = assets;
  }

  async styles() {
    const res = await this.assets.fetch("https://mdview.assets/style.css");
    if (!res.ok) throw new Error("The stylesheet is missing. Run node worker/prepare-assets.mjs.");
    return res.text();
  }

  async hljs(name) {
    if (!HLJS.has(name)) return null;
    return this.#open(`/vendor-hljs/${name}`);
  }

  async file(rel) {
    if (typeof rel !== "string" || rel.includes("\0") || rel.split("/").includes("..")) return null;
    const path = rel.replace(/^\/+/, "");
    if (!path) return null;
    return this.#open(`/${path}`);
  }

  /** shell.html links the hashed build; index.html (unbundled modules) is the fallback. */
  async page() {
    return (await this.#open("/shell.html", ".html")) ?? this.#open("/index.html");
  }

  /** A hashed build file under public/static/build/, as the asset store answers it, or null. */
  async built(pathname) {
    if (!HASHED.test(pathname)) return null;
    const res = await this.assets.fetch(`https://mdview.assets${pathname}`);
    return res.ok ? res : null;
  }

  async manifest() {
    return this.#open("/manifest.webmanifest");
  }

  async worker() {
    return this.#open("/sw.js");
  }

  async mermaid() {
    return this.#open("/vendor/mermaid.min.js");
  }

  async #open(pathname, ext) {
    const res = await this.assets.fetch(`https://mdview.assets${pathname}`);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const dot = pathname.lastIndexOf(".");
    return { body: new Response(buf).body, size: buf.byteLength, ext: ext ?? (dot === -1 ? "" : pathname.slice(dot).toLowerCase()) };
  }
}
