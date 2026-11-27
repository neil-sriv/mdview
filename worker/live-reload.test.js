import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { R2DocSource } from "./docs.js";
import worker from "./index.js";

// A preserved mtime must survive the read that fills the per-request memo, and an
// open /api/events stream must notice a later save. The stream holds one
// R2DocSource for the whole connection; a memo from when it opened used to
// freeze the mtime, so the page never reloaded.
const HOST = "https://specs.neilsriv.tech";
const KEY = "demo/live.md";
const OPEN = { ...env, AUTH_MODE: "open", HUMAN_EMAILS: "neil@neilsriv.tech" };
const PRESERVED = 1700000000000;

beforeEach(async () => {
  await env.BUCKET.delete(`specs/${KEY}`);
  await env.BUCKET.put(`specs/${KEY}`, "# Live\n", {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { sha256: "seed", mtimeMs: String(PRESERVED), updatedAt: "2020-01-01T00:00:00.000Z" },
  });
});

describe("live reload from R2", () => {
  it("keeps a preserved mtime after the body has been read", async () => {
    const docs = new R2DocSource(env.BUCKET);
    expect(await docs.readText(KEY)).toBe("# Live\n");
    expect(await docs.mtimeMs(KEY)).toBe(PRESERVED);
    const doc = await call("GET", `/api/doc?path=${KEY}`);
    expect(doc.status).toBe(200);
    expect(doc.json.mtimeMs).toBe(PRESERVED);
  });

  it("tells an open events stream when the spec is saved again", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${HOST}/api/events?path=${encodeURIComponent(KEY)}`), OPEN, ctx);
    expect(response.status).toBe(200);
    await env.BUCKET.put(`specs/${KEY}`, "# Live\n\nSaved.\n", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { sha256: "next", updatedAt: "2099-01-01T00:00:00.000Z", updatedBy: "test" },
    });
    const text = await readUntil(response, "event: change", 7000);
    await waitOnExecutionContext(ctx);
    expect(text).toContain("event: change");
    expect(text).toContain(String(Date.parse("2099-01-01T00:00:00.000Z")));
  });
});

async function readUntil(response, needle, ms) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => reader.cancel().catch(() => {}), ms);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes(needle)) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return buf;
}

async function call(method, pathname, { body, headers: extra = {} } = {}) {
  const headers = new Headers(extra);
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers.set("content-type", "application/json");
    headers.set("origin", HOST);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${HOST}${pathname}`, { method, headers, body: payload }), OPEN, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text };
}
