/**
 * The spec editor's decisions, with no DOM.
 *
 * A save of an existing spec sends the ETag the editor loaded. A 412 keeps
 * the draft and names the text now on the server. The draft stays in
 * localStorage until a save returns success. The key pattern matches
 * SPEC_KEY in lib/docs.mjs.
 */

export const DRAFTS_KEY = "mdview.specDrafts";
export const OPEN_KEY = "mdview.specEditor";

/** Same rule as `validSpecKey` in lib/docs.mjs. `<project>/<file>.md`, or one `archive/` segment. */
export const SPEC_KEY = /^[a-z0-9-]+\/(?:archive\/)?[a-z0-9._-]+\.md$/;

export function validSpecKey(key) {
  return typeof key === "string" && SPEC_KEY.test(key);
}

export function specUrl(key) {
  return `/api/specs/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** The sha256 an ETag header names, or null when the header is not one. */
export function shaFromEtag(header) {
  const match = /^(?:W\/)?"?([0-9a-f]{64})"?$/i.exec(String(header ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}

export function draftId(session) {
  return session.mode === "create" ? `new:${session.key}` : session.key;
}

export function readDrafts(storage) {
  try {
    const value = JSON.parse(storage.getItem(DRAFTS_KEY) || "");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeDrafts(storage, drafts) {
  storage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
}

function asConflict(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.content !== "string" || typeof value.sha256 !== "string" || !value.sha256) return null;
  return { sha256: value.sha256, content: value.content, message: typeof value.message === "string" ? value.message : "" };
}

/** A stored draft, or null when the value is missing or not one of ours. */
export function asSession(value) {
  if (!value || typeof value !== "object") return null;
  if (value.mode !== "edit" && value.mode !== "create") return null;
  if (typeof value.text !== "string") return null;
  return {
    mode: value.mode,
    key: typeof value.key === "string" ? value.key : "",
    text: value.text,
    etag: typeof value.etag === "string" && value.etag ? value.etag : null,
    base: typeof value.base === "string" ? value.base : "",
    previous: typeof value.previous === "string" ? value.previous : null,
    conflict: asConflict(value.conflict),
    keptAt: typeof value.keptAt === "string" ? value.keptAt : "",
  };
}

function serialize(session) {
  return {
    mode: session.mode,
    key: session.key,
    text: session.text,
    etag: session.etag,
    base: session.base,
    previous: session.previous,
    conflict: session.conflict,
    keptAt: new Date().toISOString(),
  };
}

/**
 * Writes `session` and, when `open`, remembers that the editor was showing it.
 * `previousId` is the key it was stored under before a create key changed.
 * Returns the id it wrote.
 */
export function persistSession(storage, session, { open = false, previousId = null } = {}) {
  const drafts = readDrafts(storage);
  const id = draftId(session);
  if (previousId && previousId !== id) delete drafts[previousId];
  drafts[id] = serialize(session);
  writeDrafts(storage, drafts);
  const showing = storage.getItem(OPEN_KEY);
  if (open) storage.setItem(OPEN_KEY, id);
  else if (showing === id || (previousId && showing === previousId)) storage.removeItem(OPEN_KEY);
  return id;
}

export function clearSession(storage, session, previousId = null) {
  const drafts = readDrafts(storage);
  if (session) delete drafts[draftId(session)];
  if (previousId) delete drafts[previousId];
  writeDrafts(storage, drafts);
  const showing = storage.getItem(OPEN_KEY);
  if (session && (showing === draftId(session) || showing === previousId)) storage.removeItem(OPEN_KEY);
}

export function openSession(storage) {
  const id = storage.getItem(OPEN_KEY);
  if (!id) return null;
  return asSession(readDrafts(storage)[id]);
}

export function storedDraft(storage, mode, key) {
  return asSession(readDrafts(storage)[mode === "create" ? `new:${key}` : key]);
}

/** The create draft kept most recently, so New spec can bring it back. */
export function latestCreate(storage) {
  let found = null;
  for (const value of Object.values(readDrafts(storage))) {
    const session = asSession(value);
    if (!session || session.mode !== "create") continue;
    if (!found || session.keptAt > found.keptAt) found = session;
  }
  return found;
}

/** True when closing the editor would throw away something the server does not have. */
export function sessionWorthKeeping(session) {
  if (!session) return false;
  if (session.previous || session.conflict) return true;
  if (session.mode === "create") return session.text !== "" || session.key !== "";
  return session.text !== session.base;
}

/**
 * Opens an existing spec. A stored draft wins over the server text. When the
 * server sha has moved, the draft is shown against that current text.
 */
export function beginEdit({ key, serverText, etag, stored }) {
  const fresh = { mode: "edit", key, text: serverText, etag, base: serverText, previous: null, conflict: null, restored: false };
  if (!stored || stored.mode !== "edit") return fresh;
  const same = stored.text === serverText;
  if (same && !stored.previous) return fresh;
  const moved = Boolean(etag && stored.etag && stored.etag !== etag);
  return {
    mode: "edit",
    key,
    text: stored.text,
    etag: same ? etag : stored.etag || etag,
    base: same ? serverText : (stored.base ?? serverText),
    previous: stored.previous,
    conflict: moved
      ? { sha256: etag, content: serverText, message: changedMessage() }
      : stored.conflict,
    restored: true,
  };
}

export function beginCreate(stored) {
  if (stored?.mode === "create" && (stored.text !== "" || stored.key !== "" || stored.conflict || stored.previous)) {
    return { ...stored, restored: true };
  }
  return { mode: "create", key: "", text: "", etag: null, base: "", previous: null, conflict: null, restored: false };
}

/** The request a Save click sends. Edit and overwrite pass the sha they are based on. */
export function saveRequest({ mode, key, content, etag, requestId }) {
  if (mode === "create") {
    return {
      method: "POST",
      url: "/api/specs",
      headers: { "Content-Type": "application/json" },
      body: { key, content, requestId },
    };
  }
  if (!etag) return null;
  return {
    method: "PUT",
    url: specUrl(key),
    headers: { "Content-Type": "application/json", "If-Match": `"${etag}"` },
    body: { content, requestId },
  };
}

export function changedMessage() {
  return "This spec changed since you opened it. Your draft is still here. Nothing was saved.";
}

export function existsMessage(key) {
  return `A spec already exists at ${key}. Your draft is still here. Nothing was saved.`;
}

/**
 * What a save response means. A 412 whose text is already the draft counts as
 * saved: the write landed, or someone else wrote the same text. Any other
 * 412 keeps the draft and shows the server text. The session is unchanged
 * on a plain error, so the caller still has the draft.
 */
export function applySaveResult(session, { status, body }) {
  if (status === 200 || status === 201) return { view: "saved", sha256: body?.sha256 ?? null };
  const current = body?.current;
  if (status === 412 && current && typeof current.content === "string") {
    if (current.content === session.text) return { view: "saved", sha256: current.sha256 ?? null };
    return {
      view: "conflict",
      session: {
        ...session,
        conflict: { sha256: current.sha256, content: current.content, message: changedMessage() },
      },
    };
  }
  if (status === 409) return { view: "exists", message: body?.message || existsMessage(session.key) };
  return { view: "error", message: body?.message || body?.error || `Save failed (${status}).` };
}

/** Turns a create that found an existing spec into the same review as a 412. */
export function conflictWith(session, current, message) {
  return {
    ...session,
    conflict: { sha256: current.sha256, content: current.content, message },
  };
}

/**
 * Reload the latest. The editor now bases saves on that sha. The draft that
 * was replaced stays on `previous` until a later save succeeds.
 */
export function reloadSession(session, current) {
  let previous = session.text === current.content ? session.previous : session.text;
  if (previous === current.content) previous = null;
  return {
    mode: "edit",
    key: session.key,
    text: current.content,
    etag: current.sha256,
    base: current.content,
    previous,
    conflict: null,
  };
}
