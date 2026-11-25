/**
 * The Mac comment store as portable JSON, and the load into an empty store.
 *
 * `mdview store export` writes this file. `POST /internal/import` feeds it to
 * the Durable Object in one transaction. Ids stay, so a thread is the same
 * thread afterwards. Keys in the file are `<project>/<file>.md`; the Mac's
 * realpaths are rewritten with `--rekey-vault` on the way out.
 *
 * A second load of the same file does nothing. A different file is refused
 * while the store holds anything, unless `force` replaces those rows. The
 * message insert names `id` first so the outbox wrapper does not see a new
 * human comment and notify for history.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "peanut/anchors/markdown-block";
import { validSpecKey } from "./docs.mjs";

export const EXPORT_VERSION = 1;
const DOC = "mdview.doc";
const BLOCK = "markdown.block";
const STATUSES = new Set(["open", "suggested", "resolved"]);
const VAULT_SPEC = /^projects\/([a-z0-9-]+)\/specs\/((?:archive\/)?[a-z0-9._-]+\.md)$/;

export class TransferError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** `projects/<project>/specs/<file>.md` (and `archive/`) as a spec key, or null. */
export function specKeyFromVaultPath(relPosix) {
  const match = VAULT_SPEC.exec(String(relPosix).replaceAll("\\", "/").replace(/^\.\/+/, ""));
  if (!match) return null;
  const key = `${match[1]}/${match[2]}`;
  return validSpecKey(key) ? key : null;
}

/** The vault file a spec key is backed up to. */
export function vaultFileForSpec(vault, key) {
  if (!validSpecKey(key)) throw new TransferError("invalid", `Refusing to write ${key}: it is not a spec key.`);
  const [project, ...rest] = key.split("/");
  const abs = path.resolve(vault, "projects", project, "specs", ...rest);
  const root = path.resolve(vault);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new TransferError("invalid", `Refusing to write ${key}: it leaves the vault.`);
  return abs;
}

/** A Mac realpath under the vault, as the spec key the Worker uses. */
export function rekeyDocument(key, vaultRoot) {
  const root = fs.realpathSync(vaultRoot);
  let abs = key;
  try {
    abs = fs.realpathSync(key);
  } catch {
    abs = path.resolve(key);
  }
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const spec = specKeyFromVaultPath(rel);
  if (!spec) {
    throw new TransferError("unmapped", `${key} is not under ${root}/projects/<project>/specs/ as a spec key.`);
  }
  return spec;
}

/** Spec files in a vault, including `index.md`. A file that is not a spec key is listed in `skipped`. */
export function listVaultSpecs(vault) {
  const projectsDir = path.join(vault, "projects");
  const specs = [];
  const skipped = [];
  if (!fs.existsSync(projectsDir)) return { specs, skipped, missing: true };
  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory() || project.name.startsWith(".")) continue;
    const specsDir = path.join(projectsDir, project.name, "specs");
    if (!fs.statSync(specsDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    walkFiles(specsDir, (file) => {
      if (!file.endsWith(".md")) return;
      const rel = path.relative(path.resolve(vault), file).split(path.sep).join("/");
      const key = specKeyFromVaultPath(rel);
      if (!key) skipped.push(rel);
      else specs.push({ key, file, rel });
    });
  }
  specs.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  return { specs, skipped, missing: false };
}

function walkFiles(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, visit);
    else if (entry.isFile()) visit(abs);
  }
}

/** Revisions a thread or one of its messages was written against. */
export function referencedRevisions(payload) {
  const found = [];
  for (const doc of payload.documents ?? []) {
    const ids = new Set();
    for (const thread of doc.threads ?? []) {
      ids.add(thread.revisionId);
      for (const message of thread.messages ?? []) ids.add(message.revisionId);
    }
    for (const revision of doc.revisions ?? []) {
      if (ids.has(revision.id)) found.push({ key: doc.key, ...revision });
    }
  }
  return found;
}

export function exportStore(db, { rekey } = {}) {
  const seen = new Set();
  const documents = readDocuments(db).map((doc) => {
    const key = rekey ? rekey(doc.key) : doc.key;
    if (seen.has(key)) throw new TransferError("unmapped", `Two documents rekey to ${key}.`);
    seen.add(key);
    return { ...doc, key };
  });
  return { version: EXPORT_VERSION, documents };
}

/**
 * Loads `payload` in one transaction. The same payload again is a no-op.
 * Anything else is refused while a row exists, unless `payload.force` (or
 * `force`) deletes the comment rows first. Outbox rows go with them so a
 * replaced id cannot look like a delivery of the old message.
 */
export function importInto(db, payload, { force = false, keys = "spec" } = {}) {
  const parsed = validateExport(payload, { keys });
  const replace = force || parsed.force;
  return db.transaction(() => {
    const current = exportStore(db);
    if (canonical(current) === canonical(parsed.data)) return result(parsed.data, true);
    if (!isEmpty(db) && !replace) {
      return {
        ok: false,
        error: "not_empty",
        message: "The comment store is not empty. Import again with force to replace it.",
      };
    }
    if (!isEmpty(db)) wipe(db);
    insertAll(db, parsed.data);
    return result(parsed.data, false);
  });
}

function result(data, idempotent) {
  return {
    ok: true,
    idempotent,
    documents: data.documents.length,
    revisions: data.documents.reduce((sum, doc) => sum + doc.revisions.length, 0),
    threads: data.documents.reduce((sum, doc) => sum + doc.threads.length, 0),
    messages: data.documents.reduce((sum, doc) => sum + doc.threads.reduce((n, thread) => n + thread.messages.length, 0), 0),
  };
}

/** Where every thread sits, for `mdview store verify`. `store.threadsAt` does the placing. */
export function localParity(store, db, { vault } = {}) {
  const rekey = vault ? (key) => rekeyDocument(key, vault) : (key) => key;
  const entries = readDocuments(db).map((doc) => {
    const view = store.threadsAt(doc.key, { includePending: true });
    return { key: rekey(doc.key), threads: view?.threads ?? [] };
  });
  return parityFromEntries(entries);
}

/** `{ threads, inbox, documents: [{ key, threads, inbox, anchors }] }` from placed threads. */
export function parityFromEntries(entries) {
  const documents = [];
  let threads = 0;
  let inbox = 0;
  for (const entry of entries) {
    const anchors = entry.threads.map(anchorOf).sort((a, b) => a.id - b.id);
    const docInbox = anchors.filter((anchor) => anchor.waitingOn === "human").length;
    threads += anchors.length;
    inbox += docInbox;
    documents.push({ key: entry.key, threads: anchors.length, inbox: docInbox, anchors });
  }
  documents.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  return { threads, inbox, documents };
}

export function compareParity(local, remote) {
  const problems = [];
  if (local.threads !== remote.threads) {
    problems.push(`Thread count is ${local.threads} on the Mac and ${remote.threads} on the Worker.`);
  }
  if (local.inbox !== remote.inbox) {
    problems.push(`Inbox count is ${local.inbox} on the Mac and ${remote.inbox} on the Worker.`);
  }
  const left = new Map(local.documents.map((doc) => [doc.key, doc]));
  const right = new Map(remote.documents.map((doc) => [doc.key, doc]));
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const key of keys) {
    const mac = left.get(key);
    const worker = right.get(key);
    if (!mac || !worker) {
      problems.push(`${key} is missing on ${mac ? "the Worker" : "the Mac"}.`);
      continue;
    }
    if (mac.threads !== worker.threads) {
      problems.push(`${key} has ${mac.threads} threads on the Mac and ${worker.threads} on the Worker.`);
    }
    const remoteAnchors = new Map(worker.anchors.map((anchor) => [anchor.id, anchor]));
    const localAnchors = new Map(mac.anchors.map((anchor) => [anchor.id, anchor]));
    for (const anchor of mac.anchors) {
      const other = remoteAnchors.get(anchor.id);
      if (!other) problems.push(`Thread #${anchor.id} on ${key} is not on the Worker.`);
      if (!anchor.resolved) problems.push(`Thread #${anchor.id} on ${key} does not resolve on the Mac (${anchor.state}).`);
      if (other && !other.resolved) problems.push(`Thread #${anchor.id} on ${key} does not resolve on the Worker (${other.state}).`);
    }
    for (const anchor of worker.anchors) {
      if (!localAnchors.has(anchor.id)) problems.push(`Thread #${anchor.id} on ${key} is not on the Mac.`);
    }
  }
  return problems;
}

export function anchorOf(thread) {
  const state = thread.state;
  return {
    id: Number(thread.id),
    state,
    blockIndex: Number.isInteger(thread.blockIndex) ? thread.blockIndex : null,
    waitingOn: thread.waitingOn ?? null,
    resolved: state === "current" || state === "carried",
  };
}

/** A node:sqlite file as the small driver import and export use. */
export function openStoreDb(file, { readOnly = false } = {}) {
  if (readOnly && !fs.existsSync(file)) throw new TransferError("invalid", `No comment store at ${file}.`);
  const { DatabaseSync } = loadSqlite();
  const sqlite = new DatabaseSync(file, { readOnly });
  if (!readOnly) {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    sqlite.exec("PRAGMA foreign_keys = ON");
  }
  return {
    all: (sql, ...params) => sqlite.prepare(sql).all(...params),
    get: (sql, ...params) => sqlite.prepare(sql).get(...params),
    run: (sql, ...params) => ({ changes: Number(sqlite.prepare(sql).run(...params).changes) }),
    transaction(fn) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const value = fn();
        sqlite.exec("COMMIT");
        return value;
      } catch (err) {
        try {
          sqlite.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    },
    close: () => sqlite.close(),
  };
}

function loadSqlite() {
  return process.getBuiltinModule("node:sqlite");
}

function readDocuments(db) {
  const documents = db
    .all("SELECT id, type, key, created_at FROM documents ORDER BY id")
    .map((row) => ({
      id: asInt(row.id),
      type: row.type,
      key: row.key,
      createdAt: row.created_at,
      revisions: [],
      threads: [],
    }));
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  for (const row of db.all("SELECT id, document_id, seq, sha256, content, meta, observed_at FROM revisions ORDER BY id")) {
    const doc = byId.get(asInt(row.document_id));
    if (!doc) continue;
    doc.revisions.push({
      id: asInt(row.id),
      seq: asInt(row.seq),
      sha256: row.sha256,
      content: row.content,
      meta: parseJson(row.meta, {}),
      observedAt: row.observed_at,
    });
  }
  const threads = new Map();
  for (const row of db.all(
    "SELECT id, document_id, revision_id, anchor_type, anchor, quote, status, status_by, status_at, created_at FROM threads ORDER BY id",
  )) {
    const doc = byId.get(asInt(row.document_id));
    if (!doc) continue;
    const thread = {
      id: asInt(row.id),
      revisionId: asInt(row.revision_id),
      anchorType: row.anchor_type,
      anchor: parseJson(row.anchor, {}),
      quote: row.quote ?? "",
      status: row.status,
      statusBy: row.status_by ?? null,
      statusAt: row.status_at ?? null,
      createdAt: row.created_at,
      messages: [],
    };
    doc.threads.push(thread);
    threads.set(thread.id, thread);
  }
  for (const row of db.all(
    "SELECT id, thread_id, revision_id, author, author_kind, session, body, created_at, sent_at FROM messages ORDER BY id",
  )) {
    const thread = threads.get(asInt(row.thread_id));
    if (!thread) continue;
    thread.messages.push({
      id: asInt(row.id),
      revisionId: asInt(row.revision_id),
      author: row.author,
      authorKind: row.author_kind,
      session: row.session ?? null,
      body: row.body,
      createdAt: row.created_at,
      sentAt: row.sent_at ?? null,
    });
  }
  return documents;
}

function validateExport(payload, { keys }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TransferError("invalid", "The export must be a JSON object.");
  }
  const allowed = new Set(["version", "documents", "force"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TransferError("invalid", `Unknown export field ${key}.`);
  }
  if (payload.version !== EXPORT_VERSION) throw new TransferError("invalid", `Export version must be ${EXPORT_VERSION}.`);
  if (!Array.isArray(payload.documents)) throw new TransferError("invalid", "Export documents must be a list.");
  if (payload.force !== undefined && typeof payload.force !== "boolean") throw new TransferError("invalid", "force must be a boolean.");
  const docIds = new Set();
  const revIds = new Set();
  const threadIds = new Set();
  const messageIds = new Set();
  const specKeys = new Set();
  const documents = payload.documents.map((doc) => validateDocument(doc, { keys, docIds, revIds, threadIds, messageIds, specKeys }));
  documents.sort((a, b) => a.id - b.id);
  return { force: payload.force === true, data: { version: EXPORT_VERSION, documents } };
}

function validateDocument(doc, ctx) {
  expectFields(doc, ["id", "type", "key", "createdAt", "revisions", "threads"], "document");
  const id = expectId(doc.id, "document", ctx.docIds);
  if (doc.type !== DOC) throw new TransferError("invalid", `Document #${id} has type ${doc.type}, not ${DOC}.`);
  if (typeof doc.key !== "string" || !doc.key) throw new TransferError("invalid", `Document #${id} needs a key.`);
  if (ctx.keys === "spec" && !validSpecKey(doc.key)) throw new TransferError("invalid", `Document #${id} key ${doc.key} is not a spec key.`);
  if (ctx.keys === "path" && !path.isAbsolute(doc.key)) throw new TransferError("invalid", `Document #${id} key must be an absolute path.`);
  if (ctx.specKeys.has(doc.key)) throw new TransferError("invalid", `Two documents use ${doc.key}.`);
  ctx.specKeys.add(doc.key);
  expectString(doc.createdAt, `document #${id} createdAt`);
  if (!Array.isArray(doc.revisions) || !Array.isArray(doc.threads)) {
    throw new TransferError("invalid", `Document #${id} needs revisions and threads.`);
  }
  const revIds = new Set();
  const seqs = new Set();
  const revisions = doc.revisions.map((revision) => validateRevision(revision, id, ctx.revIds, revIds, seqs));
  revisions.sort((a, b) => a.id - b.id);
  if (!doc.threads.length) throw new TransferError("invalid", `Document #${id} has no threads.`);
  const threads = doc.threads.map((thread) => validateThread(thread, id, revIds, ctx));
  threads.sort((a, b) => a.id - b.id);
  return { id, type: doc.type, key: doc.key, createdAt: doc.createdAt, revisions, threads };
}

function validateRevision(revision, documentId, allIds, docRevIds, seqs) {
  expectFields(revision, ["id", "seq", "sha256", "content", "meta", "observedAt"], "revision");
  const id = expectId(revision.id, "revision", allIds);
  const seq = expectId(revision.seq, "revision seq");
  if (seqs.has(seq)) throw new TransferError("invalid", `Document #${documentId} repeats revision seq ${seq}.`);
  seqs.add(seq);
  docRevIds.add(id);
  if (typeof revision.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(revision.sha256)) {
    throw new TransferError("invalid", `Revision #${id} needs a sha256.`);
  }
  if (typeof revision.content !== "string") throw new TransferError("invalid", `Revision #${id} content must be a string.`);
  if (sha256(revision.content) !== revision.sha256) throw new TransferError("invalid", `Revision #${id} sha256 does not match its content.`);
  if (!revision.meta || typeof revision.meta !== "object" || Array.isArray(revision.meta)) {
    throw new TransferError("invalid", `Revision #${id} meta must be an object.`);
  }
  expectString(revision.observedAt, `revision #${id} observedAt`);
  return {
    id,
    seq,
    sha256: revision.sha256,
    content: revision.content,
    meta: stable(revision.meta),
    observedAt: revision.observedAt,
  };
}

function validateThread(thread, documentId, revIds, ctx) {
  expectFields(thread, ["id", "revisionId", "anchorType", "anchor", "quote", "status", "statusBy", "statusAt", "createdAt", "messages"], "thread");
  const id = expectId(thread.id, "thread", ctx.threadIds);
  const revisionId = expectId(thread.revisionId, "thread revision");
  if (!revIds.has(revisionId)) throw new TransferError("invalid", `Thread #${id} points at a revision it does not have.`);
  if (thread.anchorType !== BLOCK) throw new TransferError("invalid", `Thread #${id} uses ${thread.anchorType}, not ${BLOCK}.`);
  const anchor = validateAnchor(thread.anchor, id);
  if (typeof thread.quote !== "string") throw new TransferError("invalid", `Thread #${id} quote must be a string.`);
  if (!STATUSES.has(thread.status)) throw new TransferError("invalid", `Thread #${id} has status ${thread.status}.`);
  expectNullableString(thread.statusBy, `thread #${id} statusBy`);
  expectNullableString(thread.statusAt, `thread #${id} statusAt`);
  expectString(thread.createdAt, `thread #${id} createdAt`);
  if (!Array.isArray(thread.messages) || !thread.messages.length) throw new TransferError("invalid", `Thread #${id} has no messages.`);
  const messages = thread.messages.map((message) => validateMessage(message, id, revIds, ctx.messageIds));
  messages.sort((a, b) => a.id - b.id);
  return {
    id,
    revisionId,
    anchorType: thread.anchorType,
    anchor,
    quote: thread.quote,
    status: thread.status,
    statusBy: thread.statusBy ?? null,
    statusAt: thread.statusAt ?? null,
    createdAt: thread.createdAt,
    messages,
  };
}

function validateAnchor(anchor, threadId) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new TransferError("invalid", `Thread #${threadId} anchor must be an object.`);
  }
  expectFields(anchor, ["blockSha", "ordinal", "start"], "anchor");
  if (typeof anchor.blockSha !== "string" || !/^[0-9a-f]{64}$/.test(anchor.blockSha)) {
    throw new TransferError("invalid", `Thread #${threadId} anchor needs a blockSha.`);
  }
  if (!Number.isInteger(anchor.ordinal) || anchor.ordinal < 0) {
    throw new TransferError("invalid", `Thread #${threadId} anchor ordinal must be a whole number.`);
  }
  if (!(anchor.start === null || (Number.isInteger(anchor.start) && anchor.start >= 0))) {
    throw new TransferError("invalid", `Thread #${threadId} anchor start must be a whole number or null.`);
  }
  return { blockSha: anchor.blockSha, ordinal: anchor.ordinal, start: anchor.start };
}

function validateMessage(message, threadId, revIds, ids) {
  expectFields(message, ["id", "revisionId", "author", "authorKind", "session", "body", "createdAt", "sentAt"], "message");
  const id = expectId(message.id, "message", ids);
  const revisionId = expectId(message.revisionId, "message revision");
  if (!revIds.has(revisionId)) throw new TransferError("invalid", `Message #${id} points at a revision outside its document.`);
  expectString(message.author, `message #${id} author`);
  if (message.authorKind !== "human" && message.authorKind !== "agent") {
    throw new TransferError("invalid", `Message #${id} authorKind must be human or agent.`);
  }
  expectNullableString(message.session, `message #${id} session`);
  if (typeof message.body !== "string") throw new TransferError("invalid", `Message #${id} body must be a string.`);
  expectString(message.createdAt, `message #${id} createdAt`);
  expectNullableString(message.sentAt, `message #${id} sentAt`);
  return {
    id,
    revisionId,
    author: message.author,
    authorKind: message.authorKind,
    session: message.session ?? null,
    body: message.body,
    createdAt: message.createdAt,
    sentAt: message.sentAt ?? null,
  };
}

function expectFields(value, fields, noun) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TransferError("invalid", `A ${noun} must be an object.`);
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TransferError("invalid", `Unknown ${noun} field ${key}.`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new TransferError("invalid", `A ${noun} needs ${field}.`);
  }
}

function expectId(value, noun, seen) {
  if (typeof value === "bigint") value = Number(value);
  if (!Number.isSafeInteger(value) || value < 1) throw new TransferError("invalid", `A ${noun} id must be a positive integer.`);
  if (seen) {
    if (seen.has(value)) throw new TransferError("invalid", `Duplicate ${noun} id ${value}.`);
    seen.add(value);
  }
  return value;
}

function expectString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TransferError("invalid", `${label} must be a non-empty string.`);
}

function expectNullableString(value, label) {
  if (!(value === null || typeof value === "string")) throw new TransferError("invalid", `${label} must be a string or null.`);
}

function insertAll(db, data) {
  for (const doc of data.documents) {
    db.run("INSERT INTO documents (id, type, key, created_at) VALUES (?, ?, ?, ?)", doc.id, doc.type, doc.key, doc.createdAt);
  }
  for (const doc of data.documents) {
    for (const revision of doc.revisions) {
      db.run(
        "INSERT INTO revisions (id, document_id, seq, sha256, content, meta, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        revision.id,
        doc.id,
        revision.seq,
        revision.sha256,
        revision.content,
        JSON.stringify(revision.meta),
        revision.observedAt,
      );
    }
  }
  for (const doc of data.documents) {
    for (const thread of doc.threads) {
      db.run(
        `INSERT INTO threads (id, document_id, revision_id, anchor_type, anchor, quote, status, status_by, status_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        thread.id,
        doc.id,
        thread.revisionId,
        thread.anchorType,
        JSON.stringify(thread.anchor),
        thread.quote,
        thread.status,
        thread.statusBy,
        thread.statusAt,
        thread.createdAt,
      );
    }
  }
  for (const doc of data.documents) {
    for (const thread of doc.threads) {
      for (const message of thread.messages) {
        // `id` is first on purpose: the outbox wrapper matches inserts that
        // start with the live message columns, and a migration must not notify.
        db.run(
          `INSERT INTO messages (id, thread_id, revision_id, author, author_kind, session, body, created_at, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          message.id,
          thread.id,
          message.revisionId,
          message.author,
          message.authorKind,
          message.session,
          message.body,
          message.createdAt,
          message.sentAt,
        );
      }
    }
  }
}

function wipe(db) {
  const names = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
  if (names.has("mdview_outbox")) db.run("DELETE FROM mdview_outbox");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM threads");
  db.run("DELETE FROM revisions");
  db.run("DELETE FROM documents");
}

function isEmpty(db) {
  const row = db.get(
    `SELECT (SELECT count(*) FROM documents) + (SELECT count(*) FROM revisions) +
            (SELECT count(*) FROM threads) + (SELECT count(*) FROM messages) AS n`,
  );
  return Number(row?.n ?? 0) === 0;
}

function canonical(payload) {
  return JSON.stringify(stable(payload));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asInt(value) {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

export function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
