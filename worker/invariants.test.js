import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { doSqlite, PeanutStore as Comments, Registry } from "peanut";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mdviewApp } from "../lib/peanut-app.mjs";
import { resetAccessCache } from "./access.js";
import { deliverOutbox } from "./deliver.js";
import worker from "./index.js";
import { backoffMs, OUTBOX_SQL, withOutbox } from "./outbox.js";

const DOC = "Keep this paragraph.\n";
const KEY = "demo/note.md";
const HOST = "https://specs.neilsriv.tech";
const KID = "test-key";

const webhook = { status: 200, script: [], bodies: [], headers: [] };
let privateKey;
let otherKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(rsa(), true, ["sign", "verify"]);
  const other = await crypto.subtle.generateKey(rsa(), true, ["sign", "verify"]);
  privateKey = pair.privateKey;
  otherKey = other.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
  // The Workers test pool has no fetch mock. This isolate is the Worker, so
  // replacing fetch covers Access certs and the comment webhook.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname === "/cdn-cgi/access/certs") {
      return Response.json({ keys: [jwk] });
    }
    if (url.origin === "https://routine.example" && url.pathname === "/comments") {
      webhook.bodies.push(textOf(init?.body));
      webhook.headers.push(init?.headers);
      const status = webhook.script.length ? webhook.script.shift() : webhook.status;
      return new Response("", { status });
    }
    throw new Error(`blocked fetch ${url}`);
  };
  resetAccessCache();
});

beforeEach(async () => {
  webhook.status = 200;
  webhook.script = [];
  webhook.bodies = [];
  webhook.headers = [];
  await wipeStore();
  await wipeBucket();
  await seed();
});

describe("access", () => {
  it("sends a signed-out curl -I to Access and refuses an API call with 401", async () => {
    const head = await call("HEAD", `/view/${KEY}`);
    const api = await call("GET", `/api/comments?path=${encodeURIComponent(KEY)}`);

    expect(head.status).toBe(302);
    expect(head.headers.get("location")).toContain("https://neilsriv.cloudflareaccess.com/cdn-cgi/access/login");
    expect(head.headers.get("location")).toContain("redirect_url=");
    expect(api.status).toBe(401);
    expect(api.json.error).toMatch(/Sign in/);
  });

  it("rejects a forged JWT with 401", async () => {
    const token = await sign(await baseClaims({ email: "neil@neilsriv.tech" }), otherKey);
    const api = await call("GET", "/api/info", { token });
    const head = await call("HEAD", "/", { token });

    expect(api.status).toBe(401);
    expect(head.status).toBe(401);
  });

  it("maps a human email, an agent token, a sync token, and refuses anyone else", async () => {
    const human = await sign(await baseClaims({ email: "Neil@neilsriv.tech" }));
    const agent = await sign(await baseClaims({ common_name: "agent-token" }));
    const sync = await sign(await baseClaims({ common_name: "sync-token" }));
    const stranger = await sign(await baseClaims({ email: "someone@example.com" }));

    expect((await call("GET", "/api/info", { token: human })).status).toBe(200);
    expect((await call("GET", "/api/info", { token: sync })).status).toBe(403);
    expect((await call("GET", "/api/info", { token: stranger })).status).toBe(403);
    const unnamed = await call("GET", `/api/agent/threads?scope=${KEY}`, { token: agent });
    expect(unnamed.status).toBe(400);
  });
});

describe("reads", () => {
  it("reads a spec and the manifest from R2", async () => {
    const token = await sign(await baseClaims({ email: "neil@neilsriv.tech" }));
    const doc = await call("GET", `/api/doc?path=${encodeURIComponent(KEY)}`, { token });
    const tree = await call("GET", "/api/tree", { token });
    const outside = await call("GET", "/api/doc?path=../../etc/passwd", { token });

    expect(doc.status).toBe(200);
    expect(doc.json.sha).toBe(await digest(DOC));
    expect(doc.json.mtimeMs).toBe(1700000000000);
    expect(doc.json.path).toBe(KEY);
    expect(tree.json.files).toEqual([KEY]);
    expect(outside.status).toBe(403);
  });
});

describe("writes", () => {
  it("lands 50 parallel agent replies", async () => {
    const token = await sign(await baseClaims({ common_name: "agent-token" }));
    const created = await agentCreate(token, "parallel");
    const replies = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        call("POST", `/api/agent/threads/${created.json.id}/reply`, {
          token,
          author: "spec-agent",
          body: { message: `reply ${i}`, requestId: `reply-${i}` },
        }),
      ),
    );
    const shown = await call("GET", `/api/agent/threads/${created.json.id}`, { token, author: "spec-agent" });

    expect(replies.every((res) => res.status === 200)).toBe(true);
    expect(shown.json.thread.messages.map((message) => message.body).sort()).toEqual(
      ["Is the title right?", ...Array.from({ length: 50 }, (_, i) => `reply ${i}`)].sort(),
    );
    expect(await outboxCount()).toBe(0);
  });

  it("returns the first result for a replayed requestId", async () => {
    const token = await sign(await baseClaims({ common_name: "agent-token" }));
    const body = { path: KEY, line: 1, message: "Is the title right?", requestId: "once" };
    const first = await call("POST", "/api/agent/threads", { token, author: "spec-agent", body });
    const second = await call("POST", "/api/agent/threads", { token, author: "spec-agent", body });
    const listed = await call("GET", `/api/agent/threads?scope=${KEY}&all=1`, { token, author: "spec-agent" });

    expect(first.status).toBe(201);
    expect(second.json).toEqual(first.json);
    expect(listed.json.threads).toHaveLength(1);

    const reply = { message: "Yes.", requestId: "reply-once" };
    const sent = await call("POST", `/api/agent/threads/${first.json.id}/reply`, { token, author: "spec-agent", body: reply });
    const again = await call("POST", `/api/agent/threads/${first.json.id}/reply`, { token, author: "spec-agent", body: reply });
    const shown = await call("GET", `/api/agent/threads/${first.json.id}`, { token, author: "spec-agent" });

    expect(again.json).toEqual(sent.json);
    expect(shown.json.thread.messages.map((message) => message.body)).toEqual(["Is the title right?", "Yes."]);
  });

  it("shows a human batch of 10 whole or not at all", async () => {
    const human = await sign(await baseClaims({ email: "neil@neilsriv.tech" }));
    const agent = await sign(await baseClaims({ common_name: "agent-token" }));
    const sha = await digest(DOC);
    for (let i = 0; i < 10; i++) {
      const created = await call("POST", "/api/comments", {
        token: human,
        body: { path: KEY, sha, blockIndex: 0, quote: "Keep this", body: `note ${i}`, pending: true, requestId: `pending-${i}` },
      });
      expect(created.status).toBe(201);
    }
    expect(await outboxCount()).toBe(0);

    const counts = [];
    const scope = `/api/agent/threads?scope=${encodeURIComponent(KEY)}&waitingOn=agent&all=1`;
    const polls = Array.from({ length: 8 }, async () => {
      const res = await call("GET", scope, { token: agent, author: "spec-agent" });
      counts.push(res.json.threads.length);
    });
    const waiting = call("GET", `/api/agent/wait?scope=${encodeURIComponent(KEY)}&after=0&timeout=5`, { token: agent, author: "spec-agent" });
    const sent = call("POST", "/api/comments/batch/send", { token: human, body: { requestId: "send-batch" } });
    const [batch, waited] = await Promise.all([sent, waiting, ...polls]);
    const after = await call("GET", scope, { token: agent, author: "spec-agent" });

    expect(batch.json).toEqual({ sent: 10 });
    expect(after.json.threads).toHaveLength(10);
    expect(waited.status).toBe(200);
    expect(waited.json.threads).toHaveLength(10);
    for (const count of counts) expect(count === 0 || count === 10).toBe(true);
    expect(await outboxCount()).toBe(10);
  });

  it("applies all of a list or none of it", async () => {
    const token = await sign(await baseClaims({ common_name: "agent-token" }));
    const created = await agentCreate(token, "apply");
    const bad = await call("POST", "/api/agent/apply", {
      token,
      author: "spec-agent",
      body: {
        requestId: "apply-bad",
        actions: [
          { reply: created.json.id, message: "one" },
          { reply: created.json.id, message: "two" },
          { reply: created.json.id, message: "   " },
        ],
      },
    });
    const shown = await call("GET", `/api/agent/threads/${created.json.id}`, { token, author: "spec-agent" });

    expect(bad.status).toBe(400);
    expect(shown.json.thread.messages.map((message) => message.body)).toEqual(["Is the title right?"]);
  });

  it("gives agents 403 for resolve, reopen, delete and batch", async () => {
    const token = await sign(await baseClaims({ common_name: "agent-token" }));
    const created = await agentCreate(token, "forbidden");
    const shown = await call("GET", `/api/agent/threads/${created.json.id}`, { token, author: "spec-agent" });
    const messageId = shown.json.thread.messages[0].id;
    const id = created.json.id;
    const forbidden = [
      ["/api/comments/batch/send", "send a batch"],
      ["/api/comments/batch/discard", "discard a batch"],
      [`/api/comments/${id}/status`, "resolve or reopen"],
      [`/api/comments/${id}/delete`, "delete a thread"],
      [`/api/comments/${id}/messages/${messageId}/delete`, "delete a message"],
    ];
    for (const [pathname, why] of forbidden) {
      const res = await call("POST", pathname, { token, author: "spec-agent", body: { status: "resolved", body: "no" } });
      expect(res.status, pathname).toBe(403);
      expect(res.json.error, pathname).toMatch(new RegExp(why));
    }
    const still = await call("GET", `/api/agent/threads/${id}`, { token, author: "spec-agent" });
    expect(still.json.thread.status).toBe("open");
    expect(still.json.thread.messages).toHaveLength(1);
  });

  it("refuses a human write from another origin", async () => {
    const token = await sign(await baseClaims({ email: "neil@neilsriv.tech" }));
    const res = await call("POST", "/api/comments", {
      token,
      origin: false,
      body: { path: KEY, sha: await digest(DOC), blockIndex: 0, body: "no" },
    });
    expect(res.status).toBe(403);
  });
});

describe("webhook", () => {
  it("backs off 1, 2, 4 minutes and caps at 60", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(7)).toBe(60 * 60_000);
  });

  it("fails the webhook twice, then delivers one deliveryId", async () => {
    const agent = await sign(await baseClaims({ common_name: "agent-token" }));
    const human = await sign(await baseClaims({ email: "neil@neilsriv.tech" }));
    const created = await agentCreate(agent, "webhook");
    webhook.bodies = [];
    webhook.script = [500, 500, 200];
    const reply = await call("POST", `/api/comments/${created.json.id}/messages`, { token: human, body: { body: "Yes, keep it." } });
    expect(reply.status).toBe(200);
    expect(webhook.bodies).toHaveLength(1);
    const afterFailure = Date.now();

    const second = await deliverOutbox(env, { now: new Date(afterFailure + 90_000) });
    const third = await deliverOutbox(env, { now: new Date(afterFailure + 90_000 + 150_000) });
    const later = await deliverOutbox(env, { now: new Date(afterFailure + 86_400_000) });

    expect(second).toEqual({ delivered: 0, failed: 1 });
    expect(third).toEqual({ delivered: 1, failed: 0 });
    expect(later).toEqual({ delivered: 0, failed: 0 });
    expect(webhook.bodies).toHaveLength(3);
    const payloads = webhook.bodies.map((body) => JSON.parse(body));
    expect(new Set(payloads.map((payload) => payload.deliveryId)).size).toBe(1);
    const payload = payloads[0];
    expect(payload).toMatchObject({
      document: KEY,
      threadId: created.json.id,
      author: "neil@neilsriv.tech",
      body: "Yes, keep it.",
      quote: "",
      deliveryId: payload.messageId,
      link: `${HOST}/view/${KEY}`,
    });
    expect(header(webhook.headers[0], "authorization")).toBe("Bearer test-webhook-key");
    expect(await deliveredCount()).toBe(1);
  });

  it("rolls a send back when the outbox insert throws", async () => {
    const ns = env.STORE;
    await runInDurableObject(ns.get(ns.idFromName("rollback")), async (_instance, state) => {
      const raw = doSqlite(state.storage);
      raw.exec(OUTBOX_SQL);
      const db = withOutbox(raw, {
        publicHost: "specs.neilsriv.tech",
        payload() {
          throw new Error("webhook payload failed");
        },
      });
      const store = Comments.open(db, new Registry().register(mdviewApp));
      await store.createThread({
        type: "mdview.doc",
        key: KEY,
        content: DOC,
        anchorType: "markdown.block",
        spec: { blockIndex: 0 },
        body: "A note",
        author: { name: "neil@neilsriv.tech", kind: "human" },
        pending: true,
      });
      await expect(store.sendPending({ name: "neil@neilsriv.tech", kind: "human" })).rejects.toThrow(/payload failed/);
      expect(await store.pendingCount()).toBe(1);
      expect(Number(raw.get("SELECT count(*) AS n FROM mdview_outbox").n)).toBe(0);
    });
  });
});

describe("cron", () => {
  it("retries a due webhook from the minute cron", async () => {
    webhook.script = [500];
    const agent = await sign(await baseClaims({ common_name: "agent-token" }));
    const human = await sign(await baseClaims({ email: "neil@neilsriv.tech" }));
    const created = await agentCreate(agent, "cron-deliver");
    const reply = await call("POST", `/api/comments/${created.json.id}/messages`, { token: human, body: { body: "From the cron." } });
    expect(reply.status).toBe(200);
    expect(webhook.bodies).toHaveLength(1);
    await runInDurableObject(env.STORE.get(env.STORE.idFromName("store")), async (_instance, state) => {
      state.storage.sql.exec("UPDATE mdview_outbox SET next_at = ? WHERE delivered_at IS NULL", "2020-01-01T00:00:00.000Z");
    });
    webhook.script = [];
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "* * * * *" }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(webhook.bodies).toHaveLength(2);
    expect(JSON.parse(webhook.bodies[1]).deliveryId).toBe(JSON.parse(webhook.bodies[0]).deliveryId);
    expect(await deliveredCount()).toBe(1);
  });

  it("prunes mdview_requests on the night cron and keeps a fresh one", async () => {
    const token = await sign(await baseClaims({ common_name: "agent-token" }));
    await agentCreate(token, "old-request");
    await agentCreate(token, "fresh-request");
    await runInDurableObject(env.STORE.get(env.STORE.idFromName("store")), async (_instance, state) => {
      state.storage.sql.exec("UPDATE mdview_requests SET created_at = ? WHERE id = ?", "2020-01-01T00:00:00.000Z", "old-request");
    });
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "17 3 * * *" }, env, ctx);
    await waitOnExecutionContext(ctx);
    await runInDurableObject(env.STORE.get(env.STORE.idFromName("store")), async (_instance, state) => {
      const ids = state.storage.sql.exec("SELECT id FROM mdview_requests ORDER BY id").toArray().map((row) => row.id);
      expect(ids).toEqual(["fresh-request"]);
    });
  });
});

async function agentCreate(token, requestId) {
  const created = await call("POST", "/api/agent/threads", {
    token,
    author: "spec-agent",
    body: { path: KEY, line: 1, message: "Is the title right?", requestId },
  });
  expect(created.status).toBe(201);
  return created;
}

async function call(method, pathname, { token, author, body, origin = true } = {}) {
  const headers = new Headers();
  if (token) headers.set("Cf-Access-Jwt-Assertion", token);
  if (author) headers.set("X-Mdview-Author", author);
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers.set("content-type", "application/json");
    if (origin) headers.set("origin", HOST);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${HOST}${pathname}`, { method, headers, body: payload }), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function baseClaims(extra) {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [env.POLICY_AUD], iss: env.TEAM_DOMAIN, iat: now, exp: now + 3600, ...extra };
}

async function sign(claims, key = privateKey) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

function b64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function rsa() {
  return { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
}

function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found ? headers[found] : undefined;
}

function textOf(body) {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return String(body ?? "");
}

async function digest(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seed() {
  const sha = await digest(DOC);
  await env.BUCKET.put(`specs/${KEY}`, DOC, { customMetadata: { sha256: sha, mtimeMs: "1700000000000" } });
  await env.BUCKET.put(
    "specs/_manifest.json",
    JSON.stringify({
      version: 1,
      generatedAt: "2026-11-25T00:00:00.000Z",
      source: "box",
      sourceRev: "test",
      files: [{ path: KEY, sha256: sha, size: DOC.length, mtimeMs: 1700000000000 }],
    }),
  );
}

async function wipeBucket() {
  const listed = await env.BUCKET.list();
  await Promise.all(listed.objects.map((object) => env.BUCKET.delete(object.key)));
}

async function wipeStore() {
  await runInDurableObject(env.STORE.get(env.STORE.idFromName("store")), async (_instance, state) => {
    const sql = state.storage.sql;
    for (const table of ["mdview_outbox", "mdview_requests", "messages", "threads", "revisions", "documents"]) {
      sql.exec(`DELETE FROM ${table}`);
    }
  });
}

function outboxCount() {
  return scalar("SELECT count(*) AS n FROM mdview_outbox");
}

function deliveredCount() {
  return scalar("SELECT count(*) AS n FROM mdview_outbox WHERE delivered_at IS NOT NULL");
}

async function scalar(sql) {
  let n = 0;
  await runInDurableObject(env.STORE.get(env.STORE.idFromName("store")), async (_instance, state) => {
    n = Number(state.storage.sql.exec(sql).toArray()[0].n);
  });
  return n;
}
