import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "./index.js";

// The service worker's offline sync reads /api/docs. On the Worker it lists R2,
// not a disk, and each entry's etag is the spec's sha256.
const HOST = "https://specs.neilsriv.tech";
const OPEN = { ...env, AUTH_MODE: "open", HUMAN_EMAILS: "neil@neilsriv.tech" };

beforeEach(async () => {
  const listed = await env.BUCKET.list();
  await Promise.all(listed.objects.map((object) => env.BUCKET.delete(object.key)));
});

describe("/api/docs on the Worker", () => {
  it("lists every spec with its sha as the etag, and changes only the edited one's", async () => {
    for (const key of ["alpha/one.md", "beta/two.md"]) expect((await call("POST", "/api/specs", { key, content: `# ${key}\n`, requestId: key })).status).toBe(201);
    const before = (await call("GET", "/api/docs")).json;
    expect(before.docs.map((d) => d.path)).toEqual(["alpha/one.md", "beta/two.md"]);
    expect(before.images).toEqual([]);
    expect(before.imageBytes).toBeGreaterThan(0);
    const one = (await call("GET", "/api/doc?path=alpha/one.md")).json;
    expect(before.docs[0].etag).toBe(one.sha);

    const put = await call("PUT", "/api/specs/beta/two.md", { content: "# changed\n", requestId: "edit" }, { "If-Match": `"${before.docs[1].sha}"` });
    expect(put.status).toBe(200);
    const after = (await call("GET", "/api/docs")).json;
    expect(after.docs[0].etag).toBe(before.docs[0].etag);
    expect(after.docs[1].etag).not.toBe(before.docs[1].etag);
  });
});

async function call(method, pathname, body, extra = {}) {
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
