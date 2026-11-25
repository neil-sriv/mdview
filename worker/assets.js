/**
 * The viewer's own files, from the Worker's asset binding. Spec files do not
 * come through here. style.css and the highlight themes are written by
 * worker/prepare-assets.mjs; everything else is public/ as checked in.
 */
const HLJS = new Set(["github.css", "github-dark.css"]);

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

  async page() {
    return this.#open("/index.html");
  }

  async #open(pathname) {
    const res = await this.assets.fetch(`https://mdview.assets${pathname}`);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const dot = pathname.lastIndexOf(".");
    return { body: new Response(buf).body, size: buf.byteLength, ext: dot === -1 ? "" : pathname.slice(dot).toLowerCase() };
  }
}
