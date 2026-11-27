import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "./index.js";

// Server-side caching: a rendered doc is reused by sha, JSON reads revalidate
// with an ETag, and /api/ answers say where their time went.
const HOST = "https://specs.neilsriv.tech";
const KEY = "demo/cache.md";
const OPEN = { ...env, AUTH_MODE: "open", ALLOW_ANONYMOUS_HUMAN: "1", HUMAN_EMAILS: "neil@neilsriv.tech" };

beforeEach(async () => {
  const listed = await env.BUCKET.list();
  await Promise.all(listed.objects.map((object) => env.BUCKET.delete(object.key)));
  expect((await call("POST", "/api/specs", { body: { key: KEY, content: "# Cache\n\n```js\nconst a = 1;\n```\n", requestId: `seed-${Math.random()}` } })).status).toBe(201);
});

describe("server caching", () => {
  it("renders a doc once per sha, and renders again after an edit", async () => {
    const first = await call("GET", `/api/doc?path=${KEY}`);
    const second = await call("GET", `/api/doc?path=${KEY}`);
    expect(second.json.html).toBe(first.json.html);
    expect(second.headers.get("server-timing")).toMatch(/render;desc="(memory|cache)"/);

    const put = await call("PUT", `/api/specs/${KEY}`, { body: { content: "# Cache\n\nEdited.\n", requestId: `edit-${Math.random()}` }, headers: { "If-Match": `"${first.json.sha}"` } });
    expect(put.status).toBe(200);
    const edited = await call("GET", `/api/doc?path=${KEY}`);
    expect(edited.json.html).toContain("Edited.");
    expect(edited.headers.get("server-timing")).toMatch(/render;desc="miss"/);
  });

  it("answers an unchanged JSON read with 304, and a changed one with the new body", async () => {
    for (const path of [`/api/doc?path=${KEY}&comments=1`, "/api/tree", "/api/info", `/api/comments?path=${KEY}`]) {
      const first = await call("GET", path);
      const tag = first.headers.get("etag");
      expect(tag, path).toMatch(/^W\/"[0-9a-f]{32}"$/);
      expect(first.headers.get("cache-control")).toBe("private, no-cache");
      const again = await call("GET", path, { headers: { "If-None-Match": tag } });
      expect(again.status, path).toBe(304);
      expect(again.text).toBe("");
    }
    const doc = await call("GET", `/api/doc?path=${KEY}&comments=1`);
    await call("POST", "/api/comments", { body: { path: KEY, sha: doc.json.sha, blockIndex: 0, quote: "Cache", start: 0, body: "new", requestId: `c-${Math.random()}` } });
    const changed = await call("GET", `/api/doc?path=${KEY}&comments=1`, { headers: { "If-None-Match": doc.headers.get("etag") } });
    expect(changed.status).toBe(200);
    expect(changed.json.comments.threads).toHaveLength(1);
  });

  it("says where an /api/ answer's time went, and leaves the page alone", async () => {
    const tree = await call("GET", "/api/tree");
    expect(tree.headers.get("server-timing")).toMatch(/r2;dur=\d+;desc="\d+ calls?"/);
    expect(tree.headers.get("server-timing")).toMatch(/total;dur=\d+/);
    expect((await call("GET", `/view/${KEY}`)).headers.get("server-timing")).toBeNull();
  });
});

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
  return { status: response.status, headers: response.headers, json, text };
}
