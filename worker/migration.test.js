import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { markdownBlock, sha256 } from "peanut/anchors/markdown-block";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blockTokens } from "../lib/render.mjs";
import { resetAccessCache } from "./access.js";
import worker from "./index.js";

const V1 = "Keep this paragraph.\n";
const V2 = "Keep this paragraph.\n\nAdded later.\n";
const KEY = "demo/note.md";
const HOST = "https://specs.neilsriv.tech";
const KID = "migration-key";

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
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname === "/cdn-cgi/access/certs") return Response.json({ keys: [jwk] });
    throw new Error(`blocked fetch ${url}`);
  };
  resetAccessCache();
});

beforeEach(async () => {
  resetAccessCache();
  await wipeStore();
  await wipeBucket();
});

describe("import", () => {
  it("loads an export once, places the thread on the same block, and keeps history", async () => {
    const payload = exportOf();
    const admin = await sign(await baseClaims({ common_name: "admin-token" }));
    const agent = await sign(await baseClaims({ common_name: "agent-token" }));
    const backup = await sign(await baseClaims({ common_name: "backup-token" }));
    const human = await sign(await baseClaims({ email: "neil@neilsriv.tech" }));

    expect((await call("POST", "/internal/import", { token: agent, body: payload })).status).toBe(403);
    expect((await call("POST", "/internal/import", { token: backup, body: payload })).status).toBe(403);
    expect((await call("POST", "/internal/import", { token: human, body: payload })).status).toBe(403);
    expect((await call("POST", "/internal/import", { body: payload })).status).toBe(401);
    expect((await call("GET", "/api/specs", { token: admin })).status).toBe(403);
    expect((await call("GET", "/api/specs", { token: backup })).status).toBe(200);

    const loaded = await call("POST", "/internal/import", { token: admin, body: payload });
    const replay = await call("POST", "/internal/import", { token: admin, body: payload });
    expect(loaded.status).toBe(201);
    expect(loaded.json.threads).toBe(1);
    expect(loaded.json.idempotent).toBe(false);
    expect(replay.status).toBe(201);
    expect(replay.json.idempotent).toBe(true);
    expect(await outboxCount()).toBe(0);

    const created = await call("POST", "/api/specs", {
      token: agent,
      author: "spec-agent",
      body: { key: KEY, content: V2, sourceRev: "abc1234", requestId: "seed-note" },
    });
    expect(created.status).toBe(201);
    const head = await env.BUCKET.head(`specs/${KEY}`);
    expect(head.customMetadata.sourceRev).toBe("abc1234");
    const old = payload.documents[0].revisions[0];
    const kept = await call("POST", "/internal/revisions", {
      token: admin,
      body: { key: KEY, content: old.content, sha256: old.sha256, sourceRev: "abc1234" },
    });
    expect(kept.status).toBe(201);
    const again = await call("POST", "/internal/revisions", {
      token: admin,
      body: { key: KEY, content: old.content, sha256: old.sha256, sourceRev: "abc1234" },
    });
    expect(again.status).toBe(201);
    const text = await call("GET", `/api/specs/${KEY}/revisions/${old.sha256}`, { token: agent, author: "spec-agent" });
    expect(text.status).toBe(200);
    expect(text.text).toBe(V1);

    const observed = await call("POST", "/internal/observe", { token: admin, body: {} });
    expect(observed.json.observed).toEqual([{ key: KEY, sha256: sha256(V2) }]);
    const parity = await call("GET", "/internal/parity", { token: admin });
    expect(parity.json.threads).toBe(1);
    expect(parity.json.inbox).toBe(1);
    expect(parity.json.documents[0].anchors[0]).toMatchObject({ id: 1, resolved: true, state: "carried", blockIndex: 0 });

    const shown = await call("GET", `/api/agent/threads/1`, { token: agent, author: "spec-agent" });
    expect(shown.json.thread.state).toBe("carried");
    expect(shown.json.thread.blockIndex).toBe(0);
    expect(shown.json.thread.source).toContain("Keep this paragraph");

    const clash = structuredClone(payload);
    clash.documents[0].threads[0].messages[0].body = "Replaced.";
    const refused = await call("POST", "/internal/import", { token: admin, body: clash });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("not_empty");
    expect((await call("GET", "/internal/parity", { token: admin })).json.threads).toBe(1);

    const forced = await call("POST", "/internal/import?force=1", { token: admin, body: clash });
    expect(forced.status).toBe(201);
    expect(forced.json.idempotent).toBe(false);
    const replaced = await call("GET", `/api/agent/threads/1`, { token: agent, author: "spec-agent" });
    expect(replaced.json.thread.messages[0].body).toBe("Replaced.");
    expect(replaced.json.thread.blockIndex).toBe(0);
    expect(await outboxCount()).toBe(0);
  });
});

function exportOf() {
  const anchor = markdownBlock({ tokenize: blockTokens }).create(
    { seq: null, sha256: sha256(V1), content: V1, meta: {} },
    { blockIndex: 0, quote: "Keep this" },
  );
  return {
    version: 1,
    documents: [
      {
        id: 1,
        type: "mdview.doc",
        key: KEY,
        createdAt: "2026-11-25T00:00:00.000Z",
        revisions: [
          revision(1, 1, V1),
          revision(2, 2, V2),
        ],
        threads: [
          {
            id: 1,
            revisionId: 1,
            anchorType: "markdown.block",
            anchor: anchor.anchor,
            quote: anchor.quote,
            status: "open",
            statusBy: null,
            statusAt: null,
            createdAt: "2026-11-25T00:00:01.000Z",
            messages: [
              message(1, 1, "human", "Does this stay?", "2026-11-25T00:00:01.000Z"),
              message(2, 2, "agent", "Yes.", "2026-11-25T00:00:02.000Z"),
            ],
          },
        ],
      },
    ],
  };
}

function revision(id, seq, content) {
  return { id, seq, sha256: sha256(content), content, meta: {}, observedAt: "2026-11-25T00:00:00.000Z" };
}

function message(id, revisionId, kind, body, at) {
  return {
    id,
    revisionId,
    author: kind === "human" ? "neil" : "spec-agent",
    authorKind: kind,
    session: null,
    body,
    createdAt: at,
    sentAt: at,
  };
}

async function call(method, pathname, { token, author, body } = {}) {
  const headers = new Headers();
  if (token) headers.set("Cf-Access-Jwt-Assertion", token);
  if (author) headers.set("X-Mdview-Author", author);
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers.set("content-type", "application/json");
    headers.set("origin", HOST);
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
  return { status: response.status, json, text };
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

async function outboxCount() {
  let n = 0;
  await runInDurableObject(env.STORE.get(env.STORE.idFromName("store")), async (_instance, state) => {
    n = Number(state.storage.sql.exec("SELECT count(*) AS n FROM mdview_outbox").toArray()[0].n);
  });
  return n;
}
