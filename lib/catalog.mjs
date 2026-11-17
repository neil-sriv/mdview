import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "peanut/anchors/markdown-block";
import { listMarkdown, resolveInRoot } from "./files.mjs";

/**
 * Images at or under this size are listed for the offline cache. Two mebibytes
 * holds a phone screenshot; larger originals stay online-only so a vault of
 * photos cannot fill the phone.
 */
export const IMAGE_BYTES = 2 * 1024 * 1024;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

/**
 * Absolute path to the last revision we hashed. A listing re-reads a doc only
 * when its mtime or size moved, which is how a poll stays cheap on a large vault.
 */
const revisions = new Map();

function stripCode(src) {
  return src.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n").replace(/`[^`\n]*`/g, "");
}

/** Root-relative image paths `href` could name from a doc in `dir`, ignoring anything that leaves the root. */
function candidates(href, dir) {
  if (!href) return [];
  const raw = href.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return [];
  const pathPart = raw.split("#")[0].split("?")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }
  const add = (value) => {
    const normal = path.posix.normalize(value);
    if (!normal || normal === "." || normal === ".." || normal.startsWith("../")) return null;
    if (!IMAGE_EXT.has(path.posix.extname(normal).toLowerCase())) return null;
    return normal;
  };
  const rels = [];
  const chosen = decoded.startsWith("/") ? add(decoded.slice(1)) : add(path.posix.join(dir, decoded));
  if (chosen) rels.push(chosen);
  return rels;
}

/** Images a doc points at: markdown, raw HTML, and Obsidian embeds (`![[file.png]]`). */
function imageRefs(src, dir) {
  const text = stripCode(src);
  const found = new Set();
  const take = (href, from) => {
    for (const rel of candidates(href, from)) found.add(rel);
  };
  for (const match of text.matchAll(/!\[[^\]]*]\(\s*(?:<([^>]+)>|([^)\s]+))/g)) take(match[1] ?? match[2], dir);
  for (const match of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) take(match[1] ?? match[2], dir);
  // An Obsidian embed names a vault path, and notes often keep the file beside themselves.
  for (const match of text.matchAll(/!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/g)) {
    const name = match[1].trim();
    take(name, "");
    take(name, dir);
  }
  return [...found];
}

function rawUrl(rel) {
  return `/raw/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

async function revision(abs, rel) {
  const stat = await fs.stat(abs);
  const prev = revisions.get(abs);
  if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) return prev;
  const src = await fs.readFile(abs, "utf8");
  const sha = sha256(src);
  const dir = path.posix.dirname(rel);
  const next = { mtimeMs: stat.mtimeMs, size: stat.size, sha, etag: sha, images: imageRefs(src, dir === "." ? "" : dir) };
  revisions.set(abs, next);
  return next;
}

/**
 * Every Markdown doc under `root`, with the content hash the offline cache
 * compares, plus the images those docs reference that fit under IMAGE_BYTES.
 * `etag` is the content hash, so a retouch that does not change the text does
 * not make the cache refetch the doc.
 */
export async function listCatalog(root) {
  const files = await listMarkdown(root);
  const docs = [];
  const seen = new Set();
  const imageRels = new Set();
  for (const rel of files) {
    const abs = resolveInRoot(root, rel);
    if (!abs) continue;
    seen.add(abs);
    let rev;
    try {
      rev = await revision(abs, rel);
    } catch {
      continue;
    }
    docs.push({ path: rel, mtimeMs: rev.mtimeMs, size: rev.size, sha: rev.sha, etag: rev.etag });
    for (const img of rev.images) imageRels.add(img);
  }
  for (const abs of revisions.keys()) if (!seen.has(abs)) revisions.delete(abs);

  const images = [];
  let imagesOmitted = 0;
  const omitted = new Set();
  for (const rel of [...imageRels].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const abs = resolveInRoot(root, rel);
    if (!abs) continue;
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > IMAGE_BYTES) {
      if (!omitted.has(abs)) {
        omitted.add(abs);
        imagesOmitted++;
      }
      continue;
    }
    images.push({ path: rel, url: rawUrl(rel), mtimeMs: stat.mtimeMs, size: stat.size, etag: `${stat.mtimeMs}:${stat.size}` });
  }
  return { imageBytes: IMAGE_BYTES, imagesOmitted, docs, images };
}
