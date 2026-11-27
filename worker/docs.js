/**
 * Specs in R2, which is their source of truth.
 *
 * Current text: `specs/<project>/<path>`. A save that still matches the
 * sha256 the caller read also writes `revs/<project>/<path>/<sha256>.md`,
 * then replaces the current object. A save that loses does not write its
 * text. The HTTP ETag is the sha256. R2's own etag is the MD5, and that is
 * what `onlyIf` matches. `onlyIf` is sent on every create and save. This
 * Miniflare does not enforce it, so the Durable Object spec lock in
 * worker/store.js is load-bearing: it is what makes the second racer see
 * the new sha256 and return 412 before anything is written.
 */
import { sha256 } from "peanut/anchors/markdown-block";
import { validSpecKey } from "../lib/docs.mjs";

const SPEC = "specs/";
const REV = "revs/";
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const INDEX_NAMES = ["README.md", "readme.md", "index.md", "00-overview.md"];
const TYPE = "text/markdown; charset=utf-8";

export class R2DocSource {
  #text = new Map();
  #meta = new Map();

  constructor(bucket) {
    this.bucket = bucket;
    this.root = "specs";
    this.r2 = true;
  }

  async listMarkdown() {
    const specs = await this.listSpecs();
    return specs.map((spec) => spec.key).filter((key) => MARKDOWN.test(key)).sort(byName);
  }

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
    const meta = await this.#head(path);
    if (meta) return this.#describe(path);
    return this.#directory(path);
  }

  async scope(rel) {
    const path = clean(rel);
    if (path == null) return { error: "That path is outside the viewer's root.", status: 403 };
    if (path && (await this.#head(path))) return { kind: "file", key: path, path };
    const prefix = path ? `${path}/` : "";
    const kids = (await this.listSpecs()).filter((spec) => spec.key.startsWith(prefix));
    if (kids.length || !path) return { kind: "folder", key: path, prefix, path };
    return { error: `No such file: ${rel || "."}`, status: 404 };
  }

  resolveRaw(rel) {
    const path = clean(rel);
    if (path == null || !path) return null;
    return path;
  }

  displayPath(key) {
    return key;
  }

  async readText(file) {
    const path = clean(file);
    if (path == null || !path) return null;
    if (this.#text.has(path)) return this.#text.get(path);
    const found = await this.readSpec(path);
    const text = found ? found.content : null;
    this.#text.set(path, text);
    return text;
  }

  async mtimeMs(file, options = {}) {
    const path = clean(file);
    if (path == null || !path) return null;
    const meta = await this.#head(path, options.fresh);
    return meta ? meta.mtimeMs : null;
  }

  async openRaw(file) {
    const path = typeof file === "string" ? clean(file) : null;
    if (path == null || !path) return null;
    const obj = await this.bucket.get(specObject(path));
    if (!obj) return null;
    const dot = path.lastIndexOf(".");
    return { body: obj.body, size: obj.size, ext: dot === -1 ? "" : path.slice(dot).toLowerCase() };
  }

  /**
   * What /api/docs answers on the Worker: every spec, with its sha256 as the
   * etag, so the offline cache refetches only the docs that changed. Specs in
   * R2 have no images. lib/catalog.mjs walks the Mac's disk instead.
   */
  async catalog(imageBytes) {
    const specs = await this.listSpecs();
    const docs = specs
      .filter((spec) => MARKDOWN.test(spec.key))
      .map((spec) => ({ path: spec.key, mtimeMs: Date.parse(spec.updatedAt), size: spec.size, sha: spec.sha256, etag: spec.sha256 || `${spec.updatedAt}:${spec.size}` }));
    return { imageBytes, imagesOmitted: 0, docs, images: [] };
  }

  async listSpecs({ project, prefix, since } = {}) {
    const objects = await listAll(this.bucket, SPEC);
    const specs = [];
    for (const object of objects) {
      const key = object.key.slice(SPEC.length);
      if (!validSpecKey(key)) continue;
      if (project && !key.startsWith(`${project}/`)) continue;
      if (prefix && !key.startsWith(prefix)) continue;
      const updatedAt = object.customMetadata?.updatedAt || object.uploaded.toISOString();
      if (since && updatedAt < since) continue;
      specs.push({
        key,
        sha256: object.customMetadata?.sha256 || null,
        size: object.size,
        updatedAt,
        updatedBy: object.customMetadata?.updatedBy || null,
      });
    }
    specs.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    return specs;
  }

  async readSpec(key) {
    if (!validSpecKey(key)) return null;
    const obj = await this.bucket.get(specObject(key));
    if (!obj) return null;
    const content = await obj.text();
    const hash = sha256(content);
    const updatedAt = obj.customMetadata?.updatedAt || obj.uploaded.toISOString();
    this.#text.set(key, content);
    // Same clock as #head. A get that finished first used to memo Date.parse(updatedAt)
    // and ignore a preserved mtimeMs, so the page's "edited" time depended on which
    // R2 call won.
    this.#meta.set(key, { mtimeMs: mtimeOf(obj) });
    return {
      content,
      sha256: hash,
      size: obj.size,
      updatedAt,
      updatedBy: obj.customMetadata?.updatedBy || null,
      storeKey: key,
      file: key,
      etag: obj.etag,
    };
  }

  async revisionsOf(key) {
    if (!(await this.#head(key))) return null;
    const objects = await listAll(this.bucket, revPrefix(key));
    const revisions = objects.map((object) => ({
      sha256: object.customMetadata?.sha256 || shaFromRevKey(object.key),
      updatedAt: object.customMetadata?.updatedAt || object.uploaded.toISOString(),
      updatedBy: object.customMetadata?.updatedBy || null,
    }));
    revisions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.sha256 < b.sha256 ? 1 : -1));
    return revisions;
  }

  async revisionText(key, hash) {
    if (!(await this.#head(key))) return null;
    const obj = await this.bucket.get(revObject(key, hash));
    if (!obj) return undefined;
    return obj.text();
  }

  async createSync({ key, content, by, at, sourceRev }) {
    if (await this.bucket.head(specObject(key))) return specResult(409, "exists", `A spec already exists at ${key}.`);
    const hash = sha256(content);
    await this.#keep(key, hash, content, at, by, sourceRev);
    try {
      await this.bucket.put(specObject(key), content, putOptions(hash, at, by, { etagDoesNotMatch: "*" }, sourceRev));
    } catch (err) {
      if (isPrecondition(err)) return specResult(409, "exists", `A spec already exists at ${key}.`);
      throw err;
    }
    return { status: 201, sha256: hash, file: key, storeKey: key };
  }

  async putSync({ key, content, ifMatch, by, at }) {
    const current = await this.readSpec(key);
    if (!current) return specResult(404, "not_found", `No spec ${key}.`);
    if (ifMatch == null) return specResult(428, "precondition", "If-Match is required.");
    if (ifMatch !== current.sha256) {
      return { ...specResult(412, "stale", "The spec changed since you read it."), current: { sha256: current.sha256, content: current.content } };
    }
    const next = sha256(content);
    await this.#keep(key, current.sha256, current.content, current.updatedAt, current.updatedBy);
    await this.#keep(key, next, content, at, by);
    try {
      await this.bucket.put(specObject(key), content, putOptions(next, at, by, { etagMatches: current.etag }));
    } catch (err) {
      if (!isPrecondition(err)) throw err;
      const now = await this.readSpec(key);
      return {
        ...specResult(412, "stale", "The spec changed since you read it."),
        current: { sha256: now?.sha256 ?? current.sha256, content: now?.content ?? current.content },
      };
    }
    return { status: 200, sha256: next, file: key, storeKey: key };
  }

  async moveSync({ from, to, ifMatch }) {
    const current = await this.readSpec(from);
    if (!current) return specResult(404, "not_found", `No spec ${from}.`);
    if (ifMatch == null) return specResult(428, "precondition", "If-Match is required.");
    if (ifMatch !== current.sha256) {
      return { ...specResult(412, "stale", "The spec changed since you read it."), current: { sha256: current.sha256, content: current.content } };
    }
    if (from === to) return { status: 200, key: to, sha256: current.sha256, fromKey: from, toKey: to };
    if (await this.bucket.head(specObject(to))) return specResult(409, "exists", `A spec already exists at ${to}.`);
    try {
      await this.bucket.put(specObject(to), current.content, putOptions(current.sha256, current.updatedAt, current.updatedBy, { etagDoesNotMatch: "*" }));
    } catch (err) {
      if (isPrecondition(err)) return specResult(409, "exists", `A spec already exists at ${to}.`);
      throw err;
    }
    await this.#copyRevs(from, to);
    await this.bucket.delete(specObject(from));
    await this.#deletePrefix(revPrefix(from));
    this.#text.delete(from);
    this.#meta.delete(from);
    return { status: 200, key: to, sha256: current.sha256, fromKey: from, toKey: to };
  }

  /** Removes the current spec. Its `revs/` stay, for recovery. The spec lock is the guard. */
  async deleteSync({ key, ifMatch }) {
    const current = await this.readSpec(key);
    if (!current) return specResult(404, "not_found", `No spec ${key}.`);
    if (ifMatch == null) return specResult(428, "precondition", "If-Match is required.");
    if (ifMatch !== current.sha256) {
      return { ...specResult(412, "stale", "The spec changed since you read it."), current: { sha256: current.sha256, content: current.content } };
    }
    await this.bucket.delete(specObject(key));
    this.#text.delete(key);
    this.#meta.delete(key);
    return { status: 200, key, sha256: current.sha256 };
  }

  /** A revision text threads already cite. Does not replace the current spec. */
  async putRevision({ key, content, sha256: expected, by, at, sourceRev }) {
    if (!validSpecKey(key)) return specResult(400, "bad_key", "That is not a spec key.");
    if (typeof content !== "string" || typeof expected !== "string") return specResult(400, "bad_request", "A revision needs content and sha256.");
    const hash = sha256(content);
    if (hash !== expected.toLowerCase()) return specResult(400, "bad_hash", "sha256 does not match the content.");
    if (!(await this.bucket.head(specObject(key)))) return specResult(404, "not_found", `No spec ${key}.`);
    await this.#keep(key, hash, content, at, by, sourceRev);
    return { status: 201, sha256: hash };
  }

  async #keep(key, hash, content, at, by, sourceRev) {
    await this.bucket.put(revObject(key, hash), content, putOptions(hash, at, by, undefined, sourceRev));
  }

  async #copyRevs(from, to) {
    const objects = await listAll(this.bucket, revPrefix(from));
    for (const object of objects) {
      const hash = object.customMetadata?.sha256 || shaFromRevKey(object.key);
      const body = await this.bucket.get(object.key);
      if (!body) continue;
      await this.bucket.put(revObject(to, hash), await body.arrayBuffer(), {
        httpMetadata: { contentType: TYPE },
        customMetadata: object.customMetadata,
      });
    }
  }

  async #deletePrefix(prefix) {
    const objects = await listAll(this.bucket, prefix);
    if (objects.length) await this.bucket.delete(objects.map((object) => object.key));
  }

  async #directory(path) {
    const prefix = path ? `${path}/` : "";
    const kids = (await this.listSpecs()).map((spec) => spec.key).filter((key) => key.startsWith(prefix) && MARKDOWN.test(key));
    const here = kids.filter((key) => !key.slice(prefix.length).includes("/"));
    const names = here.map((key) => key.slice(prefix.length));
    let index = INDEX_NAMES.find((name) => names.includes(name));
    if (!index) index = names.sort(byName)[0];
    if (!index) return { error: `No Markdown files in ${path || "the root"}.`, status: kids.length ? 404 : 404 };
    return this.#describe(prefix + index);
  }

  #describe(path) {
    if (!MARKDOWN.test(path)) return { kind: "raw", rel: path, file: path };
    return { kind: "markdown", rel: path, abs: path, file: path, key: path };
  }

  async #head(path, fresh = false) {
    // The memo dedupes resolve + readText inside one page read. Pass fresh for
    // the /api/events poll: that stream keeps this object open, and a memo
    // there would freeze the mtime so a save never reloads the page.
    if (!fresh && this.#meta.has(path)) return this.#meta.get(path);
    const obj = await this.bucket.head(specObject(path));
    if (!obj) {
      this.#meta.set(path, null);
      return null;
    }
    const meta = { mtimeMs: mtimeOf(obj) };
    this.#meta.set(path, meta);
    return meta;
  }
}

function specObject(key) {
  return SPEC + key;
}

function revPrefix(key) {
  return `${REV}${key}/`;
}

function revObject(key, hash) {
  return `${revPrefix(key)}${hash}.md`;
}

function shaFromRevKey(objectKey) {
  const name = objectKey.slice(objectKey.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function putOptions(hash, at, by, onlyIf, sourceRev) {
  const customMetadata = {
    sha256: hash,
    updatedAt: at || new Date().toISOString(),
    updatedBy: by || "",
  };
  if (sourceRev) customMetadata.sourceRev = sourceRev;
  const options = { httpMetadata: { contentType: TYPE }, customMetadata };
  if (onlyIf) options.onlyIf = onlyIf;
  return options;
}

function mtimeOf(obj) {
  const raw = obj.customMetadata?.mtimeMs;
  if (raw != null && raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
  const updatedAt = obj.customMetadata?.updatedAt;
  if (updatedAt) return Date.parse(updatedAt);
  return obj.uploaded.getTime();
}

function specResult(status, error, message) {
  return { status, error, message };
}

function isPrecondition(err) {
  const name = String(err?.name ?? "");
  const message = String(err?.message ?? err);
  return name.includes("Precondition") || /precondition/i.test(message);
}

async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

function byName(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

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
