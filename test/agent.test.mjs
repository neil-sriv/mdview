import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FsAssets } from "../lib/assets.mjs";
import { handle } from "../lib/app.mjs";
import { remoteDocKey, runComments } from "../lib/comments-cli.mjs";
import { FsDocSource } from "../lib/docs.mjs";
import { toRequest, writeNodeResponse } from "../lib/server.mjs";
import { startServer } from "../lib/server.mjs";
import { openAsyncStore, openStore } from "../lib/store.mjs";

const AGENT = { kind: "agent", author: "spec-agent", session: null };
const HUMAN = { kind: "human", author: "adam", session: null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let root;
let home;
let store;
let docs;

async function call(method, pathname, body, { identity = AGENT, headers = {} } = {}) {
  const head = new Headers(headers);
  let payload;
  if (body !== undefined) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    if (!head.has("content-type")) head.set("content-type", "application/json");
  }
  const request = new Request(`http://127.0.0.1${pathname}`, { method, headers: head, body: payload });
  const response = await handle(request, {
    docs,
    assets: new FsAssets(),
    store,
    identity,
    initial: "notes/plan.md",
    allowedHosts: null,
  });
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

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-agent-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-agent-home-"));
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.writeFile(path.join(root, "notes", "plan.md"), "# Plan\n\nKeep this paragraph.\n");
  await fs.writeFile(path.join(root, "notes", "draft.md"), "A drafted line.\n");
  await fs.writeFile(path.join(root, "notes", "quiet.md"), "Nothing here yet.\n");
  docs = new FsDocSource(root);
  store = await openAsyncStore(home);
});

after(async () => {
  await store.close();
});

test("remote doc args accept a project key or the vault specs path", () => {
  assert.equal(remoteDocKey("agent-brain/plan.md"), "agent-brain/plan.md");
  assert.equal(remoteDocKey("projects/agent-brain/specs/plan.md"), "agent-brain/plan.md");
  assert.equal(remoteDocKey("projects/agent-brain/specs/sub/plan.md"), "agent-brain/sub/plan.md");
  assert.equal(remoteDocKey("/home/box/vault/projects/agent-brain/specs/plan.md"), "agent-brain/plan.md");
  assert.equal(remoteDocKey("projects/agent-brain/specs"), "agent-brain");
  assert.equal(remoteDocKey("projects/agent-brain/specs/"), "agent-brain");
});

test("an agent opens a thread, and a replayed requestId does not open another", async () => {
  const body = { path: "notes/plan.md", line: 1, message: "Is the title right?", requestId: "create-1" };
  const created = await call("POST", "/api/agent/threads", body);
  const replay = await call("POST", "/api/agent/threads", body);
  const listed = await call("GET", "/api/agent/threads?scope=notes/plan.md&all=1");

  assert.equal(created.status, 201);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.json, created.json);
  assert.equal(listed.json.threads.length, 1);
  assert.equal(listed.json.threads[0].thread.messages[0].body, "Is the title right?");
  assert.equal(listed.json.threads[0].document, "notes/plan.md");
  assert.equal(listed.json.threads[0].thread.pending, false);
});

test("a replayed reply returns the first result and does not write again", async () => {
  const created = await call("POST", "/api/agent/threads", {
    path: "notes/plan.md",
    quote: "Keep this",
    message: "Keep it?",
    requestId: "create-reply",
  });
  const id = created.json.id;
  const reply = { message: "Yes.", requestId: "reply-1" };
  const first = await call("POST", `/api/agent/threads/${id}/reply`, reply);
  const second = await call("POST", `/api/agent/threads/${id}/reply`, reply);
  const shown = await call("GET", `/api/agent/threads/${id}`);

  assert.deepEqual(first.json, { id });
  assert.deepEqual(second.json, { id });
  assert.deepEqual(
    shown.json.thread.messages.map((m) => m.body),
    ["Keep it?", "Yes."],
  );
  assert.equal(shown.json.revision.sha256.length, 64);
  assert.equal(shown.json.revision.latestSeq, shown.json.revision.seq);
});

test("apply is all or none, and replaying it does not apply again", async () => {
  const created = await call("POST", "/api/agent/threads", {
    path: "notes/plan.md",
    line: 3,
    message: "About the paragraph.",
    requestId: "create-apply",
  });
  const id = created.json.id;
  const bad = await call("POST", "/api/agent/apply", {
    requestId: "apply-bad",
    actions: [
      { reply: id, message: "one" },
      { suggestResolve: id, message: "two" },
      { reply: 999999, message: "missing" },
    ],
  });
  const afterBad = await call("GET", `/api/agent/threads/${id}`);

  assert.equal(bad.status, 404);
  assert.equal(afterBad.json.thread.status, "open");
  assert.deepEqual(afterBad.json.thread.messages.map((m) => m.body), ["About the paragraph."]);

  const actions = [
    { reply: id, message: "Reworded it." },
    { suggestResolve: id, message: "The paragraph now says what it means." },
  ];
  const applied = await call("POST", "/api/agent/apply", { requestId: "apply-ok", actions });
  const replay = await call("POST", "/api/agent/apply", { requestId: "apply-ok", actions });
  const after = await call("GET", `/api/agent/threads/${id}`);

  assert.deepEqual(applied.json, { applied: 2 });
  assert.deepEqual(replay.json, { applied: 2 });
  assert.equal(after.json.thread.status, "suggested");
  assert.equal(after.json.thread.messages.filter((m) => m.body === "Reworded it.").length, 1);
});

test("agents get 403 for resolve, reopen, delete and batch", async () => {
  const created = await call("POST", "/api/agent/threads", {
    path: "notes/plan.md",
    line: 1,
    message: "Do not let an agent close this.",
    requestId: "create-forbidden",
  });
  const id = created.json.id;
  const shown = await call("GET", `/api/agent/threads/${id}`);
  const messageId = shown.json.thread.messages[0].id;
  const forbidden = [
    ["/api/comments/batch/send", "send a batch"],
    ["/api/comments/batch/discard", "discard a batch"],
    [`/api/comments/${id}/status`, "resolve or reopen"],
    [`/api/comments/${id}/delete`, "delete a thread"],
    [`/api/comments/${id}/messages/${messageId}/delete`, "delete a message"],
  ];
  for (const [pathname, why] of forbidden) {
    const res = await call("POST", pathname, { status: "resolved", body: "no" });
    assert.equal(res.status, 403, pathname);
    assert.match(res.json.error, new RegExp(why), pathname);
  }
  const still = await call("GET", `/api/agent/threads/${id}`);
  assert.equal(still.json.thread.status, "open");
  assert.equal(still.json.thread.messages.length, 1);
});

test("a human cannot call the agent API", async () => {
  const res = await call("GET", "/api/agent/threads?scope=notes/plan.md", undefined, { identity: HUMAN });

  assert.equal(res.status, 403);
});

test("agent writes are JSON and at most 64 KiB", async () => {
  const form = await call("POST", "/api/agent/threads", "path=notes/plan.md", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const huge = await call("POST", "/api/agent/threads", {
    path: "notes/plan.md",
    line: 1,
    message: "x".repeat(70 * 1024),
    requestId: "too-big",
  });
  const emptyId = await call("POST", "/api/agent/threads", { path: "notes/plan.md", line: 1, message: "hi", requestId: " " });

  assert.equal(form.status, 415);
  assert.equal(huge.status, 413);
  assert.equal(emptyId.status, 400);
});

test("a human write over 64 KiB is 413 on the Mac server too", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-too-big-"));
  const localHome = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-too-big-home-"));
  await fs.writeFile(path.join(dir, "note.md"), "Hi.\n");
  const local = await openStore(localHome);
  const { server, port } = await startServer({ root: dir, port: 49221, store: local });
  try {
    const payload = JSON.stringify({ path: "note.md", sha: "x", blockIndex: 0, body: "y".repeat(70 * 1024) });
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/comments",
          method: "POST",
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    assert.equal(res, 413);
  } finally {
    server.closeAllConnections();
    server.close();
    local.close();
  }
});

test("pending human comments stay out of the agent API", async () => {
  const doc = await docs.resolve("notes/draft.md");
  const content = await docs.readText(doc.file);
  await store.createThread({
    file: doc.key,
    content,
    line: 1,
    body: "secret draft",
    author: { name: "adam", kind: "human" },
    pending: true,
  });
  const listed = await call("GET", "/api/agent/threads?scope=notes/draft.md&all=1");

  assert.deepEqual(listed.json.threads, []);
});

test("wait returns the threads that are waiting, or 204 when the timeout passes", async () => {
  const none = await call("GET", "/api/agent/wait?scope=notes/quiet.md&timeout=0");
  assert.equal(none.status, 204);

  // An agent's own new thread waits on the human, so it must not wake `wait`.
  // A human's message does. The listener is in place before that message is written.
  const original = store.onWrite.bind(store);
  let listening = false;
  store.onWrite = (listener) => {
    listening = true;
    return original(listener);
  };
  const pending = call("GET", "/api/agent/wait?scope=notes/quiet.md&timeout=2&after=0");
  try {
    const started = Date.now();
    while (!listening) {
      if (Date.now() - started > 1000) throw new Error("wait never started listening");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const doc = await docs.resolve("notes/quiet.md");
    await store.createThread({
      file: doc.key,
      content: await docs.readText(doc.file),
      line: 1,
      body: "Now it waits.",
      author: { name: "adam", kind: "human" },
    });
    const woke = await pending;
    assert.equal(woke.status, 200);
    assert.equal(woke.json.threads.length, 1);
    assert.equal(woke.json.threads[0].thread.messages[0].body, "Now it waits.");
  } finally {
    store.onWrite = original;
  }

  const again = await call("GET", "/api/agent/wait?scope=notes/quiet.md&timeout=0");
  assert.equal(again.status, 200);
  assert.equal((await call("GET", "/api/agent/wait?scope=notes/quiet.md&timeout=56")).status, 400);
  assert.equal((await call("GET", "/api/agent/threads")).status, 400);
});

test("mdview comments talks to the handler when MDVIEW_URL is set", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-remote-"));
  const remoteHome = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-remote-home-"));
  await fs.mkdir(path.join(dir, "agent-brain"), { recursive: true });
  await fs.writeFile(path.join(dir, "agent-brain", "plan.md"), "Plan the rollout.\n");
  await fs.writeFile(path.join(dir, "agent-brain", "other.md"), "Other paragraph.\n");
  await fs.writeFile(path.join(dir, "agent-brain", "quiet.md"), "Quiet.\n");
  const remoteStore = await openAsyncStore(remoteHome);
  const remoteDocs = new FsDocSource(dir);
  const seen = [];
  const server = http.createServer(async (req, res) => {
    seen.push({
      url: req.url,
      id: req.headers["cf-access-client-id"] ?? null,
      secret: req.headers["cf-access-client-secret"] ?? null,
      author: req.headers["x-mdview-author"] ?? null,
    });
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const request = toRequest(req, controller.signal);
      const response = await handle(request, {
        docs: remoteDocs,
        assets: new FsAssets(),
        store: remoteStore,
        initial: "",
        allowedHosts: null,
        identity: { kind: "agent", author: request.headers.get("x-mdview-author") || "agent", session: null },
      });
      await writeNodeResponse(res, response);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(String(err?.stack ?? err));
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  async function comments(args) {
    let out = "";
    let err = "";
    const status = await runComments(args, {
      out: { write: (chunk) => (out += chunk) },
      err: { write: (chunk) => (err += chunk) },
      env: {
        ...process.env,
        MDVIEW_URL: url,
        MDVIEW_HOME: remoteHome,
        MDVIEW_AUTHOR: "spec-agent",
        MDVIEW_ACCESS_CLIENT_ID: "client-id",
        MDVIEW_ACCESS_CLIENT_SECRET: "client-secret",
      },
    });
    return { status, out, err };
  }

  try {
    const vault = await comments(["add", "projects/agent-brain/specs/plan.md", "--line", "1", "-m", "from the vault path"]);
    const key = await comments(["add", "agent-brain/other.md", "--quote", "Other", "-m", "from the project key"]);
    assert.equal(vault.status, 0, vault.err);
    assert.equal(key.status, 0, key.err);
    assert.match(vault.out, /Started thread #\d+ on line 1 of agent-brain\/plan\.md/);
    assert.match(key.out, /Started thread #\d+ on line 1 of agent-brain\/other\.md/);

    const posts = seen.filter((hit) => hit.url === "/api/agent/threads");
    assert.ok(posts.length >= 2);
    for (const hit of posts) {
      assert.equal(hit.id, "client-id");
      assert.equal(hit.secret, "client-secret");
      assert.equal(hit.author, "spec-agent");
    }

    const db = new DatabaseSync(path.join(remoteHome, "peanut.sqlite3"), { readOnly: true });
    const ids = db.prepare("SELECT id FROM mdview_requests").all().map((row) => row.id);
    db.close();
    assert.ok(ids.length >= 2);
    for (const id of ids) assert.match(id, UUID);
    assert.equal(new Set(ids).size, ids.length);

    const listed = await comments(["list", "projects/agent-brain/specs", "--json"]);
    const threads = JSON.parse(listed.out).flatMap((doc) => doc.threads);
    assert.equal(listed.status, 0, listed.err);
    assert.deepEqual(
      threads.map((t) => t.messages[0].body).sort(),
      ["from the project key", "from the vault path"],
    );

    const id = String(threads.find((t) => t.messages[0].body === "from the vault path").id);
    const replied = await comments(["reply", id, "-m", "Noted."]);
    const suggested = await comments(["suggest-resolve", id, "-m", "Wrote it down."]);
    assert.equal(replied.status, 0, replied.err);
    assert.match(replied.out, new RegExp(`Replied to #${id}`));
    assert.match(suggested.out, /suggested resolved · waiting on human/);

    const refused = await comments(["resolve", id]);
    assert.equal(refused.status, 1);
    assert.match(refused.err, /Only a human may resolve/);
    const asHuman = await comments(["resolve", id, "--human"]);
    assert.equal(asHuman.status, 1);
    assert.match(asHuman.err, /agent token/);

    const other = await remoteDocs.resolve("agent-brain/other.md");
    await remoteStore.createThread({
      file: other.key,
      content: await remoteDocs.readText(other.file),
      line: 1,
      body: "A human question.",
      author: { name: "adam", kind: "human" },
    });
    const waiting = await comments(["wait", "agent-brain/other.md", "--timeout", "5s"]);
    assert.equal(waiting.status, 0, waiting.err);
    assert.match(waiting.out, /A human question/);
    assert.doesNotMatch(waiting.out, /waiting for comments/);

    const quiet = await comments(["wait", "agent-brain/quiet.md", "--timeout", "1s"]);
    assert.equal(quiet.status, 3);
    assert.match(quiet.out, /Nothing waited on the agent in agent-brain\/quiet\.md after 1s/);
  } finally {
    server.closeAllConnections();
    server.close();
    await remoteStore.close();
  }
});
