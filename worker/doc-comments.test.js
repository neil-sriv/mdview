import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "./index.js";

// /api/doc?comments=1 answers the doc and its threads in one round trip.
const HOST = "https://specs.neilsriv.tech";
const KEY = "demo/threads.md";
const DOC = "# Threads\n\nKeep this paragraph.\n";
const OPEN = { ...env, AUTH_MODE: "open", HUMAN_EMAILS: "neil@neilsriv.tech" };

beforeEach(async () => {
  const listed = await env.BUCKET.list();
  await Promise.all(listed.objects.map((object) => env.BUCKET.delete(object.key)));
  const created = await call("POST", "/api/specs", { key: KEY, content: DOC, requestId: "seed-threads" });
  expect(created.status).toBe(201);
});

describe("doc with comments", () => {
  it("carries the same threads and pending count /api/comments gives", async () => {
    const plain = (await call("GET", `/api/doc?path=${KEY}`)).json;
    const posted = await call("POST", "/api/comments", { path: KEY, sha: plain.sha, blockIndex: 1, quote: "Keep", start: 0, body: "Why **this**?", requestId: "c1" });
    expect(posted.status).toBe(201);

    const both = (await call("GET", `/api/doc?path=${KEY}&comments=1`)).json;
    const separate = (await call("GET", `/api/comments?path=${KEY}&sha=${plain.sha}`)).json;
    expect(plain.comments).toBeUndefined();
    expect(both.sha).toBe(plain.sha);
    expect(both.html).toBe(plain.html);
    expect(both.comments).toEqual(separate);
    expect(both.comments.threads.map((t) => t.quote)).toEqual(["Keep"]);
    expect(both.comments.threads[0].messages[0].bodyHtml).toContain("<strong>this</strong>");
    expect(typeof both.comments.pendingCount).toBe("number");
    expect(typeof both.changeToken).toBe("string");
  });
});

async function call(method, pathname, body) {
  const headers = new Headers();
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
