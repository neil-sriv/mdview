/** Edit and New spec. A plain markdown box, saving through the spec API. */
import { closeComposer } from "./comments/composer.js";
import { $, copyText, root, toast } from "./dom.js";
import { loadDoc, releaseReload, reloadDoc } from "./doc.js";
import {
  applySaveResult,
  beginCreate,
  beginEdit,
  changedMessage,
  clearSession,
  conflictWith,
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
} from "./lib/spec-editor.js";
import { refreshTree } from "./sidebar.js";
import { state } from "./state.js";

const editor = () => $("#spec-editor");
const textArea = () => $("#spec-text");
const keyInput = () => $("#spec-key");

let session = null;
let persistedId = null;
let saving = false;
let saveAttempt = 0;
let persistTimer = 0;

export function editorOpen() {
  return !editor().hidden;
}

/** Shows or hides Edit, from the doc on screen. */
export function syncEditButton() {
  const spec = Boolean(state.doc && !state.doc.old && validSpecKey(state.doc.path));
  $("#edit-spec").hidden = !spec;
}

export function initSpecEditor() {
  $("#edit-spec").addEventListener("click", () => void onEdit());
  $("#new-spec").addEventListener("click", () => onNew());
  $("#spec-cancel").addEventListener("click", cancel);
  $("#spec-save").addEventListener("click", () => void save());
  $("#spec-reload").addEventListener("click", () => void reloadLatest());
  $("#spec-copy-draft").addEventListener("click", () => void copyDraft(session?.text));
  $("#spec-copy-previous").addEventListener("click", () => void copyDraft(session?.previous));
  textArea().addEventListener("input", touch);
  keyInput().addEventListener("input", onKeyInput);
  keyInput().addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      textArea().focus();
    }
  });
  editor().addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.target === textArea()) {
      event.preventDefault();
      void save();
    }
  });
  addEventListener("pagehide", flush);
  const viewport = window.visualViewport;
  if (viewport) {
    const pin = pinAboveKeyboard();
    viewport.addEventListener("resize", pin);
    viewport.addEventListener("scroll", pin);
  }
}

/** Reopens the editor when a refresh interrupted a draft. The draft is already on this phone. */
export async function restoreSpecEditor() {
  const stored = openSession(localStorage);
  if (!stored) return;
  if (stored.mode === "edit" && stored.key) {
    if (state.doc?.path !== stored.key) {
      try {
        await loadDoc(stored.key, { version: null });
      } catch {
        // The draft still opens. Save will say if the spec is gone.
      }
    }
    let server = null;
    try {
      server = await loadSpec(stored.key);
    } catch {
      server = null;
    }
    if (server) show(beginEdit({ key: stored.key, serverText: server.text, etag: server.etag, stored }));
    else {
      show({ ...stored, restored: true });
      setStatus("Couldn't refresh this spec. Your draft is still on this phone.");
    }
    return;
  }
  show(beginCreate(stored));
}

async function onEdit() {
  const key = state.doc?.path;
  if (!key || state.doc.old || !validSpecKey(key)) return;
  if (session?.mode === "edit" && session.key === key && editorOpen()) {
    textArea().focus();
    return;
  }
  stash();
  let server = null;
  let failed = null;
  try {
    server = await loadSpec(key);
  } catch (err) {
    failed = err;
  }
  const stored = storedDraft(localStorage, "edit", key);
  if (!server && !stored) {
    toast(failed?.message || "Couldn't load this spec.");
    return;
  }
  if (!server) {
    show({ ...stored, restored: true });
    setStatus("Couldn't refresh this spec. Your draft is still on this phone.");
    return;
  }
  show(beginEdit({ key, serverText: server.text, etag: server.etag, stored }));
}

function onNew() {
  if (session?.mode === "create" && editorOpen()) {
    keyInput().focus();
    return;
  }
  stash();
  show(beginCreate(latestCreate(localStorage)));
}

function stash() {
  if (!session || !editorOpen()) return;
  syncFromDom();
  if (sessionWorthKeeping(session)) persistedId = persistSession(localStorage, session, { open: false, previousId: persistedId });
  else clearSession(localStorage, session, persistedId);
  session = null;
  persistedId = null;
}

function show(next) {
  closeComposer({ release: false });
  root.classList.remove("sidebar-open");
  session = next;
  editor().hidden = false;
  root.classList.add("spec-editing");
  render();
  setStatus(statusLine());
  flush();
  focusEditor();
  pinAboveKeyboard()();
}

function hide({ release }) {
  editor().hidden = true;
  root.classList.remove("spec-editing");
  editor().style.bottom = "";
  if (release) releaseReload();
}

function cancel() {
  if (!session) return;
  // A save still in flight is ignored. The draft stays either way.
  saveAttempt += 1;
  saving = false;
  clearTimeout(persistTimer);
  syncFromDom();
  if (sessionWorthKeeping(session)) persistSession(localStorage, session, { open: false, previousId: persistedId });
  else clearSession(localStorage, session, persistedId);
  session = null;
  persistedId = null;
  hide({ release: true });
}

function touch() {
  syncFromDom();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(flush, 50);
}

function flush() {
  clearTimeout(persistTimer);
  if (!session) return;
  syncFromDom();
  try {
    persistedId = persistSession(localStorage, session, { open: editorOpen(), previousId: persistedId });
  } catch {
    setStatus("This phone couldn't store the draft. It is still in the box until you leave the page.");
  }
}

function syncFromDom() {
  if (!session) return;
  session.text = textArea().value;
  if (session.mode === "create") session.key = keyInput().value.trim();
}

function onKeyInput() {
  if (!session || session.mode !== "create") return;
  const next = keyInput().value.trim();
  if (next !== session.key && session.conflict) session.conflict = null;
  session.key = next;
  render();
  touch();
}

async function save() {
  if (!session || saving) return;
  syncFromDom();
  flush();
  if (root.dataset.offline === "1") {
    setStatus("You're offline. This draft stays on this phone until a save succeeds.");
    return;
  }
  const creating = session.mode === "create" && !session.conflict;
  if (creating && !validSpecKey(session.key)) {
    setStatus("A key looks like project/name.md. Lowercase letters, digits, dots, underscores and hyphens.");
    keyInput().focus();
    return;
  }
  // The loaded ETag, or, after a review, the sha of the text on screen.
  const etag = session.conflict?.sha256 ?? session.etag;
  const request = saveRequest({
    mode: creating ? "create" : "edit",
    key: session.key,
    content: session.text,
    etag,
    requestId: crypto.randomUUID(),
  });
  if (!request) {
    setStatus("This spec has no version tag, so it can't be saved safely.");
    return;
  }
  saving = true;
  const attempt = ++saveAttempt;
  render();
  let message = null;
  try {
    const result = await submit(request);
    if (attempt !== saveAttempt || !session) return;
    if (result.network) {
      message = "Couldn't reach mdview. Your draft is still on this phone.";
      return;
    }
    const outcome = applySaveResult(session, result);
    if (outcome.view === "saved") {
      await finishSave(session.key);
      return;
    }
    if (attempt !== saveAttempt || !session) return;
    if (outcome.view === "conflict") {
      session = outcome.session;
      flush();
      return;
    }
    if (outcome.view === "exists") {
      const current = await loadSpec(session.key).catch(() => null);
      if (attempt !== saveAttempt || !session) return;
      if (!current?.etag) {
        message = outcome.message;
        return;
      }
      session = conflictWith(session, { sha256: current.etag, content: current.text }, existsMessage(session.key));
      flush();
      return;
    }
    message = outcome.message;
  } finally {
    saving = false;
    if (session) render();
    if (message) setStatus(message);
  }
}

async function reloadLatest() {
  if (!session?.conflict || saving) return;
  flush();
  let current = { content: session.conflict.content, sha256: session.conflict.sha256 };
  try {
    const latest = await loadSpec(session.key);
    if (latest?.etag) current = { content: latest.text, sha256: latest.etag };
  } catch {
    // The conflict already holds the newest text we have.
  }
  session = reloadSession(session, current);
  render();
  setStatus(session.previous ? "Reloaded the latest text. Your earlier draft is still on this phone." : statusLine());
  flush();
  textArea().focus();
}

async function copyDraft(text) {
  if (typeof text !== "string") return;
  if (await copyText(text)) toast("Copied your draft");
}

async function finishSave(key) {
  const done = session;
  clearTimeout(persistTimer);
  session = null;
  clearSession(localStorage, done, persistedId);
  persistedId = null;
  hide({ release: false });
  // loadDoc fetches comments for the new sha, so threads re-anchor on this text.
  if (state.doc?.path === key && !state.viewVersion) await reloadDoc();
  else await loadDoc(key, { version: null });
  await refreshTree();
}

async function loadSpec(key) {
  const res = await fetch(specUrl(key), { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `Couldn't load ${key}.`);
  }
  return { text: await res.text(), etag: shaFromEtag(res.headers.get("etag")) };
}

async function submit(request) {
  let res;
  try {
    res = await fetch(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(request.body), cache: "no-store" });
  } catch {
    return { network: true };
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function render() {
  const box = editor();
  const conflict = session?.conflict ?? null;
  box.classList.toggle("conflict", Boolean(conflict));
  box.classList.toggle("creating", session?.mode === "create");
  $("#spec-current-pane").hidden = !conflict;
  $("#spec-conflict-note").hidden = !conflict;
  $("#spec-copy-draft").hidden = !conflict;
  $("#spec-reload").hidden = !conflict;
  $("#spec-previous").hidden = !session?.previous;
  $("#spec-save").textContent = conflict ? "Overwrite with your draft" : "Save";
  $("#spec-draft-heading").textContent = conflict ? "Your draft" : "Markdown";
  textArea().setAttribute("aria-label", conflict ? "Your draft" : "Markdown");
  box.setAttribute("aria-label", conflict ? "Spec changed" : session?.mode === "create" ? "New spec" : "Edit spec");
  if (conflict) {
    $("#spec-conflict-note").textContent = conflict.message || changedMessage();
    $("#spec-current").textContent = conflict.content;
  }
  if (textArea().value !== (session?.text ?? "")) textArea().value = session?.text ?? "";
  if (keyInput().value.trim() !== (session?.key ?? "")) keyInput().value = session?.key ?? "";
  textArea().readOnly = saving;
  keyInput().readOnly = saving;
  for (const button of box.querySelectorAll("button")) {
    if (button.id === "spec-cancel") continue;
    button.disabled = saving;
  }
}

function statusLine() {
  if (!session) return "";
  if (root.dataset.offline === "1") return "You're offline. This draft stays on this phone until a save succeeds.";
  if (session.mode === "create") {
    return session.restored ? "Restored your draft from this phone." : "A new spec. The key looks like project/name.md.";
  }
  const where = `Editing ${session.key}.`;
  return session.restored ? `Restored your draft from this phone. ${where}` : where;
}

function setStatus(message) {
  $("#spec-status").textContent = message;
}

function focusEditor() {
  const field = session?.mode === "create" && !session.conflict ? keyInput() : textArea();
  field.focus();
  const end = field.value.length;
  field.setSelectionRange?.(end, end);
}

function pinAboveKeyboard() {
  return () => {
    const box = editor();
    const viewport = window.visualViewport;
    if (!viewport || box.hidden) {
      box.style.bottom = "";
      return;
    }
    const gap = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    box.style.bottom = `${gap}px`;
  };
}
