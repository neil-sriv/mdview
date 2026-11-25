/**
 * Where spec files come from.
 *
 * `handle()` talks only to this, so the Mac and the Worker read files the
 * same way. FsDocSource is the Mac: files under a root, and the store key
 * is the file's realpath (what the local comment store already uses).
 * R2DocSource (worker/docs.js) uses the same methods with keys
 * `<project>/<file>.md`. Current text is `specs/<key>`; each save is also
 * `revs/<key>/<sha256>.md`. Its writes return promises; the Mac's stay sync.
 *
 * resolve(rel) →
 *   { kind: "markdown", rel, abs, file, key }  a Markdown doc. abs is the path
 *     the page shows; key is the store key (the realpath).
 *   { kind: "raw", rel, file }            something else under the root
 *   { error, status }                     missing, or outside the root
 * scope(rel) →
 *   { kind: "file", key, path }           one doc; path is what the API returns
 *   { kind: "folder", key, prefix, path } every doc whose store key starts with prefix
 *   { error, status }
 * readText(file) → string | null          file is the value resolve() returned
 * mtimeMs(file) → number | null
 * openRaw(file) → { body, size, ext } | null   body is a web stream
 * listMarkdown() → root-relative paths
 * displayPath(key) → the root-relative path for a store key
 */
import fs from "node:fs/promises";
import { createReadStream, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { sha256 } from "peanut/anchors/markdown-block";
import { isMarkdown, listMarkdown, pickIndex, resolveInRoot, toPosix } from "./files.mjs";

/** A spec key is `<project>/<file>.md`, or `<project>/archive/<file>.md`. */
export const SPEC_KEY = /^[a-z0-9-]+\/(?:archive\/)?[a-z0-9._-]+\.md$/;

export function validSpecKey(key) {
  return typeof key === "string" && SPEC_KEY.test(key);
}

async function real(file) {
  try {
    return await fs.realpath(file);
  } catch {
    return path.resolve(file);
  }
}

export class FsDocSource {
  constructor(root) {
    this.root = root;
    this.realRoot = fsReal(root);
  }

  async listMarkdown() {
    return listMarkdown(this.root);
  }

  async resolve(rel) {
    const abs = resolveInRoot(this.root, rel);
    if (!abs) return { error: "That path is outside the viewer's root.", status: 403 };
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return { error: `No such file: ${rel || "."}`, status: 404 };
    if (stat.isDirectory()) {
      const index = await pickIndex(abs);
      if (!index) return { error: `No Markdown files in ${rel || "the root"}.`, status: 404 };
      const file = path.join(abs, index);
      return {
        kind: "markdown",
        rel: toPosix(path.relative(this.root, file)),
        abs: file,
        file,
        key: await real(file),
      };
    }
    if (!isMarkdown(abs)) return { kind: "raw", rel: toPosix(path.relative(this.root, abs)), file: abs };
    return { kind: "markdown", rel: toPosix(path.relative(this.root, abs)), abs, file: abs, key: await real(abs) };
  }

  /** A file or folder an agent named, as a store key. `path` is the root-relative name. */
  async scope(rel) {
    const abs = resolveInRoot(this.root, rel);
    if (!abs) return { error: "That path is outside the viewer's root.", status: 403 };
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return { error: `No such file: ${rel || "."}`, status: 404 };
    const key = await real(abs);
    const shown = toPosix(String(rel ?? "").replace(/^\.\/+/, "").replace(/\/+$/, ""));
    if (stat.isDirectory()) {
      const prefix = key.endsWith(path.sep) ? key : key + path.sep;
      return { kind: "folder", key, prefix, path: shown };
    }
    return { kind: "file", key, path: toPosix(path.relative(this.root, abs)) };
  }

  /** Where a raw URL points, or null when it would leave the root. */
  resolveRaw(rel) {
    return resolveInRoot(this.root, rel);
  }

  displayPath(key) {
    const rel = path.relative(this.realRoot, key);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return toPosix(key);
    return toPosix(rel);
  }

  async readText(file) {
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return null;
    }
  }

  async mtimeMs(file) {
    try {
      return (await fs.stat(file)).mtimeMs;
    } catch {
      return null;
    }
  }

  async openRaw(file) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      return { body: Readable.toWeb(createReadStream(file)), size: stat.size, ext: path.extname(file).toLowerCase() };
    } catch {
      return null;
    }
  }

  /**
   * Specs whose relative path is a spec key. Revisions live under
   * `.mdview-revs/`, which the file list skips, named by sha256 so a retried
   * save writes the same object. `putSync` and `createSync` run inside the
   * store's write lock: the hash check and the replace are one critical section.
   */
  async listSpecs({ project, prefix, since } = {}) {
    const specs = [];
    for (const rel of await this.listMarkdown()) {
      if (!validSpecKey(rel)) continue;
      if (project && !rel.startsWith(`${project}/`)) continue;
      if (prefix && !rel.startsWith(prefix)) continue;
      const current = this.#current(rel);
      if (!current) continue;
      if (since && (!current.updatedAt || current.updatedAt < since)) continue;
      specs.push({ key: rel, sha256: current.sha256, size: current.size, updatedAt: current.updatedAt, updatedBy: current.updatedBy });
    }
    specs.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    return specs;
  }

  readSpec(key) {
    return this.#current(key);
  }

  revisionsOf(key) {
    if (!this.#current(key)) return null;
    return this.#meta(key).revisions ?? [];
  }

  revisionText(key, sha) {
    if (!this.#current(key)) return null;
    try {
      return readFileSync(path.join(this.#revDir(key), `${sha}.md`), "utf8");
    } catch {
      return undefined;
    }
  }

  createSync({ key, content, by, at, sourceRev }) {
    if (this.#current(key)) return specResult(409, "exists", `A spec already exists at ${key}.`);
    const file = this.#file(key);
    mkdirSync(path.dirname(file), { recursive: true });
    const hash = sha256(content);
    this.#keep(key, hash, content);
    writeFileSync(file, content);
    const saved = { sha256: hash, updatedAt: at, updatedBy: by, ...(sourceRev ? { sourceRev } : {}) };
    this.#writeMeta(key, { updatedAt: at, updatedBy: by, ...(sourceRev ? { sourceRev } : {}), revisions: [saved] });
    return { status: 201, sha256: hash, file, storeKey: fsReal(file) };
  }

  /** Writes a cited revision under `.mdview-revs/` without changing the current file. */
  putRevision({ key, content, sha256: expected, by, at, sourceRev }) {
    if (!validSpecKey(key)) return specResult(400, "bad_key", "That is not a spec key.");
    if (typeof content !== "string" || typeof expected !== "string") return specResult(400, "bad_request", "A revision needs content and sha256.");
    const hash = sha256(content);
    if (hash !== expected.toLowerCase()) return specResult(400, "bad_hash", "sha256 does not match the content.");
    if (!this.#current(key)) return specResult(404, "not_found", `No spec ${key}.`);
    this.#keep(key, hash, content);
    const meta = this.#meta(key);
    const revisions = meta.revisions ?? [];
    if (!revisions.some((rev) => rev.sha256 === hash)) {
      revisions.push({ sha256: hash, updatedAt: at, updatedBy: by, ...(sourceRev ? { sourceRev } : {}) });
    }
    this.#writeMeta(key, { ...meta, revisions });
    return { status: 201, sha256: hash };
  }

  putSync({ key, content, ifMatch, by, at }) {
    const current = this.#current(key);
    if (!current) return specResult(404, "not_found", `No spec ${key}.`);
    if (ifMatch == null) return specResult(428, "precondition", "If-Match is required.");
    if (ifMatch !== current.sha256) {
      return {
        ...specResult(412, "stale", "The spec changed since you read it."),
        current: { sha256: current.sha256, content: current.content },
      };
    }
    const next = sha256(content);
    this.#keep(key, current.sha256, current.content);
    this.#keep(key, next, content);
    const tmp = `${current.file}.mdview-tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, current.file);
    const previous = (this.#meta(key).revisions ?? []).filter((rev) => rev.sha256 !== next && rev.sha256 !== current.sha256);
    const saved = { sha256: next, updatedAt: at, updatedBy: by };
    const prior = { sha256: current.sha256, updatedAt: current.updatedAt, updatedBy: current.updatedBy };
    const revisions = next === current.sha256 ? [prior, ...previous] : [saved, prior, ...previous];
    this.#writeMeta(key, { updatedAt: at, updatedBy: by, revisions });
    return { status: 200, sha256: next, file: current.file, storeKey: fsReal(current.file) };
  }

  /** Removes the current file. Its `.mdview-revs/` stay, for recovery. */
  deleteSync({ key, ifMatch }) {
    const current = this.#current(key);
    if (!current) return specResult(404, "not_found", `No spec ${key}.`);
    if (ifMatch == null) return specResult(428, "precondition", "If-Match is required.");
    if (ifMatch !== current.sha256) {
      return {
        ...specResult(412, "stale", "The spec changed since you read it."),
        current: { sha256: current.sha256, content: current.content },
      };
    }
    unlinkSync(current.file);
    return { status: 200, key, sha256: current.sha256 };
  }

  moveSync({ from, to, ifMatch }) {
    const current = this.#current(from);
    if (!current) return specResult(404, "not_found", `No spec ${from}.`);
    if (ifMatch == null) return specResult(428, "precondition", "If-Match is required.");
    if (ifMatch !== current.sha256) {
      return {
        ...specResult(412, "stale", "The spec changed since you read it."),
        current: { sha256: current.sha256, content: current.content },
      };
    }
    if (from === to) return { status: 200, key: to, sha256: current.sha256, fromKey: current.storeKey, toKey: current.storeKey };
    if (this.#current(to)) return specResult(409, "exists", `A spec already exists at ${to}.`);
    const dest = this.#file(to);
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(current.file, dest);
    const fromDir = this.#revDir(from);
    const toDir = this.#revDir(to);
    try {
      if (statSync(fromDir).isDirectory()) {
        mkdirSync(path.dirname(toDir), { recursive: true });
        renameSync(fromDir, toDir);
      }
    } catch {
      // A file that was never saved through the spec API has no revision directory.
    }
    return { status: 200, key: to, sha256: current.sha256, fromKey: current.storeKey, toKey: fsReal(dest) };
  }

  #file(key) {
    return path.join(this.root, ...key.split("/"));
  }

  #revDir(key) {
    return path.join(this.root, ".mdview-revs", ...key.split("/"));
  }

  #meta(key) {
    try {
      return JSON.parse(readFileSync(path.join(this.#revDir(key), "meta.json"), "utf8"));
    } catch {
      return { revisions: [] };
    }
  }

  #writeMeta(key, meta) {
    const dir = this.#revDir(key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  }

  #keep(key, hash, content) {
    const file = path.join(this.#revDir(key), `${hash}.md`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  #current(key) {
    const file = this.#file(key);
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const meta = this.#meta(key);
    let mtimeMs = null;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    return {
      file,
      content,
      sha256: sha256(content),
      size: Buffer.byteLength(content),
      updatedAt: meta.updatedAt || (mtimeMs == null ? null : new Date(mtimeMs).toISOString()),
      updatedBy: meta.updatedBy ?? null,
      storeKey: fsReal(file),
    };
  }
}

function specResult(status, error, message) {
  return { status, error, message };
}

function fsReal(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}
