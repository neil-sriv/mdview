import { test } from "node:test";
import assert from "node:assert/strict";
import { validSpecKey as serverKey } from "../../lib/docs.mjs";
import {
  applySaveResult,
  beginCreate,
  beginEdit,
  clearSession,
  conflictWith,
  draftId,
  existsMessage,
  latestCreate,
  openSession,
  persistSession,
  reloadSession,
  saveRequest,
  sessionWorthKeeping,
  shaFromEtag,
  specUrl,
  storedDraft,
  validSpecKey,
} from "../../public/js/lib/spec-editor.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("the editor accepts the same spec keys as the server", () => {
  const samples = [
    "agent-brain/plan.md",
    "agent-brain/archive/plan.md",
    "agent-brain/a.note_1.md",
    "agent-brain/sub/plan.md",
    "agent-brain/archive/nested/plan.md",
    "Agent-Brain/plan.md",
    "plan.md",
    "../etc/passwd",
    "agent-brain/../plan.md",
  ];
  for (const sample of samples) assert.equal(validSpecKey(sample), serverKey(sample), sample);
});

test("an edit save sends If-Match of the loaded etag, and a create does not", () => {
  const edit = saveRequest({ mode: "edit", key: "agent-brain/plan.md", content: "Mine.\n", etag: SHA_A, requestId: "req-1" });
  assert.equal(edit.method, "PUT");
  assert.equal(edit.url, "/api/specs/agent-brain/plan.md");
  assert.equal(edit.headers["If-Match"], `"${SHA_A}"`);
  assert.deepEqual(edit.body, { content: "Mine.\n", requestId: "req-1" });
  assert.equal(saveRequest({ mode: "edit", key: "agent-brain/plan.md", content: "x", etag: null, requestId: "req-2" }), null);

  const created = saveRequest({ mode: "create", key: "agent-brain/new.md", content: "Hello.\n", requestId: "req-3" });
  assert.equal(created.method, "POST");
  assert.equal(created.url, "/api/specs");
  assert.equal(created.headers["If-Match"], undefined);
  assert.deepEqual(created.body, { key: "agent-brain/new.md", content: "Hello.\n", requestId: "req-3" });
  assert.equal(specUrl("agent-brain/archive/plan.md"), "/api/specs/agent-brain/archive/plan.md");
});

test("an etag header is the sha it quotes", () => {
  assert.equal(shaFromEtag(`"${SHA_A}"`), SHA_A);
  assert.equal(shaFromEtag(`W/"${SHA_A.toUpperCase()}"`), SHA_A);
  assert.equal(shaFromEtag(SHA_B), SHA_B);
  assert.equal(shaFromEtag("nope"), null);
  assert.equal(shaFromEtag(null), null);
});

test("a 412 keeps the draft beside the current text, and the same text counts as saved", () => {
  const session = { mode: "edit", key: "agent-brain/plan.md", text: "Mine.\n", etag: SHA_A, base: "Original.\n", previous: null, conflict: null };
  const conflict = applySaveResult(session, { status: 412, body: { error: "stale", message: "stale", current: { sha256: SHA_B, content: "Theirs.\n" } } });
  assert.equal(conflict.view, "conflict");
  assert.equal(conflict.session.text, "Mine.\n");
  assert.equal(conflict.session.etag, SHA_A);
  assert.equal(conflict.session.conflict.sha256, SHA_B);
  assert.equal(conflict.session.conflict.content, "Theirs.\n");
  assert.match(conflict.session.conflict.message, /your draft is still here/i);

  const same = applySaveResult(session, { status: 412, body: { current: { sha256: SHA_B, content: "Mine.\n" } } });
  assert.deepEqual(same, { view: "saved", sha256: SHA_B });
  const ok = applySaveResult(session, { status: 200, body: { sha256: SHA_B } });
  assert.deepEqual(ok, { view: "saved", sha256: SHA_B });
  const refused = applySaveResult(session, { status: 428, body: { error: "precondition", message: "If-Match is required." } });
  assert.equal(refused.view, "error");
  assert.match(refused.message, /If-Match/);
});

test("overwrite reviews the current sha, and reload keeps the replaced draft", () => {
  const session = {
    mode: "edit",
    key: "agent-brain/plan.md",
    text: "Mine.\n",
    etag: SHA_A,
    base: "Original.\n",
    previous: null,
    conflict: { sha256: SHA_B, content: "Theirs.\n", message: "changed" },
  };
  const overwrite = saveRequest({ mode: "edit", key: session.key, content: session.text, etag: session.conflict.sha256, requestId: "req-4" });
  assert.equal(overwrite.headers["If-Match"], `"${SHA_B}"`);
  assert.equal(overwrite.body.content, "Mine.\n");

  const reloaded = reloadSession(session, { sha256: SHA_B, content: "Theirs.\n" });
  assert.equal(reloaded.mode, "edit");
  assert.equal(reloaded.text, "Theirs.\n");
  assert.equal(reloaded.etag, SHA_B);
  assert.equal(reloaded.previous, "Mine.\n");
  assert.equal(reloaded.conflict, null);
  assert.equal(sessionWorthKeeping(reloaded), true);
});

test("a create that finds an existing key becomes the same review", () => {
  const session = beginCreate(null);
  session.key = "agent-brain/plan.md";
  session.text = "Mine.\n";
  const exists = applySaveResult(session, { status: 409, body: { error: "exists", message: "A spec already exists at agent-brain/plan.md." } });
  assert.equal(exists.view, "exists");
  const review = conflictWith(session, { sha256: SHA_B, content: "Theirs.\n" }, existsMessage(session.key));
  assert.equal(review.text, "Mine.\n");
  assert.equal(review.conflict.content, "Theirs.\n");
  assert.match(review.conflict.message, /already exists/);
});

test("a draft stays stored until a save clears it, and a refresh can reopen it", () => {
  const storage = memoryStorage();
  const draft = { mode: "edit", key: "agent-brain/plan.md", text: "Mine.\n", etag: SHA_A, base: "Original.\n", previous: null, conflict: null };
  const id = persistSession(storage, draft, { open: true });
  assert.equal(id, "agent-brain/plan.md");
  assert.equal(openSession(storage).text, "Mine.\n");
  assert.equal(storedDraft(storage, "edit", "agent-brain/plan.md").etag, SHA_A);

  const opened = beginEdit({ key: draft.key, serverText: "Theirs.\n", etag: SHA_B, stored: openSession(storage) });
  assert.equal(opened.text, "Mine.\n");
  assert.equal(opened.etag, SHA_A);
  assert.equal(opened.conflict.content, "Theirs.\n");
  assert.equal(opened.restored, true);

  const moved = { ...draft, mode: "create", key: "agent-brain/other.md", text: "New.\n" };
  persistSession(storage, moved, { open: true, previousId: draftId({ mode: "create", key: "" }) });
  assert.equal(latestCreate(storage).key, "agent-brain/other.md");
  clearSession(storage, moved, id);
  assert.equal(openSession(storage), null);
  assert.equal(storedDraft(storage, "edit", draft.key), null);
  assert.equal(beginCreate(null).text, "");
  assert.equal(sessionWorthKeeping({ mode: "edit", text: "Original.\n", base: "Original.\n", previous: null, conflict: null }), false);
});

test("a stored draft that is not ours is ignored", () => {
  const storage = memoryStorage();
  storage.setItem("mdview.specDrafts", "{");
  assert.equal(openSession(storage), null);
  storage.setItem("mdview.specDrafts", JSON.stringify({ "agent-brain/plan.md": { mode: "edit" } }));
  storage.setItem("mdview.specEditor", "agent-brain/plan.md");
  assert.equal(openSession(storage), null);
});
