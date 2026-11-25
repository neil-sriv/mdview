import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FsAssets } from "../lib/assets.mjs";
import { handle } from "../lib/app.mjs";
import { pullVault } from "../lib/backup.mjs";
import { FsDocSource } from "../lib/docs.mjs";
import { runSpecs } from "../lib/specs-cli.mjs";
import { runStore } from "../lib/store-cli.mjs";
import { toRequest, writeNodeResponse } from "../lib/server.mjs";
import { openAsyncStore, openStore } from "../lib/store.mjs";
import { TransferError, exportStore, importInto, listVaultSpecs, openStoreDb, referencedRevisions, rekeyDocument, sha256Bytes } from "../lib/transfer.mjs";

const HUMAN = { name: "neil", kind: "human" };
const AGENT = { name: "spec-agent", kind: "agent", session: null };
const V1 = "Keep this paragraph.\n";
const V2 = "Keep this paragraph.\n\nAdded later.\n";

let root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-transfer-"));
});

async function makeVault() {
  const vault = await fs.mkdtemp(path.join(root, "vault-"));
  const specs = path.join(vault, "projects", "agent-brain", "specs");
  await fs.mkdir(path.join(specs, "archive"), { recursive: true });
  await fs.writeFile(path.join(specs, "cloudflare-hosting.md"), V1);
  await fs.writeFile(path.join(specs, "index.md"), "# Specs\n");
  await fs.writeFile(path.join(specs, "archive", "old.md"), "Archived.\n");
  await fs.writeFile(path.join(vault, "README.md"), "Not a spec.\n");
  return vault;
}

function commentOn(store, file, content, extra = {}) {
  return store.createThread({ file, content, quote: "Keep this", body: "Does this stay?", author: HUMAN, ...extra });
}

test("export keeps rows and rekeys a vault path to a spec key", async () => {
  const vault = await makeVault();
  const home = path.join(vault, "home");
  const store = await openStore(home);
  const file = path.join(vault, "projects", "agent-brain", "specs", "cloudflare-hosting.md");
  const index = path.join(vault, "projects", "agent-brain", "specs", "index.md");
  const archived = path.join(vault, "projects", "agent-brain", "specs", "archive", "old.md");
  const id = commentOn(store, file, V1);
  store.reply(id, "Yes.", AGENT);
  await fs.writeFile(file, V2);
  store.observe(file, V2);
  const pending = store.createThread({ file: index, content: "# Specs\n", blockIndex: 0, body: "Draft.", author: HUMAN, pending: true });
  commentOn(store, archived, "Archived.\n", { quote: "Archived" });
  const outside = path.join(vault, "README.md");
  store.createThread({ file: outside, content: "Not a spec.\n", blockIndex: 0, body: "No.", author: HUMAN });
  const placed = store.threadsAt(file, { includePending: true }).threads.find((thread) => thread.id === id);
  assert.equal(placed.state, "carried");
  assert.equal(placed.blockIndex, 0);
  store.close();

  const db = openStoreDb(path.join(home, "peanut.sqlite3"), { readOnly: true });
  assert.throws(() => exportStore(db, { rekey: (key) => rekeyDocument(key, vault) }), TransferError);
  db.close();

  const writable = await openStore(home);
  writable.deleteThread(writable.threadsAt(outside).threads[0].id, HUMAN);
  writable.close();

  const again = openStoreDb(path.join(home, "peanut.sqlite3"), { readOnly: true });
  const payload = exportStore(again, { rekey: (key) => rekeyDocument(key, vault) });
  again.close();

  const doc = payload.documents.find((item) => item.key === "agent-brain/cloudflare-hosting.md");
  assert.equal(payload.version, 1);
  assert.ok(doc.revisions.length >= 2);
  assert.equal(doc.threads[0].id, id);
  assert.equal(doc.threads[0].anchor.blockSha.length, 64);
  assert.equal(doc.threads[0].messages.length, 2);
  assert.equal(doc.threads[0].messages[1].authorKind, "agent");
  assert.ok(payload.documents.some((item) => item.key === "agent-brain/index.md"));
  assert.ok(payload.documents.some((item) => item.key === "agent-brain/archive/old.md"));
  const draft = payload.documents.find((item) => item.key === "agent-brain/index.md").threads.find((thread) => thread.id === pending);
  assert.equal(draft.messages[0].sentAt, null);
  assert.ok(referencedRevisions(payload).some((revision) => revision.sha256 === doc.revisions[0].sha256));

  const importedHome = path.join(vault, "imported");
  const created = await openStore(importedHome);
  created.close();
  const target = openStoreDb(path.join(importedHome, "peanut.sqlite3"));
  const first = importInto(target, payload);
  const second = importInto(target, payload);
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.threads, first.threads);
  const changed = structuredClone(payload);
  changed.documents[0].threads[0].messages[0].body = "Different.";
  const refused = importInto(target, changed);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "not_empty");
  const forced = importInto(target, changed, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.idempotent, false);
  target.close();

  const loaded = await openAsyncStore(importedHome);
  const view = await loaded.threadsAt("agent-brain/cloudflare-hosting.md", { includePending: true });
  const thread = view.threads.find((item) => item.id === id);
  assert.equal(thread.state, "carried");
  assert.equal(thread.blockIndex, placed.blockIndex);
  assert.match(thread.source, /Keep this paragraph/);
  assert.equal(thread.messages[0].body, "Different.");
  await loaded.close();
});

test("the admin import is idempotent and everyone else is refused", async () => {
  const vault = await makeVault();
  const home = path.join(vault, "home");
  const mac = await openStore(home);
  const file = path.join(vault, "projects", "agent-brain", "specs", "cloudflare-hosting.md");
  const id = commentOn(mac, file, V1);
  mac.close();
  const db = openStoreDb(path.join(home, "peanut.sqlite3"), { readOnly: true });
  const payload = exportStore(db, { rekey: (key) => rekeyDocument(key, vault) });
  db.close();

  const serverHome = path.join(vault, "server");
  const store = await openAsyncStore(serverHome);
  const docs = new FsDocSource(path.join(vault, "empty-docs"));
  await fs.mkdir(docs.root, { recursive: true });
  const call = (method, pathname, { body, identity }) => callHandle(docs, store, method, pathname, { body, identity });

  const denied = await call("POST", "/internal/import", { body: payload, identity: { kind: "agent", author: "spec-agent" } });
  const backup = await call("POST", "/internal/import", { body: payload, identity: { kind: "backup", author: "backup" } });
  const human = await call("POST", "/internal/import", { body: payload, identity: { kind: "human", author: "neil" } });
  assert.equal(denied.status, 403);
  assert.equal(backup.status, 403);
  assert.equal(human.status, 403);

  const loaded = await call("POST", "/internal/import", { body: payload, identity: ADMIN });
  const replay = await call("POST", "/internal/import", { body: payload, identity: ADMIN });
  assert.equal(loaded.status, 201, loaded.text);
  assert.equal(loaded.json.threads, 1);
  assert.equal(replay.status, 201);
  assert.equal(replay.json.idempotent, true);
  const clash = await call("POST", "/internal/import", {
    body: { ...payload, documents: payload.documents.map((doc) => ({ ...doc, threads: doc.threads.map((thread) => ({ ...thread, quote: "nope" })) })) },
    identity: ADMIN,
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error, "not_empty");
  const view = await store.threadsAt("agent-brain/cloudflare-hosting.md", { includePending: true });
  assert.equal(view.threads[0].id, id);
  assert.equal(view.threads[0].state, "current");
  assert.equal(view.threads[0].blockIndex, 0);
  await store.close();
});

test("seed uploads specs and the revisions threads cite", async () => {
  const vault = await makeVault();
  await fs.writeFile(path.join(vault, "projects", "agent-brain", "specs", "cloudflare-hosting.md"), V2);
  const home = path.join(vault, "home");
  const mac = await openStore(home);
  const file = path.join(vault, "projects", "agent-brain", "specs", "cloudflare-hosting.md");
  mac.createThread({ file, content: V1, quote: "Keep this", body: "On the first text.", author: HUMAN });
  mac.observe(file, V2);
  mac.close();
  const exportFile = path.join(vault, "export.json");
  const exported = await runStore(["export", "--rekey-vault", vault, "--out", exportFile], {
    env: { ...process.env, MDVIEW_HOME: home },
    out: { write() {} },
    err: { write() {} },
  });
  assert.equal(exported, 0);

  const serverRoot = path.join(vault, "worker-files");
  const serverHome = path.join(vault, "worker-home");
  await fs.mkdir(serverRoot, { recursive: true });
  const docs = new FsDocSource(serverRoot);
  const store = await openAsyncStore(serverHome);
  const server = await listen(docs, store);
  const env = {
    ...process.env,
    MDVIEW_URL: server.url,
    MDVIEW_HOME: home,
    MDVIEW_AUTHOR: "spec-agent",
    MDVIEW_ACCESS_CLIENT_ID: "agent-id",
    MDVIEW_ACCESS_CLIENT_SECRET: "agent-secret",
    MDVIEW_ADMIN_ACCESS_CLIENT_ID: "admin-id",
    MDVIEW_ADMIN_ACCESS_CLIENT_SECRET: "admin-secret",
  };
  try {
    let out = "";
    const status = await runSpecs(["seed", "--vault", vault, "--source-rev", "abc1234", "--export", exportFile], {
      env,
      out: { write: (chunk) => (out += chunk) },
      err: { write: (chunk) => (out += chunk) },
    });
    assert.equal(status, 0, out);
    assert.match(out, /agent-brain\/index\.md/);
    assert.match(out, /agent-brain\/archive\/old\.md/);
    assert.equal(await fs.readFile(path.join(serverRoot, "agent-brain", "cloudflare-hosting.md"), "utf8"), V2);
    const meta = JSON.parse(await fs.readFile(path.join(serverRoot, ".mdview-revs", "agent-brain", "cloudflare-hosting.md", "meta.json"), "utf8"));
    assert.equal(meta.sourceRev, "abc1234");
    const historical = await fs.readFile(
      path.join(serverRoot, ".mdview-revs", "agent-brain", "cloudflare-hosting.md", `${sha256Bytes(Buffer.from(V1))}.md`),
      "utf8",
    );
    assert.equal(historical, V1);
    const seen = server.calls.filter((call) => call.pathname.startsWith("/internal/"));
    assert.ok(seen.every((call) => call.admin));
    assert.ok(server.calls.filter((call) => call.pathname === "/api/specs").every((call) => !call.admin));
    const again = await runSpecs(["seed", "--vault", vault, "--source-rev", "abc1234", "--export", exportFile], {
      env,
      out: { write() {} },
      err: { write() {} },
    });
    assert.equal(again, 0);
  } finally {
    server.close();
    await store.close();
  }
});

test("the backup loop only gets, writes on change, and overwrites a local edit", async () => {
  const vault = await fs.mkdtemp(path.join(root, "backup-"));
  const state = path.join(vault, "state.json");
  const content = "Hello from R2.\n";
  let current = content;
  let updatedAt = "2026-11-25T00:00:00.000Z";
  const calls = [];
  const env = {
    MDVIEW_URL: "http://worker.test/",
    MDVIEW_VAULT: vault,
    MDVIEW_BACKUP_STATE: state,
    MDVIEW_ACCESS_CLIENT_ID: "backup-id",
    MDVIEW_ACCESS_CLIENT_SECRET: "backup-secret",
    MDVIEW_AUTHOR: "backup",
  };
  async function fetchImpl(url, init) {
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    calls.push({ method, pathname: parsed.pathname, since: parsed.searchParams.get("since") });
    assert.equal(method, "GET");
    if (parsed.pathname === "/api/specs") {
      const since = parsed.searchParams.get("since");
      const spec = specRow(current, updatedAt);
      const specs = !since || !(spec.updatedAt < since) ? [spec] : [];
      return json({ specs });
    }
    assert.equal(parsed.pathname, "/api/specs/agent-brain/note.md");
    return new Response(current, { status: 200, headers: { "content-type": "text/markdown" } });
  }
  const first = await pullVault({ env, fetchImpl, now: () => new Date("2026-11-25T01:00:00.000Z") });
  const file = path.join(vault, "projects", "agent-brain", "specs", "note.md");
  assert.deepEqual(first.written, ["agent-brain/note.md"]);
  assert.equal(await fs.readFile(file, "utf8"), content);
  const stamped = new Date("2020-01-01T00:00:00.000Z");
  await fs.utimes(file, stamped, stamped);

  calls.length = 0;
  const second = await pullVault({ env, fetchImpl, now: () => new Date("2026-11-25T01:05:00.000Z") });
  assert.deepEqual(second.written, []);
  assert.ok(calls.some((call) => call.pathname === "/api/specs" && call.since));
  assert.equal((await fs.stat(file)).mtime.toISOString(), stamped.toISOString());

  await fs.writeFile(file, "local edit\n");
  calls.length = 0;
  const third = await pullVault({ env, fetchImpl, now: () => new Date("2026-11-25T01:10:00.000Z") });
  assert.deepEqual(third.overwritten, ["agent-brain/note.md"]);
  assert.equal(await fs.readFile(file, "utf8"), content);
  const learnings = await fs.readFile(path.join(vault, "inbox", "learnings.md"), "utf8");
  assert.match(learnings, /overwrote projects\/agent-brain\/specs\/note\.md/);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal(sha256Bytes(Buffer.from(content)), specRow(content, updatedAt).sha256);
});

test("verify is a dry run and restore rewrites keys to vault paths", async () => {
  const vault = await makeVault();
  const home = path.join(vault, "mac-home");
  const mac = await openStore(home);
  const file = path.join(vault, "projects", "agent-brain", "specs", "index.md");
  mac.createThread({ file, content: "# Specs\n", blockIndex: 0, body: "Index note.", author: HUMAN });
  mac.close();
  const serverHome = path.join(vault, "remote-home");
  const store = await openAsyncStore(serverHome);
  const docs = new FsDocSource(path.join(vault, "remote-docs"));
  await fs.mkdir(docs.root, { recursive: true });
  const server = await listen(docs, store);
  const env = { ...process.env, MDVIEW_URL: server.url, MDVIEW_HOME: home, MDVIEW_AUTHOR: "spec-agent" };
  try {
    const exportFile = path.join(vault, "export.json");
    assert.equal(await runStore(["export", "--rekey-vault", vault, "--out", exportFile], { env, out: { write() {} }, err: { write() {} } }), 0);
    const payload = JSON.parse(await fs.readFile(exportFile, "utf8"));
    const imported = await callHandle(docs, store, "POST", "/internal/import", { body: payload, identity: ADMIN });
    assert.equal(imported.status, 201, imported.text);
    let out = "";
    let err = "";
    const status = await runStore(["verify", "--rekey-vault", vault], {
      env,
      fetchImpl: (url, init) => trackedFetch(server, url, init),
      out: { write: (chunk) => (out += chunk) },
      err: { write: (chunk) => (err += chunk) },
    });
    assert.equal(status, 0, err || out);
    assert.match(out, /Dry run/);
    assert.match(out, /block anchor resolves/);
    assert.ok(server.calls.filter((call) => call.pathname === "/internal/parity").every((call) => call.method === "GET"));

    const rolled = path.join(vault, "rollback");
    let restored = "";
    const back = await runStore(["restore", exportFile, "--vault", vault], {
      env: { ...env, MDVIEW_HOME: rolled },
      out: { write: (chunk) => (restored += chunk) },
      err: { write: (chunk) => (restored += chunk) },
    });
    assert.equal(back, 0, restored);
    const local = await openStore(rolled);
    const view = local.threadsAt(file);
    assert.equal(view.threads.length, 1);
    assert.match(view.threads[0].source, /Specs/);
    assert.equal(view.threads[0].blockIndex, 0);
    assert.notEqual(view.threads[0].state, "outdated");
    local.close();
  } finally {
    server.close();
    await store.close();
  }
});

test("a spec outside the key rules is reported and not uploaded", async () => {
  const vault = await makeVault();
  const nested = path.join(vault, "projects", "agent-brain", "specs", "nested");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "nope.md"), "No.\n");
  const found = listVaultSpecs(vault);
  assert.ok(found.skipped.some((rel) => rel.endsWith("nested/nope.md")));
  assert.ok(found.specs.some((spec) => spec.key === "agent-brain/index.md"));
});

const ADMIN = { kind: "admin", author: "admin-token" };

function specRow(content, updatedAt) {
  return {
    key: "agent-brain/note.md",
    sha256: sha256Bytes(Buffer.from(content)),
    size: Buffer.byteLength(content),
    updatedAt,
    updatedBy: "seed",
  };
}

function json(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function callHandle(docs, store, method, pathname, { body, identity }) {
  const headers = new Headers();
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers.set("content-type", "application/json");
  }
  const response = await handle(new Request(`http://127.0.0.1${pathname}`, { method, headers, body: payload }), {
    docs,
    assets: new FsAssets(),
    store,
    identity,
    initial: "",
    allowedHosts: new Set(["127.0.0.1"]),
  });
  const text = await response.text();
  let parsed = null;
  if (text && (response.headers.get("content-type") ?? "").includes("json")) parsed = JSON.parse(text);
  return { status: response.status, json: parsed, text };
}

async function listen(docs, store) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const request = toRequest(req, controller.signal);
    const pathname = new URL(request.url).pathname;
    const admin = pathname.startsWith("/internal/");
    calls.push({ method: request.method, pathname, admin });
    const response = await handle(request, {
      docs,
      assets: new FsAssets(),
      store,
      identity: admin ? ADMIN : { kind: "agent", author: request.headers.get("x-mdview-author") || "spec-agent", session: null },
      initial: "",
      allowedHosts: null,
    });
    await writeNodeResponse(res, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    calls,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function trackedFetch(server, url, init) {
  const parsed = new URL(url);
  server.calls.push({ method: init?.method ?? "GET", pathname: parsed.pathname, admin: parsed.pathname.startsWith("/internal/") });
  return fetch(url, init);
}

test("a spec moved to archive/ after it was commented on rekeys to its archive key", async () => {
  const vault = await fs.mkdtemp(path.join(root, "archived-"));
  const specs = path.join(vault, "projects", "genesis", "specs");
  await fs.mkdir(path.join(specs, "archive"), { recursive: true });
  await fs.writeFile(path.join(specs, "archive", "m1.md"), V1);
  await fs.writeFile(path.join(specs, "live.md"), V1);

  assert.equal(rekeyDocument(path.join(specs, "m1.md"), vault), "genesis/archive/m1.md");
  assert.equal(rekeyDocument(path.join(specs, "live.md"), vault), "genesis/live.md");
  assert.equal(rekeyDocument(path.join(specs, "gone.md"), vault), "genesis/gone.md");
});

test("the backup loop removes a mirrored spec the Worker moved, and keeps an edited one", async () => {
  const vault = await fs.mkdtemp(path.join(root, "prune-"));
  const env = { MDVIEW_URL: "http://worker.test/", MDVIEW_VAULT: vault, MDVIEW_BACKUP_STATE: path.join(vault, "state.json") };
  const text = { "agent-brain/a.md": "A\n", "agent-brain/b.md": "B\n", "agent-brain/c.md": "C\n" };
  let live = Object.keys(text);
  const row = (key) => ({ key, sha256: sha256Bytes(Buffer.from(text[key])), size: text[key].length, updatedAt: "2026-11-25T00:00:00.000Z", updatedBy: "seed" });
  async function fetchImpl(url) {
    const { pathname } = new URL(url);
    if (pathname === "/api/specs") return json({ specs: live.map(row) });
    const key = decodeURIComponent(pathname.slice("/api/specs/".length));
    return new Response(text[key], { status: 200 });
  }
  const file = (key) => path.join(vault, "projects", ...key.replace("/", "/specs/").split("/"));
  const quiet = () => {};
  await pullVault({ env, fetchImpl, log: quiet });
  await fs.writeFile(file("agent-brain/c.md"), "edited\n");
  live = ["agent-brain/a.md"];
  text["specs/archive/b.md"] = "B\n";
  live.push("specs/archive/b.md");

  const pass = await pullVault({ env, fetchImpl, log: quiet });

  assert.deepEqual(pass.removed, ["agent-brain/b.md"]);
  await assert.rejects(fs.stat(file("agent-brain/b.md")));
  assert.equal(await fs.readFile(file("specs/archive/b.md"), "utf8"), "B\n");
  assert.equal(await fs.readFile(file("agent-brain/c.md"), "utf8"), "edited\n");
  assert.match(await fs.readFile(path.join(vault, "inbox", "learnings.md"), "utf8"), /removed projects\/agent-brain\/specs\/b\.md/);
  live = [];
  const empty = await pullVault({ env, fetchImpl, log: quiet });
  assert.deepEqual(empty.removed, []);
  assert.equal(await fs.readFile(file("agent-brain/a.md"), "utf8"), "A\n");
});
