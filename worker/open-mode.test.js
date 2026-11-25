import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "./index.js";

// AUTH_MODE=open: no Access in front. Unkeyed requests are Neil, bearer keys
// pick agent, backup and admin, and /internal/ always needs the admin key.
const HOST = "https://specs.neilsriv.tech";
const KEY = "demo/note.md";
const DOC = "Keep this paragraph.\n";
const OPEN = {
  ...env,
  AUTH_MODE: "open",
  HUMAN_EMAILS: "neil.srivastava1@gmail.com,neil@neilsriv.tech",
  AGENT_KEY: "agent-key",
  BACKUP_KEY: "backup-key",
  ADMIN_KEY: "admin-key",
};

beforeEach(async () => {
  const listed = await env.BUCKET.list();
  await Promise.all(listed.objects.map((object) => env.BUCKET.delete(object.key)));
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(DOC));
  const sha = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await env.BUCKET.put(`specs/${KEY}`, DOC, { customMetadata: { sha256: sha, mtimeMs: "1700000000000" } });
});

describe("open mode", () => {
  it("serves the UI and reads to an unkeyed caller as the first human email, with no Access redirect", async () => {
    const root = await call("GET", "/", { headers: { accept: "text/html" } });
    const page = await call("GET", `/view/${KEY}`, { headers: { accept: "text/html" } });
    const head = await call("HEAD", `/view/${KEY}`);
    const info = await call("GET", "/api/info");
    const list = await call("GET", "/api/specs");

    expect(root.status).toBe(302);
    expect(root.location).toMatch(/^\/view\//);
    expect(page.status).toBe(200);
    expect(head.status).not.toBe(302);
    expect(info.status).toBe(200);
    expect(info.text).toContain("neil.srivastava1@gmail.com");
    expect(list.status).toBe(200);
  });

  it("locks /internal/ behind the admin key", async () => {
    expect((await call("GET", "/internal/parity")).status).toBe(401);
    expect((await call("GET", "/internal/parity", { key: "wrong" })).status).toBe(401);
    expect((await call("GET", "/internal/parity", { key: "agent-key", agent: "specs" })).status).toBe(403);
    expect((await call("GET", "/internal/parity", { key: "backup-key" })).status).toBe(403);
    expect((await call("GET", "/internal/parity", { key: "admin-key" })).status).toBe(200);
    expect((await call("POST", "/internal/import", { key: "backup-key", body: {} })).status).toBe(403);
  });

  it("keeps the admin key off everything else and the backup key on spec reads", async () => {
    expect((await call("GET", "/api/info", { key: "admin-key" })).status).toBe(403);
    expect((await call("GET", "/api/specs", { key: "backup-key" })).status).toBe(200);
    expect((await call("GET", `/api/specs/${KEY}`, { key: "backup-key" })).status).toBe(200);
    expect((await call("GET", "/api/info", { key: "backup-key" })).status).toBe(403);
    const put = await call("PUT", `/api/specs/${KEY}`, { key: "backup-key", body: { content: "x\n", requestId: "b" } });
    expect(put.status).toBe(403);
  });

  it("makes an agent only from the agent key, named by X-Mdview-Agent", async () => {
    const named = await call("GET", `/api/agent/threads?scope=${KEY}`, { key: "agent-key", agent: "specs" });
    const unnamed = await call("GET", `/api/agent/threads?scope=${KEY}`, { key: "agent-key" });
    const human = await call("GET", `/api/agent/threads?scope=${KEY}`, { agent: "specs" });

    expect(named.status).toBe(200);
    expect(unnamed.status).toBe(400);
    expect(human.status).toBe(403);
  });

  it("leaves access mode as the default", async () => {
    const unset = { ...OPEN };
    delete unset.AUTH_MODE;
    expect((await call("GET", "/api/info", { env: unset })).status).toBe(401);
  });
});

async function call(method, pathname, { key, agent, body, headers: extra = {}, env: bindings = OPEN } = {}) {
  const headers = new Headers(extra);
  if (key) headers.set("Authorization", `Bearer ${key}`);
  if (agent) headers.set("X-Mdview-Agent", agent);
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers.set("content-type", "application/json");
    headers.set("origin", HOST);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${HOST}${pathname}`, { method, headers, body: payload }), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, location: response.headers.get("location"), text: await response.text() };
}
