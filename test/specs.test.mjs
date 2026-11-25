import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { sha256 } from "peanut/anchors/markdown-block";
import { FsAssets } from "../lib/assets.mjs";
import { handle } from "../lib/app.mjs";
import { FsDocSource } from "../lib/docs.mjs";
import { runSpecs } from "../lib/specs-cli.mjs";
import { toRequest, writeNodeResponse } from "../lib/server.mjs";
import { openAsyncStore } from "../lib/store.mjs";

const AGENT = { kind: "agent", author: "spec-agent", session: null };
const HUMAN = { kind: "human", author: "neil", session: null };
const BACKUP = { kind: "backup", author: "backup", session: null };

let root;
let home;
let store;
let docs;

async function call(method, pathname, { body, identity = AGENT, headers = {}, raw } = {}) {
  const head = new Headers(headers);
  let payload;
  if (body !== undefined) {
    payload = raw ? body : JSON.stringify(body);
    if (!head.has("content-type")) head.set("content-type", "application/json");
  }
  const request = new Request(`http://127.0.0.1${pathname}`, { method, headers: head, body: payload });
  const response = await handle(request, {
    docs,
    assets: new FsAssets(),
    store,
    identity,
    initial: "",
    allowedHosts: new Set(["127.0.0.1"]),
    publicOrigin: identity.kind === "human" ? "http://127.0.0.1" : undefined,
  });
  const text = await response.text();
  let json = null;
  if (text && (response.headers.get("content-type") ?? "").includes("json")) json = JSON.parse(text);
  return { status: response.status, json, text, etag: response.headers.get("etag") };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-specs-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-specs-home-"));
  docs = new FsDocSource(root);
  store = await openAsyncStore(home);
});

after(async () => {
  await store.close();
});

test("two saves with the same If-Match give one 200 and one 412, and both texts stay readable", async () => {
  const created = await call("POST", "/api/specs", {
    body: { key: "agent-brain/plan.md", content: "Keep this paragraph.\n", requestId: "spec-new" },
  });
  assert.equal(created.status, 201);
  const first = created.json.sha256;
  assert.equal(created.etag, `"${first}"`);
  assert.equal(await fs.readFile(path.join(root, "agent-brain", "plan.md"), "utf8"), "Keep this paragraph.\n");

  const again = await call("POST", "/api/specs", {
    body: { key: "agent-brain/plan.md", content: "nope\n", requestId: "spec-new-2" },
  });
  assert.equal(again.status, 409);

  const next = "Keep this paragraph.\n\nA new line.\n";
  const [won, lost] = await Promise.all([
    call("PUT", "/api/specs/agent-brain/plan.md", { body: { content: next, requestId: "spec-put-a" }, headers: { "if-match": `"${first}"` } }),
    call("PUT", "/api/specs/agent-brain/plan.md", { body: { content: "Keep this paragraph.\n\nOther.\n", requestId: "spec-put-b" }, headers: { "if-match": `"${first}"` } }),
  ]);
  const ok = [won, lost].filter((res) => res.status === 200);
  const stale = [won, lost].filter((res) => res.status === 412);
  assert.equal(ok.length, 1);
  assert.equal(stale.length, 1);
  assert.deepEqual(stale[0].json.current.sha256, ok[0].json.sha256);
  assert.equal(stale[0].json.current.content, ok[0].json.sha256 === sha256(next) ? next : "Keep this paragraph.\n\nOther.\n");

  const winner = ok[0].json.sha256;
  const old = await call("GET", `/api/specs/agent-brain/plan.md/revisions/${first}`);
  const saved = await call("GET", `/api/specs/agent-brain/plan.md/revisions/${winner}`);
  assert.equal(old.status, 200);
  assert.equal(old.text, "Keep this paragraph.\n");
  assert.equal(saved.text, await fs.readFile(path.join(root, "agent-brain", "plan.md"), "utf8"));

  const listed = await call("GET", "/api/specs/agent-brain/plan.md/revisions");
  assert.deepEqual(listed.json.revisions.map((rev) => rev.sha256).slice(0, 2), [winner, first]);

  const replay = await call("PUT", "/api/specs/agent-brain/plan.md", {
    body: { content: "entirely different\n", requestId: ok[0] === won ? "spec-put-a" : "spec-put-b" },
    headers: { "if-match": `"${first}"` },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.sha256, winner);
  assert.equal(await fs.readFile(path.join(root, "agent-brain", "plan.md"), "utf8"), saved.text);
});

test("a save needs If-Match, a bad key is refused, and a backup token cannot write", async () => {
  const missing = await call("PUT", "/api/specs/agent-brain/plan.md", { body: { content: "x\n", requestId: "no-match" } });
  const bad = await call("POST", "/api/specs", { body: { key: "../etc/passwd", content: "x\n", requestId: "bad-key" } });
  const backup = await call("PUT", "/api/specs/agent-brain/plan.md", {
    identity: BACKUP,
    body: { content: "x\n", requestId: "backup" },
    headers: { "if-match": '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
  });
  const form = await call("POST", "/api/specs", { body: "key=a", raw: true, headers: { "content-type": "text/plain" } });

  assert.equal(missing.status, 428);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "bad_key");
  assert.equal(backup.status, 403);
  assert.equal(form.status, 415);
});

test("a thread made before an edit still shows its excerpt, and move keeps the thread", async () => {
  const content = "Anchor this paragraph.\n";
  const file = path.join(root, "agent-brain", "anchor.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  const opened = await call("GET", "/api/specs/agent-brain/anchor.md");
  const id = await store.createThread({
    file: docs.readSpec("agent-brain/anchor.md").storeKey,
    content,
    quote: "Anchor this",
    body: "Please keep this.",
    author: { name: "neil", kind: "human" },
  });
  const edited = "Anchor this paragraph.\n\nAdded later.\n";
  const saved = await call("PUT", "/api/specs/agent-brain/anchor.md", {
    body: { content: edited, requestId: "anchor-put" },
    headers: { "if-match": opened.etag },
  });
  assert.equal(saved.status, 200, saved.text);
  const thread = await store.thread(id);
  assert.equal(thread.thread.source, "Anchor this paragraph.");
  assert.notEqual(thread.thread.state, "outdated");
  const old = await call("GET", `/api/specs/agent-brain/anchor.md/revisions/${opened.etag.slice(1, -1)}`);
  assert.equal(old.text, content);

  const moved = await call("POST", "/api/specs/agent-brain/anchor.md/move", {
    body: { to: "agent-brain/archive/anchor.md", requestId: "anchor-move" },
    headers: { "if-match": saved.etag },
  });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(await store.docOf(id), docs.readSpec("agent-brain/archive/anchor.md").storeKey);
  assert.equal((await store.thread(id)).thread.source, "Anchor this paragraph.");
  const clash = await call("POST", "/api/specs/agent-brain/archive/anchor.md/move", {
    body: { to: "agent-brain/plan.md", requestId: "anchor-clash" },
    headers: { "if-match": saved.etag },
  });
  assert.equal(clash.status, 409);
});

test("an agent still cannot resolve, and a human save needs the page Origin", async () => {
  const id = await store.createThread({
    file: docs.readSpec("agent-brain/plan.md").storeKey,
    content: await fs.readFile(path.join(root, "agent-brain", "plan.md"), "utf8"),
    line: 1,
    body: "A human note.",
    author: { name: "neil", kind: "human" },
  });
  const resolved = await call("POST", `/api/comments/${id}/status`, { body: { status: "resolved" } });
  const batch = await call("POST", "/api/comments/batch/send", { body: {} });
  const offsite = await call("PUT", "/api/specs/agent-brain/plan.md", {
    identity: HUMAN,
    body: { content: "hijack\n", requestId: "human-origin" },
    headers: { "if-match": (await call("GET", "/api/specs/agent-brain/plan.md")).etag, origin: "https://evil.example" },
  });

  assert.equal(resolved.status, 403);
  assert.equal(batch.status, 403);
  assert.equal(offsite.status, 403);
  assert.equal((await store.thread(id)).thread.status, "open");
});

test("mdview specs get remembers the ETag and put sends it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-specs-cli-"));
  const cliHome = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-specs-cli-home-"));
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const request = toRequest(req, controller.signal);
    const response = await handle(request, {
      docs,
      assets: new FsAssets(),
      store,
      identity: { kind: "agent", author: request.headers.get("x-mdview-author") || "agent", session: null },
      initial: "",
      allowedHosts: null,
    });
    await writeNodeResponse(res, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const env = {
    ...process.env,
    MDVIEW_URL: `http://127.0.0.1:${port}/`,
    MDVIEW_HOME: cliHome,
    MDVIEW_AUTHOR: "spec-agent",
    MDVIEW_ACCESS_CLIENT_ID: "client-id",
    MDVIEW_ACCESS_CLIENT_SECRET: "client-secret",
  };
  async function specs(args) {
    let out = "";
    let err = "";
    const status = await runSpecs(args, {
      out: { write: (chunk) => (out += chunk) },
      err: { write: (chunk) => (err += chunk) },
      env,
    });
    return { status, out, err };
  }
  try {
    const file = path.join(dir, "fresh.md");
    await fs.writeFile(file, "Fresh text.\n");
    const created = await specs(["new", "agent-brain/fresh.md", file]);
    assert.equal(created.status, 0, created.err);
    const got = await specs(["get", "agent-brain/fresh.md"]);
    assert.equal(got.status, 0, got.err);
    assert.equal(got.out, "Fresh text.\n");
    const etags = JSON.parse(await fs.readFile(path.join(cliHome, "etags.json"), "utf8"));
    assert.equal(etags["agent-brain/fresh.md"], sha256("Fresh text.\n"));

    await fs.writeFile(file, "Fresh text.\n\nMore.\n");
    const saved = await specs(["put", "agent-brain/fresh.md", file]);
    assert.equal(saved.status, 0, saved.err);
    const current = JSON.parse(await fs.readFile(path.join(cliHome, "etags.json"), "utf8"))["agent-brain/fresh.md"];
    await call("PUT", "/api/specs/agent-brain/fresh.md", {
      body: { content: "Fresh text.\n\nFrom someone else.\n", requestId: "someone-else" },
      headers: { "if-match": `"${current}"` },
    });
    const stale = await specs(["put", "agent-brain/fresh.md", file]);
    assert.equal(stale.status, 3, stale.err);
    assert.match(stale.out, /From someone else/);
    const revs = await specs(["revisions", "agent-brain/fresh.md"]);
    assert.match(revs.out, new RegExp(sha256("Fresh text.\n")));
    const listed = await specs(["list"]);
    assert.equal(listed.status, 0, listed.err);
    assert.match(listed.out, /agent-brain\/fresh\.md/);
    let denied = "";
    const noUrl = await runSpecs(["list"], {
      out: { write() {} },
      err: { write: (chunk) => (denied += chunk) },
      env: { ...env, MDVIEW_URL: "" },
    });
    assert.equal(noUrl, 2);
    assert.match(denied, /MDVIEW_URL/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
