/**
 * Spec files in R2. Keys in the store are `<project>/<path>`. Objects are
 * `specs/<project>/<path>` with customMetadata { sha256, mtimeMs }.
 * `specs/_manifest.json` is the listing, written last by the sync side.
 */
const PREFIX = "specs/";
const MANIFEST_KEY = "specs/_manifest.json";
const INDEX_NAMES = ["README.md", "readme.md", "index.md", "00-overview.md"];
const MARKDOWN = /\.(md|markdown|mdx)$/i;

export class R2DocSource {
  #manifestPromise = null;
  #text = new Map();
  #meta = new Map();

  constructor(bucket) {
    this.bucket = bucket;
    this.root = "specs";
  }

  async listMarkdown() {
    const files = await this.#files();
    return files.map((file) => file.path).filter((path) => MARKDOWN.test(path)).sort(byName);
  }

  /** The page "/" opens: an index file at the top, or the first Markdown file. */
  async initial() {
    const files = await this.listMarkdown();
    const top = files.filter((file) => !file.includes("/"));
    for (const name of INDEX_NAMES) if (top.includes(name)) return name;
    return files[0] ?? "";
  }

  async resolve(rel) {
    const path = clean(rel);
    if (path == null) return { error: "That path is outside the viewer's root.", status: 403 };
    if (!path) return this.#directory("");
    if (path === "_manifest.json") return { error: "No such file: _manifest.json", status: 404 };
    const meta = await this.#head(path);
    if (meta) return this.#describe(path);
    return this.#directory(path);
  }

  async scope(rel) {
    const path = clean(rel);
    if (path == null) return { error: "That path is outside the viewer's root.", status: 403 };
    if (path && path !== "_manifest.json" && (await this.#head(path))) {
      return { kind: "file", key: path, path };
    }
    const prefix = path ? `${path}/` : "";
    const kids = (await this.#files()).filter((file) => file.path.startsWith(prefix));
    if (kids.length || !path) return { kind: "folder", key: path, prefix, path };
    return { error: `No such file: ${rel || "."}`, status: 404 };
  }

  resolveRaw(rel) {
    const path = clean(rel);
    if (path == null || !path || path === "_manifest.json") return null;
    return path;
  }

  displayPath(key) {
    return key;
  }

  async readText(file) {
    const path = clean(file);
    if (path == null || !path) return null;
    if (this.#text.has(path)) return this.#text.get(path);
    const obj = await this.bucket.get(PREFIX + path);
    const text = obj ? await obj.text() : null;
    this.#text.set(path, text);
    if (obj) this.#meta.set(path, metaOf(obj));
    return text;
  }

  async mtimeMs(file) {
    const path = clean(file);
    if (path == null || !path) return null;
    const meta = await this.#head(path);
    return meta ? meta.mtimeMs : null;
  }

  async openRaw(file) {
    const path = typeof file === "string" ? clean(file) : null;
    if (path == null || !path) return null;
    const obj = await this.bucket.get(PREFIX + path);
    if (!obj) return null;
    return { body: obj.body, size: obj.size, ext: extOf(path) };
  }

  async #directory(path) {
    const prefix = path ? `${path}/` : "";
    const kids = (await this.#files()).map((file) => file.path).filter((file) => file.startsWith(prefix));
    if (!kids.length) return { error: `No such file: ${path || "."}`, status: 404 };
    const here = kids.filter((file) => !file.slice(prefix.length).includes("/") && MARKDOWN.test(file));
    const names = here.map((file) => file.slice(prefix.length));
    let index = INDEX_NAMES.find((name) => names.includes(name));
    if (!index) index = names.sort(byName)[0];
    if (!index) return { error: `No Markdown files in ${path || "the root"}.`, status: 404 };
    return this.#describe(prefix + index);
  }

  #describe(path) {
    if (!MARKDOWN.test(path)) return { kind: "raw", rel: path, file: path };
    return { kind: "markdown", rel: path, abs: path, file: path, key: path };
  }

  async #files() {
    if (!this.#manifestPromise) this.#manifestPromise = this.#readManifest();
    return this.#manifestPromise;
  }

  async #readManifest() {
    const obj = await this.bucket.get(MANIFEST_KEY);
    if (!obj) return [];
    let body;
    try {
      body = await obj.json();
    } catch {
      return [];
    }
    if (!body || body.version !== 1 || !Array.isArray(body.files)) return [];
    return body.files.filter((file) => file && typeof file.path === "string" && clean(file.path) === file.path);
  }

  async #head(path) {
    if (this.#meta.has(path)) return this.#meta.get(path);
    const obj = await this.bucket.head(PREFIX + path);
    const meta = obj ? metaOf(obj) : null;
    this.#meta.set(path, meta);
    return meta;
  }
}

function metaOf(obj) {
  const raw = obj.customMetadata?.mtimeMs;
  const parsed = raw == null || raw === "" ? NaN : Number(raw);
  return { mtimeMs: Number.isFinite(parsed) ? parsed : obj.uploaded.getTime() };
}

function extOf(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

function byName(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** A bucket key relative to specs/, or null when it would climb out. */
function clean(rel) {
  if (typeof rel !== "string" || rel.includes("\0") || rel.includes("\\")) return null;
  const parts = [];
  for (const segment of rel.replace(/^\/+/, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    parts.push(segment);
  }
  return parts.join("/");
}
