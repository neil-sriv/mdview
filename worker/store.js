/**
 * One Durable Object, idFromName("store"), holding every comment.
 *
 * Migrations run in the constructor under blockConcurrencyWhile. RPC is
 * peanut's PeanutStore, plus the outbox (outboxDue, markDelivered, markFailed),
 * pruneRequests, and importJson. importJson loads one Mac export, in one
 * transaction, and only when the store is empty unless forced.
 *
 * The Worker talks to the stub through remoteStore(), which is the async
 * store handle() already uses. onWrite cannot cross RPC; the change feed
 * polls changeToken instead.
 */
import { DurableObject } from "cloudflare:workers";
import { AnchorError, doSqlite, PeanutStore as Comments, Registry, StoreError } from "peanut";
import { DOC, mdviewApp } from "../lib/peanut-app.mjs";
import { AsyncStore, StoreError as ViewError } from "../lib/store.mjs";
import { OUTBOX_SQL, withOutbox } from "./outbox.js";
import { TransferError, importInto, parityFromEntries } from "../lib/transfer.mjs";

const registry = new Registry().register(mdviewApp);

export function storeStub(env) {
  return env.STORE.get(env.STORE.idFromName("store"));
}

const STORE_ERROR = "@mdview/error";

export function remoteStore(env) {
  const stub = storeStub(env);
  const call = (promise) => promise.then((value) => {
    if (value && typeof value === "object" && typeof value[STORE_ERROR] === "string" && Object.keys(value).length === 1) {
      throw new ViewError(value[STORE_ERROR]);
    }
    return value;
  });
  const store = new AsyncStore({
    onWrite: () => () => {},
    changeToken: () => call(stub.changeToken()),
    observe: (type, key, input) => call(stub.observe(type, key, input ?? null)),
    contentForSha: (type, key, sha) => call(stub.contentForSha(type, key, sha)),
    createThread: (input) => call(stub.createThread(strip(input))),
    reply: (threadId, body, author, options) => call(stub.reply(threadId, body, strip(author), opts(options))),
    setStatus: (threadId, status, author, body, options) => call(stub.setStatus(threadId, status, strip(author), body ?? null, opts(options))),
    apply: (actions, author, options) => call(stub.apply(strip(actions), strip(author), opts(options))),
    pendingCount: () => call(stub.pendingCount()),
    sendPending: (author, options) => call(stub.sendPending(strip(author), opts(options))),
    discardPending: (author, options) => call(stub.discardPending(strip(author), opts(options))),
    deleteThread: (threadId, author, options) => call(stub.deleteThread(threadId, strip(author), opts(options))),
    deleteMessage: (threadId, messageId, author, options) => call(stub.deleteMessage(threadId, messageId, strip(author), opts(options))),
    revisionAt: (type, key, seq) => call(stub.revisionAt(type, key, seq)),
    revisions: (type, key) => call(stub.revisions(type, key)),
    waitingOnAgent: (options) => call(stub.waitingOnAgent(opts(options))),
    threadsAt: (type, key, options) => call(stub.threadsAt(type, key, opts(options))),
    thread: (threadId, options) => call(stub.thread(threadId, opts(options))),
    documentOf: (threadId) => call(stub.documentOf(threadId)),
    documents: (filter) => call(stub.documents(filter ?? null)),
  });
  // Spec writes await R2, so they cannot run inside the DO's transaction.
  // The request id is recorded after the bucket accepts the write.
  store.once = (requestId, fn) => specOnce(stub, requestId, fn);
  store.renameDocument = (from, to) => call(stub.renameDocument(from, to));
  store.importJson = (payload) => call(stub.importJson(strip(payload)));
  store.parity = () => call(stub.parity());
  store.waitingOnHumanCountsIn = async (keys) => {
    const want = new Set(keys);
    const rows = await call(stub.humanCounts());
    return new Map(rows.filter(([key]) => want.has(key)));
  };
  store.waitingOnHumanIn = async (keys) => {
    const found = [];
    for (const [doc] of await store.waitingOnHumanCountsIn(keys)) {
      const result = await store.threadsAt(doc);
      const threads = result?.threads.filter((thread) => thread.waitingOn === "human") ?? [];
      if (threads.length) found.push({ ...result, threads });
    }
    return found;
  };
  return store;
}

async function specOnce(stub, requestId, fn) {
  const prior = await stub.readRequest(requestId);
  if (prior?.hit) return prior.value;
  // Load-bearing. This Miniflare ignores R2 onlyIf, so without this lock two
  // saves with the same If-Match can both land. onlyIf is still sent.
  await stub.acquireSpecLock();
  try {
    const again = await stub.readRequest(requestId);
    if (again?.hit) return again.value;
    const value = await fn(null);
    return await stub.rememberRequest(requestId, value);
  } finally {
    await stub.releaseSpecLock();
  }
}

/** The nightly cron. `now` is injectable so a test can age rows out. */
export function pruneRequests(env, now = new Date()) {
  return storeStub(env).pruneRequests(now.toISOString());
}

/** Drops undefined, which Durable Object RPC will not carry. null stays null. */
function strip(value) {
  if (Array.isArray(value)) return value.map((item) => strip(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = strip(item);
    return out;
  }
  return value;
}

function opts(value) {
  return strip(value) ?? {};
}

function storable(value) {
  if (!value || typeof value !== "object") return value;
  const { etag, content, current, ...rest } = value;
  return rest;
}

function jsonSafe(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = jsonSafe(item);
    return out;
  }
  return value;
}

export class PeanutStore extends DurableObject {
  #db;
  #peanut;
  #specLock = false;
  #specWaiters = [];

  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => {
      const db = doSqlite(ctx.storage);
      db.exec(OUTBOX_SQL);
      this.#db = db;
      this.#peanut = Comments.open(withOutbox(db, { publicHost: env.PUBLIC_HOST }), registry);
    });
  }

  async changeToken() { return this.#call(() => this.#peanut.changeToken()); }
  async observe(type, key, input) { return this.#call(() => this.#peanut.observe(type, key, input ?? undefined)); }
  async contentForSha(type, key, sha) { return this.#call(() => this.#peanut.contentForSha(type, key, sha)); }
  async createThread(input) { return this.#call(() => this.#peanut.createThread(input)); }
  async reply(threadId, body, author, options) { return this.#call(() => this.#peanut.reply(threadId, body, author, options ?? {})); }
  async setStatus(threadId, status, author, body, options) {
    return this.#call(() => this.#peanut.setStatus(threadId, status, author, body == null ? undefined : body, options ?? {}));
  }
  async apply(actions, author, options) { return this.#call(() => this.#peanut.apply(actions, author, options ?? {})); }
  async pendingCount() { return this.#call(() => this.#peanut.pendingCount()); }
  async sendPending(author, options) { return this.#call(() => this.#peanut.sendPending(author, options ?? {})); }
  async discardPending(author, options) { return this.#call(() => this.#peanut.discardPending(author, options ?? {})); }
  async deleteThread(threadId, author, options) { return this.#call(() => this.#peanut.deleteThread(threadId, author, options ?? {})); }
  async deleteMessage(threadId, messageId, author, options) {
    return this.#call(() => this.#peanut.deleteMessage(threadId, messageId, author, options ?? {}));
  }
  async revisionAt(type, key, seq) { return this.#call(() => this.#peanut.revisionAt(type, key, seq)); }
  async revisions(type, key) { return this.#call(() => this.#peanut.revisions(type, key)); }
  async waitingOnAgent(options) { return this.#call(() => this.#peanut.waitingOnAgent(options ?? {})); }
  async threadsAt(type, key, options) { return this.#call(() => this.#peanut.threadsAt(type, key, options ?? {})); }
  async thread(threadId, options) { return this.#call(() => this.#peanut.thread(threadId, options ?? {})); }
  async documentOf(threadId) { return this.#call(() => this.#peanut.documentOf(threadId)); }
  async documents(filter) { return this.#call(() => this.#peanut.documents(filter)); }

  async outboxDue(nowIso) {
    return this.#call(() => this.#db.all(
      `SELECT id, message_id AS messageId, payload, attempts, next_at AS nextAt
       FROM mdview_outbox WHERE delivered_at IS NULL AND next_at <= ? ORDER BY id`,
      nowIso,
    ));
  }

  async markDelivered(ids, nowIso) {
    const at = nowIso || new Date().toISOString();
    return this.#call(() => this.#db.transaction(() => {
      let n = 0;
      for (const id of ids ?? []) {
        n += this.#db.run("UPDATE mdview_outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", at, Number(id)).changes;
      }
      return n;
    }));
  }

  async markFailed(id, nextAt) {
    return this.#call(() => {
      const row = this.#db.get("SELECT attempts FROM mdview_outbox WHERE id = ? AND delivered_at IS NULL", Number(id));
      if (!row) return null;
      const attempts = Number(row.attempts) + 1;
      this.#db.run("UPDATE mdview_outbox SET attempts = ?, next_at = ? WHERE id = ?", attempts, nextAt, Number(id));
      return { id: Number(id), attempts, nextAt };
    });
  }

  async renameDocument(from, to) {
    if (!from || from === to) return;
    return this.#call(async () => {
      try {
        await this.#peanut.renameDocument(DOC, from, to);
      } catch (err) {
        if (err instanceof StoreError && String(err.message).startsWith("No tracked document ")) return;
        throw err;
      }
    });
  }

  async humanCounts() {
    return this.#call(() =>
      this.#db
        .all(
          `SELECT d.key AS key, count(*) AS n FROM threads t
           JOIN thread_facts f ON f.thread_id = t.id JOIN documents d ON d.id = t.document_id
           WHERE f.waiting_on = 'human' AND d.type = 'mdview.doc'
           GROUP BY d.key ORDER BY d.key`,
        )
        .map((row) => [row.key, Number(row.n)]),
    );
  }

  async acquireSpecLock() {
    if (!this.#specLock) {
      this.#specLock = true;
      return;
    }
    await new Promise((resolve) => this.#specWaiters.push(resolve));
  }

  async releaseSpecLock() {
    const next = this.#specWaiters.shift();
    if (next) next();
    else this.#specLock = false;
  }

  async readRequest(id) {
    return this.#call(() => {
      const row = this.#db.get("SELECT result FROM mdview_requests WHERE id = ?", id);
      if (!row) return { hit: false };
      const parsed = JSON.parse(row.result);
      return { hit: true, value: parsed.u ? undefined : parsed.v };
    });
  }

  async rememberRequest(id, value) {
    return this.#call(() => {
      const stored = storable(value);
      this.#db.run(
        `INSERT INTO mdview_requests (id, result, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        id,
        JSON.stringify({ v: stored }),
        new Date().toISOString(),
      );
      const row = this.#db.get("SELECT result FROM mdview_requests WHERE id = ?", id);
      const parsed = JSON.parse(row.result);
      return parsed.u ? undefined : parsed.v;
    });
  }

  async pruneRequests(nowIso) {
    return this.#call(() => this.#peanut.pruneRequests(new Date(nowIso)));
  }

  async importJson(payload) {
    return this.#call(() => {
      try {
        return importInto(this.#db, payload);
      } catch (err) {
        if (err instanceof TransferError) return { ok: false, error: err.code, message: err.message };
        throw err;
      }
    });
  }

  async parity() {
    return this.#call(async () => {
      const docs = await this.#peanut.documents([{ type: DOC, keyPrefix: "" }]);
      const entries = [];
      for (const doc of docs) {
        const found = await this.#peanut.threadsAt(DOC, doc.key, { includePending: true });
        entries.push({
          key: doc.key,
          threads: (found?.threads ?? []).map((thread) => ({
            id: Number(thread.id),
            state: thread.state,
            blockIndex: thread.placement?.blockIndex ?? null,
            waitingOn: thread.waitingOn ?? null,
          })),
        });
      }
      return parityFromEntries(entries);
    });
  }

  async #call(fn) {
    try {
      const value = await fn();
      return value === undefined ? undefined : jsonSafe(value);
    } catch (err) {
      // Returned, not thrown: a throw here is logged as uncaught even when the
      // caller turns it into the 400 the client sees.
      if (err instanceof StoreError || err instanceof AnchorError) return { [STORE_ERROR]: err.message };
      throw err;
    }
  }
}
