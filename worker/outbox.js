/**
 * The comment webhook queue.
 *
 * A human message that is sent (not left pending) inserts one mdview_outbox
 * row inside the same SQLite transaction as the send. The wrapper below sits
 * on the Durable Object's driver, so peanut's own write is the transaction:
 * a throw rolls the message back with the row. Agent messages never match.
 *
 * Delivery is separate (worker/deliver.js): ctx.waitUntil on the request,
 * and the minute cron for anything still due.
 */

export const OUTBOX_SQL = `CREATE TABLE IF NOT EXISTS mdview_outbox (
  id           INTEGER PRIMARY KEY,
  message_id   INTEGER UNIQUE,
  payload      TEXT NOT NULL CHECK (json_valid(payload)),
  created_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      TEXT NOT NULL,
  delivered_at TEXT
)`;

const MESSAGE_INSERT = "INSERT INTO messages (thread_id, revision_id, author, author_kind, session, body, created_at, sent_at)";
const SEND_PENDING = "UPDATE messages SET sent_at = ? WHERE sent_at IS NULL";
const BRAND = Symbol.for("peanut.db");

/**
 * Minutes to wait after a failed attempt. `attempts` is the count after this
 * failure: 1, 2, 4, … capped at 60.
 */
export function backoffMs(attempts) {
  const minutes = Math.min(2 ** (attempts - 1), 60);
  return minutes * 60 * 1000;
}

/**
 * JSON posted to the Route spec comments routine.
 *
 * TODO(investigate:notify-payload): today's body is whatever
 * ~/.local/share/mdview-tailnet/comment-notify.mjs posts. That script is not
 * in this repo. The fields below are the likely shape (document key, thread
 * id, message id, author, body, quote) plus the two this spec adds on top
 * (deliveryId, link). Confirm the real shape before cutover.
 */
export function notifyPayload({ key, threadId, messageId, author, body, quote, publicHost }) {
  return {
    document: key,
    threadId,
    messageId,
    author,
    body,
    quote,
    deliveryId: messageId,
    link: `https://${publicHost}/view/${key}`,
  };
}

function compact(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * `db` is doSqlite(). `payload` builds the stored JSON (tests pass one that
 * throws, to prove the send rolls back with the row).
 */
export function withOutbox(db, { publicHost, payload = notifyPayload } = {}) {
  const wrapped = {
    kind: db.kind,
    exec: (sql) => db.exec(sql),
    get: (sql, ...params) => db.get(sql, ...params),
    all: (sql, ...params) => db.all(sql, ...params),
    run(sql, ...params) {
      const result = db.run(sql, ...params);
      if (!result.changes) return result;
      const text = compact(sql);
      if (text.startsWith(MESSAGE_INSERT)) {
        const sentAt = params[7];
        if (sentAt != null && params[3] === "human") {
          enqueueOne(db, { threadId: params[0], author: params[2], body: params[5], publicHost, payload });
        }
      } else if (text === SEND_PENDING) {
        enqueueSent(db, params[0], publicHost, payload);
      }
      return result;
    },
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
    sharedWrites: () => db.sharedWrites(),
    setSharedWrites: (n) => db.setSharedWrites(n),
  };
  wrapped[BRAND] = true;
  return wrapped;
}

function enqueueOne(db, { threadId, author, body, publicHost, payload }) {
  const messageId = Number(db.get("SELECT last_insert_rowid() AS id").id);
  const thread = db.get(
    `SELECT d.key AS key, t.quote AS quote
     FROM threads t JOIN documents d ON d.id = t.document_id WHERE t.id = ?`,
    Number(threadId),
  );
  if (!thread) throw new Error(`mdview: sent message ${messageId} has no thread`);
  insertRow(db, { messageId, threadId: Number(threadId), author, body, key: thread.key, quote: thread.quote ?? "", publicHost, payload });
}

function enqueueSent(db, sentAt, publicHost, payload) {
  const rows = db.all(
    `SELECT m.id AS id, m.thread_id AS threadId, m.author AS author, m.body AS body, d.key AS key, t.quote AS quote
     FROM messages m
     JOIN threads t ON t.id = m.thread_id
     JOIN documents d ON d.id = t.document_id
     WHERE m.sent_at = ? AND m.author_kind = 'human'
       AND NOT EXISTS (SELECT 1 FROM mdview_outbox o WHERE o.message_id = m.id)`,
    sentAt,
  );
  for (const row of rows) {
    insertRow(db, {
      messageId: Number(row.id),
      threadId: Number(row.threadId),
      author: row.author,
      body: row.body,
      key: row.key,
      quote: row.quote ?? "",
      publicHost,
      payload,
    });
  }
}

function insertRow(db, { messageId, threadId, author, body, key, quote, publicHost, payload }) {
  const at = new Date().toISOString();
  db.run(
    `INSERT INTO mdview_outbox (message_id, payload, created_at, next_at) VALUES (?, ?, ?, ?)`,
    messageId,
    JSON.stringify(payload({ key, threadId, messageId, author, body, quote, publicHost })),
    at,
    at,
  );
}
