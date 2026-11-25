import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { normalizeText } from "peanut/anchors/markdown-block";
import { liveServers } from "./registry.mjs";
import { keyHeaders } from "./remote.mjs";
import { docKey, humanName, isWaitingOn, openStore, STATUS_LABELS, StoreError, storeHome } from "./store.mjs";

const USAGE = `Usage: mdview comments <verb> [options]

Reads and answers comments left on Markdown docs in mdview. Agents reply and
suggest resolving. Only a human resolves or reopens a thread.

Verbs:
  list <doc|folder>... [--all] [--waiting-on agent|human] [--full]
                                    Unresolved threads on docs. A folder covers every doc with comments
                                    under it. --all adds resolved threads, --waiting-on keeps the
                                    threads whose turn it is, and --full prints each one like show.
  show <id>...                      Threads in full, with their blocks' source
  reply <id> -m <text>              Add a message
  suggest-resolve <id> -m <text>    Say a thread is done, and what changed
  resolve <id> --human [-m <text>]  Resolve a thread
  reopen <id> --human [-m <text>]   Reopen a thread
  add <doc> (--line <n> | --quote <text>) -m <text>
                                    Start a thread on the block at a line, or the one block containing a quote
  wait <doc|folder>... [--timeout 30m]
                                    Return as soon as anything there waits on the agent, printing it in
                                    full. Answer every such thread before waiting again.

Options:
  -m, --message <text>  The message, in Markdown
      --json            Print JSON instead of text
      --human           Act as the human (MDVIEW_USER, or the OS username) instead of an agent
  -h, --help            Show this help

Exit codes: 0 done, 1 refused (unknown thread, disallowed status change),
2 malformed command, 3 wait timed out.

Environment:
  MDVIEW_AUTHOR         The agent's name on its messages (default: agent)
  MDVIEW_HOME           The store's folder (default: ~/.mdview). Unused when MDVIEW_URL is set.
  MDVIEW_URL            When set, comments go to this server instead of the local store.
                        A doc is then <project>/<file>.md or projects/<project>/specs/<file>.md.
  MDVIEW_ACCESS_CLIENT_ID
  MDVIEW_ACCESS_CLIENT_SECRET
                        Cloudflare Access service token, sent when MDVIEW_URL is set.
  MDVIEW_AGENT_KEY      Agent key, for a Worker with AUTH_MODE=open
`;

const PREVIEW_CHARS = 100;
const DURATION = /^(\d+)(s|m|h)?$/;
const DURATION_MS = { s: 1000, m: 60_000, h: 3_600_000 };
const POLL_MS = 100;
// How often `wait` prints a status line, in the agent-dash watch format ({next:1m}).
const HEARTBEAT_MS = 60_000;

class UsageError extends Error {}

class RemoteError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const AGENT_NAME = /^[a-z0-9 _-]{1,40}$/;

/**
 * A doc argument for the remote server. The vault layout
 * `projects/<project>/specs/<file>.md` is the same doc as `<project>/<file>.md`.
 * A folder `projects/<project>/specs` is `<project>`.
 */
export function remoteDocKey(arg) {
  const norm = String(arg).replaceAll("\\", "/").replace(/\/+$/, "");
  const match = /(?:^|\/)projects\/([^/]+)\/specs(?:\/(.*))?$/.exec(norm);
  if (match) return match[2] ? `${match[1]}/${match[2]}` : match[1];
  return norm.replace(/^\.\//, "");
}

function isDocFile(key) {
  return /\.(md|markdown|mdx)$/i.test(key);
}

function remoteHeaders(env, hasBody) {
  const headers = { "X-Mdview-Author": env.MDVIEW_AUTHOR || "agent" };
  Object.assign(headers, keyHeaders(env, "agent"));
  if (env.MDVIEW_ACCESS_CLIENT_ID) headers["CF-Access-Client-Id"] = env.MDVIEW_ACCESS_CLIENT_ID;
  if (env.MDVIEW_ACCESS_CLIENT_SECRET) headers["CF-Access-Client-Secret"] = env.MDVIEW_ACCESS_CLIENT_SECRET;
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

async function remoteCall(env, method, pathname, body) {
  const headers = remoteHeaders(env, body !== undefined);
  let res;
  try {
    res = await fetch(new URL(pathname, env.MDVIEW_URL), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new RemoteError(`Could not reach ${env.MDVIEW_URL}: ${err.message}`);
  }
  if (res.status === 204) {
    await res.body?.cancel();
    return null;
  }
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) throw new RemoteError(payload?.error || text || `HTTP ${res.status}`, res.status);
  return payload;
}

function groupRemote(items) {
  const groups = new Map();
  for (const item of items) {
    let group = groups.get(item.document);
    if (!group) {
      group = { doc: item.document, version: item.revision, threads: [] };
      groups.set(item.document, group);
    }
    group.threads.push(item.thread);
  }
  return [...groups.values()];
}

function inScope(doc, scope) {
  if (isDocFile(scope)) return doc === scope;
  const prefix = scope.replace(/\/$/, "");
  return doc === prefix || doc.startsWith(`${prefix}/`);
}

/**
 * list's text and JSON, from the agent API's flat thread list. A file named
 * outright is always reported. A folder adds the docs under it that are not
 * already included, and says so when it has none.
 */
function remoteListed(items, targets, values) {
  const byDoc = new Map(groupRemote(items).map((group) => [group.doc, group]));
  const waitingOn = values["waiting-on"];
  const chosen = [];
  const notes = [];
  for (const target of targets) {
    const key = remoteDocKey(target);
    if (isDocFile(key)) {
      if (!chosen.some((item) => item.key === key)) chosen.push({ key, explicit: true, group: byDoc.get(key) });
      continue;
    }
    const found = [...byDoc.values()].filter((group) => inScope(group.doc, key));
    if (!found.length) notes.push(`No comments under ${key}.`);
    for (const group of found) {
      if (!chosen.some((item) => item.key === group.doc)) chosen.push({ key: group.doc, explicit: false, group });
    }
  }
  const sections = [...notes];
  const json = [];
  for (const { key, explicit, group } of chosen) {
    if (!group) {
      sections.push(`No comments on ${key}.`);
      json.push({ doc: key, version: null, threads: [] });
      continue;
    }
    const threads = group.threads.filter((t) => (values.all || t.status !== "resolved") && (!waitingOn || isWaitingOn(t, waitingOn)));
    if (!threads.length && !explicit) continue;
    json.push({ ...group, threads });
    sections.push(listText(group, threads, { full: values.full, waitingOn }));
  }
  if (!sections.length) {
    sections.push(waitingOn ? `Nothing is waiting on the ${waitingOn}.` : "Every thread is resolved. Pass --all to see them.");
  }
  return { text: `${sections.map((s) => s.trimEnd()).join("\n\n")}\n`, json };
}

async function remoteList(targets, values, env) {
  const waitingOn = values["waiting-on"];
  if (waitingOn !== undefined && waitingOn !== "agent" && waitingOn !== "human") {
    throw new UsageError(`--waiting-on must be agent or human, not ${waitingOn}`);
  }
  const params = new URLSearchParams();
  for (const target of targets) params.append("scope", remoteDocKey(target));
  params.set("all", "1");
  const body = await remoteCall(env, "GET", `/api/agent/threads?${params}`);
  return remoteListed(body.threads, targets, values);
}

async function remoteShow(ids, env) {
  const results = [];
  for (const id of ids) {
    const body = await remoteCall(env, "GET", `/api/agent/threads/${encodeURIComponent(id)}`);
    results.push({ doc: body.document, version: body.revision, thread: body.thread });
  }
  return { text: `${results.map((r) => showText(r).trimEnd()).join(FULL_THREAD_SEPARATOR)}\n`, json: results };
}

async function remoteActed(env, id, sentence) {
  const body = await remoteCall(env, "GET", `/api/agent/threads/${encodeURIComponent(id)}`);
  const result = { doc: body.document, version: body.revision, thread: body.thread };
  return { text: `${sentence}\n${headline(result.thread)}\n`, json: result };
}

async function remoteReply(id, values, env) {
  const message = requireMessage(values, "reply");
  await remoteCall(env, "POST", `/api/agent/threads/${encodeURIComponent(id)}/reply`, { message, requestId: crypto.randomUUID() });
  return remoteActed(env, id, `Replied to #${id}.`);
}

async function remoteSuggest(id, values, env) {
  const message = requireMessage(values, "suggest-resolve");
  await remoteCall(env, "POST", `/api/agent/threads/${encodeURIComponent(id)}/suggest-resolve`, { message, requestId: crypto.randomUUID() });
  return remoteActed(env, id, `Suggested resolving #${id}. It now waits on the human.`);
}

function remoteHumanOnly(values, verb) {
  requireHuman(values, verb);
  throw new StoreError(`Remote comments use an agent token, so they can't ${verb} a thread.`);
}

async function remoteAdd(docArg, values, env) {
  const message = requireMessage(values, "add");
  if (values.line === undefined && values.quote === undefined) throw new UsageError("add needs --line <n> or --quote <text>");
  const line = values.line === undefined ? undefined : Number(values.line);
  if (line !== undefined && !(Number.isInteger(line) && line >= 1)) throw new UsageError(`--line must be a line number, not ${values.line}`);
  const pathKey = remoteDocKey(docArg);
  const payload = { path: pathKey, message, requestId: crypto.randomUUID() };
  if (line !== undefined) payload.line = line;
  if (values.quote !== undefined) payload.quote = values.quote;
  const { id } = await remoteCall(env, "POST", "/api/agent/threads", payload);
  const shown = await remoteCall(env, "GET", `/api/agent/threads/${id}`);
  return {
    text: `Started thread #${id} on ${lineRange(shown.thread.lines)} of ${pathKey}.\n`,
    json: { doc: shown.document, version: shown.revision, thread: shown.thread },
  };
}

async function remoteWait(targets, values, env, { progress }) {
  const timeout = parseDuration(values.timeout ?? "30m", "--timeout");
  const keys = targets.map(remoteDocKey);
  const label = keys.join(", ");
  const deadline = Date.now() + timeout;
  const query = (seconds) => {
    const params = new URLSearchParams();
    for (const key of keys) params.append("scope", key);
    params.set("after", "0");
    params.set("timeout", String(seconds));
    return params;
  };
  const ready = await remoteCall(env, "GET", `/api/agent/wait?${query(0)}`);
  const full = { ...values, "waiting-on": "agent", full: true };
  if (ready) return remoteList(targets, full, env);
  progress(`waiting for comments on ${label} {next:1m}\n`);
  const heartbeat = setInterval(() => progress(`waiting for comments on ${label} {next:1m}\n`), HEARTBEAT_MS);
  try {
    while (Date.now() < deadline) {
      const slice = Math.min(55, Math.ceil((deadline - Date.now()) / 1000));
      if (slice < 1) break;
      const body = await remoteCall(env, "GET", `/api/agent/wait?${query(slice)}`);
      if (body) return remoteList(targets, full, env);
    }
  } finally {
    clearInterval(heartbeat);
  }
  return { text: `Nothing waited on the agent in ${label} after ${formatDuration(timeout)}.\n`, json: { timedOut: true }, code: 3 };
}

async function runRemote(verb, targets, values, env, hooks) {
  const author = env.MDVIEW_AUTHOR || "agent";
  if (!AGENT_NAME.test(author)) {
    throw new UsageError(`MDVIEW_AUTHOR must be 1-40 characters of lowercase letters, digits, spaces, _ or -, not ${author}`);
  }
  if (verb === "list") return remoteList(targets, values, env);
  if (verb === "show") return remoteShow(targets, env);
  if (verb === "reply") return remoteReply(targets, values, env);
  if (verb === "suggest-resolve") return remoteSuggest(targets, values, env);
  if (verb === "resolve") return remoteHumanOnly(values, "resolve");
  if (verb === "reopen") return remoteHumanOnly(values, "reopen");
  if (verb === "add") return remoteAdd(targets, values, env);
  if (verb === "wait") return remoteWait(targets, values, env, hooks);
  throw new UsageError(`unknown verb "${verb}"`);
}

function parseDuration(text, flag) {
  const match = DURATION.exec(text);
  if (!match || Number(match[1]) === 0) throw new UsageError(`${flag} must look like 30s, 10m or 1h, not ${text}`);
  return Number(match[1]) * DURATION_MS[match[2] ?? "s"];
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60}m` : `${seconds}s`;
}


function authorFrom(values, env) {
  if (values.human) return { name: humanName(env), kind: "human", session: null };
  return {
    name: env.MDVIEW_AUTHOR || "agent",
    kind: "agent",
    session: env.MDVIEW_SESSION || env.CURSOR_CONVERSATION_ID || env.TERM_SESSION_ID || null,
  };
}

function requireMessage(values, verb) {
  if (!values.message?.trim()) throw new UsageError(`${verb} needs a message: -m <text>`);
  return values.message;
}

function requireHuman(values, verb) {
  if (!values.human) {
    throw new StoreError(`Only a human may ${verb} a thread (pass --human if that is you). Agents use suggest-resolve.`);
  }
}

/* Text output */

function displayPath(file) {
  const rel = path.relative(process.cwd(), file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

function when(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date().toDateString()) return clock;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function lineRange([start, end]) {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function where(thread) {
  const at = thread.lines ? lineRange(thread.lines) + (thread.heading ? ` under "${truncate(thread.heading, 60)}"` : "") : "";
  if (thread.state === "current") return at;
  if (thread.state === "carried") return `${at} · from v${thread.madeOn.seq}, block unchanged`;
  return `outdated: made on v${thread.madeOn.seq}, block changed since${at ? ` (was ${at})` : ""}`;
}

function headline(thread) {
  return [`#${thread.id} ${STATUS_LABELS[thread.status]}`, thread.waitingOn && `waiting on ${thread.waitingOn}`, where(thread)]
    .filter(Boolean)
    .join(" · ");
}

function quoteLine(thread) {
  if (thread.quote) return `> ${truncate(normalizeText(thread.quote), PREVIEW_CHARS)}`;
  return `> (whole block) ${truncate(normalizeText(thread.source ?? ""), PREVIEW_CHARS)}`;
}

function listedMessage(m) {
  const [first, ...rest] = m.body.split("\n");
  return [`  ${m.author} (${when(m.sentAt)}, v${m.versionSeq}): ${first}`, ...rest.map((line) => `      ${line}`)].join("\n");
}

// Printed between threads shown in full, whose own blank lines would otherwise blur together.
const FULL_THREAD_SEPARATOR = "\n\n---\n\n";

function listText(result, threads, { full, waitingOn }) {
  const counts = Object.entries(STATUS_LABELS)
    .map(([status, label]) => [result.threads.filter((t) => t.status === status).length, label])
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(", ");
  const head = `${displayPath(result.doc)} · v${result.version.latestSeq} · ${counts}`;
  if (!threads.length) {
    const unresolved = result.threads.some((t) => t.status !== "resolved");
    return `${head}\n\n${waitingOn && unresolved ? `Nothing is waiting on the ${waitingOn}.` : "Every thread is resolved. Pass --all to see them."}\n`;
  }
  if (full) {
    const shown = threads.map((thread) => showText({ doc: result.doc, version: result.version, thread }).trimEnd());
    return `${head}\n\n${shown.join(FULL_THREAD_SEPARATOR)}\n`;
  }
  const summaries = threads.map((t) => [headline(t), `  ${quoteLine(t)}`, ...t.messages.map(listedMessage)].join("\n"));
  return `${[head, ...summaries].join("\n\n")}\n`;
}

function showText({ doc, version, thread: t }) {
  const blockSeq = t.state === "outdated" ? t.madeOn.seq : version.seq;
  const block = [t.source === null ? "Block: not found." : `Block in v${blockSeq}, ${lineRange(t.lines)}:\n${indent(t.source, "    ")}`];
  if (t.state === "outdated") {
    block.push(
      t.nowReads
        ? `Now reads, in v${version.seq}, ${lineRange(t.nowReads.lines)}:\n${indent(t.nowReads.source, "    ")}`
        : `No block in v${version.seq} resembles it, so it was removed or rewritten.`,
    );
  }
  const messages = t.messages.map((m) => `${m.author} · ${when(m.sentAt)} · v${m.versionSeq}\n${indent(m.body, "    ")}`);
  return `${[
    [`#${t.id} ${STATUS_LABELS[t.status]}`, t.waitingOn && `waiting on ${t.waitingOn}`, displayPath(doc)].filter(Boolean).join(" · "),
    `${where(t)} · latest is v${version.latestSeq}`,
    "",
    block.join("\n\n"),
    "",
    quoteLine(t),
    "",
    messages.join("\n\n"),
  ].join("\n")}\n`;
}

/* Verbs */

/**
 * The docs that `list` targets name, each once: files as given (`explicit`),
 * then every doc with comments under each folder. Notes say which folders
 * held none.
 */
function docsFor(store, targets) {
  const docs = new Map();
  const notes = [];
  for (const target of targets) {
    const abs = path.resolve(target);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      const found = store.docsUnder(abs);
      if (!found.length) notes.push(`No comments under ${displayPath(abs)}.`);
      for (const file of found) if (!docs.has(file)) docs.set(file, { file, explicit: false });
    } else if (stat || store.findDoc(abs)) {
      docs.set(docKey(abs), { file: abs, explicit: true });
    } else {
      throw new UsageError(`No such file or folder: ${target}`);
    }
  }
  return { docs: [...docs.values()], notes };
}

/**
 * Lists threads on every targeted doc in one call. Docs found under a folder
 * appear only when they have threads left after filtering, while a file named
 * outright always gets a line.
 */
function list(store, targets, values) {
  const waitingOn = values["waiting-on"];
  if (waitingOn !== undefined && waitingOn !== "agent" && waitingOn !== "human") {
    throw new UsageError(`--waiting-on must be agent or human, not ${waitingOn}`);
  }
  const { docs, notes } = docsFor(store, targets);
  const sections = [...notes];
  const json = [];
  for (const { file, explicit } of docs) {
    const tracked = store.observe(file);
    const result = store.threadsAt(file);
    // A doc whose only threads are the human's unsent drafts has no comments, as far as an agent can tell.
    if (!result?.threads.length) {
      if (explicit) {
        sections.push(`No comments on ${displayPath(file)}.`);
        json.push({ doc: docKey(file), version: null, threads: [] });
      }
      continue;
    }
    const threads = result.threads.filter(
      (t) => (values.all || t.status !== "resolved") && (!waitingOn || isWaitingOn(t, waitingOn)),
    );
    if (!threads.length && !explicit) continue;
    json.push({ ...result, threads });
    const missing = tracked.missing ? "The file is missing, so this shows its last version.\n" : "";
    sections.push(missing + listText(result, threads, { full: values.full, waitingOn }));
  }
  if (!sections.length) {
    sections.push(waitingOn ? `Nothing is waiting on the ${waitingOn}.` : "Every thread is resolved. Pass --all to see them.");
  }
  return { text: `${sections.map((s) => s.trimEnd()).join("\n\n")}\n`, json };
}

function show(store, ids) {
  const results = ids.map((id) => {
    store.observe(store.docOf(id));
    return store.thread(id);
  });
  return { text: `${results.map((r) => showText(r).trimEnd()).join(FULL_THREAD_SEPARATOR)}\n`, json: results };
}

function acted(store, id, sentence) {
  const result = store.thread(id);
  return { text: `${sentence}\n${headline(result.thread)}\n`, json: result };
}

function reply(store, id, values, author) {
  store.reply(id, requireMessage(values, "reply"), author);
  return acted(store, id, `Replied to #${id}.`);
}

function suggestResolve(store, id, values, author) {
  store.setStatus(id, "suggested", author, requireMessage(values, "suggest-resolve"));
  return acted(store, id, `Suggested resolving #${id}. It now waits on the human.`);
}

function resolve(store, id, values, author) {
  requireHuman(values, "resolve");
  store.setStatus(id, "resolved", author, values.message);
  return acted(store, id, `Resolved #${id}.`);
}

function reopen(store, id, values, author) {
  requireHuman(values, "reopen");
  store.setStatus(id, "open", author, values.message);
  return acted(store, id, `Reopened #${id}.`);
}

function add(store, docArg, values, author) {
  const body = requireMessage(values, "add");
  if (values.line === undefined && values.quote === undefined) throw new UsageError("add needs --line <n> or --quote <text>");
  const line = values.line === undefined ? undefined : Number(values.line);
  if (line !== undefined && !(Number.isInteger(line) && line >= 1)) throw new UsageError(`--line must be a line number, not ${values.line}`);
  const file = path.resolve(docArg);
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`No such file: ${docArg}`);
  }
  store.observe(file, content);
  const id = store.createThread({ file, content, line, quote: values.quote ?? "", body, author });
  const result = store.thread(id);
  return { text: `Started thread #${id} on ${lineRange(result.thread.lines)} of ${displayPath(file)}.\n`, json: result };
}

/** Splits `wait` targets into docs and folders, refusing names that are neither. */
function scopeOf(store, targets) {
  const scope = { files: [], folders: [] };
  for (const target of targets) {
    const abs = path.resolve(target);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (stat?.isDirectory()) scope.folders.push(abs);
    else if (stat || store.findDoc(abs)) scope.files.push(abs);
    else throw new UsageError(`No such file or folder: ${target}`);
  }
  return scope;
}

/**
 * Calls `onChange` whenever the store may have changed. A running viewer's
 * doorbell rings within milliseconds of a browser comment. SQLite's change
 * counter, read every POLL_MS, covers writes when no viewer runs and any ring
 * that gets lost. Returns a function that stops listening.
 */
function listenForChanges(store, home, onChange) {
  let token = store.changeToken();
  const poller = setInterval(() => {
    const next = store.changeToken();
    if (next !== token) {
      token = next;
      onChange();
    }
  }, POLL_MS);
  const viewer = liveServers(home)[0];
  const request =
    viewer &&
    http.get({ host: "127.0.0.1", port: viewer.port, path: "/api/store-events" }, (res) => {
      if (res.statusCode !== 200) return res.resume();
      // Anything that landed while the stream was opening has rung nobody, so look once now.
      onChange();
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          if (/^event: change$/m.test(buffer.slice(0, end))) onChange();
          buffer = buffer.slice(end + 2);
        }
      });
    });
  request?.on("error", () => {});
  return () => {
    clearInterval(poller);
    request?.destroy();
  };
}

/**
 * Returns once anything in scope waits on the agent: at once if something
 * already does, otherwise the moment a write makes it so. Prints those
 * threads in full, as list --waiting-on agent --full does. There is no
 * cursor, so an agent must answer every thread waiting on it before it waits
 * again, or the same threads return at once.
 */
async function wait(store, targets, values, author, { progress, home }) {
  const timeout = parseDuration(values.timeout ?? "30m", "--timeout");
  const scope = scopeOf(store, targets);
  const label = targets.map((target) => displayPath(path.resolve(target))).join(", ");
  const found = () => list(store, targets, { ...values, "waiting-on": "agent", full: true });
  if (store.waitingOnAgent(scope).length) return found();

  progress(`waiting for comments on ${label} {next:1m}\n`);
  const arrived = await new Promise((resolve) => {
    let done = false;
    let stop = () => {};
    let timer;
    let heartbeat;
    // A ring can still arrive after finishing, when the store is about to close, so later calls do nothing.
    const finish = (value) => {
      if (done) return;
      done = true;
      stop();
      clearTimeout(timer);
      clearInterval(heartbeat);
      resolve(value);
    };
    const check = () => {
      if (!done && store.waitingOnAgent(scope).length) finish(true);
    };
    stop = listenForChanges(store, home, check);
    timer = setTimeout(() => finish(false), timeout);
    heartbeat = setInterval(() => progress(`waiting for comments on ${label} {next:1m}\n`), HEARTBEAT_MS);
    check();
  });
  if (arrived) return found();
  return { text: `Nothing waited on the agent in ${label} after ${formatDuration(timeout)}.\n`, json: { timedOut: true }, code: 3 };
}

// Verbs marked `many` take every positional argument; the rest take exactly one.
const VERBS = {
  list: { arg: "<doc|folder>...", many: true, run: list },
  show: { arg: "<id>...", many: true, run: show },
  reply: { arg: "<id>", run: reply },
  "suggest-resolve": { arg: "<id>", run: suggestResolve },
  resolve: { arg: "<id>", run: resolve },
  reopen: { arg: "<id>", run: reopen },
  add: { arg: "<doc>", run: add },
  wait: { arg: "<doc|folder>...", many: true, run: wait },
};

/**
 * Runs `mdview comments <args>` and returns the exit code: 0 on success, 1
 * when the store refuses (an unknown thread, a disallowed status change),
 * 2 for a malformed command, and 3 when `wait` times out.
 */
export async function runComments(args, { out = process.stdout, err = process.stderr, env = process.env } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        message: { type: "string", short: "m" },
        json: { type: "boolean" },
        human: { type: "boolean" },
        all: { type: "boolean" },
        full: { type: "boolean" },
        "waiting-on": { type: "string" },
        line: { type: "string" },
        quote: { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    err.write(`mdview comments: ${error.message}\n\n${USAGE}`);
    return 2;
  }

  const [verb, ...targets] = positionals;
  if (values.help) {
    out.write(USAGE);
    return 0;
  }
  const spec = VERBS[verb];
  if (!spec) {
    err.write(`${verb ? `mdview comments: unknown verb "${verb}"\n\n` : ""}${USAGE}`);
    return 2;
  }
  if (!targets.length) {
    err.write(`mdview comments ${verb}: missing ${spec.arg}\n`);
    return 2;
  }
  if (!spec.many && targets.length > 1) {
    err.write(`mdview comments ${verb}: takes one ${spec.arg}, not ${targets.length}\n`);
    return 2;
  }

  let store;
  try {
    // Progress lines would break JSON on stdout, so they move to stderr with --json.
    const progress = (line) => (values.json ? err : out).write(line);
    let result;
    if (env.MDVIEW_URL) {
      result = await runRemote(verb, spec.many ? targets : targets[0], values, env, { progress });
    } else {
      store = await openStore(storeHome(env));
      result = await spec.run(store, spec.many ? targets : targets[0], values, authorFrom(values, env), {
        progress,
        home: storeHome(env),
      });
    }
    out.write(values.json ? `${JSON.stringify(result.json, null, 2)}\n` : result.text);
    return result.code ?? 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err.write(`mdview comments ${verb}: ${error.message}\n`);
      return 2;
    }
    if (error instanceof StoreError || error instanceof RemoteError) {
      const missingTarget = error instanceof RemoteError && error.status === 404 && (verb === "list" || verb === "add" || verb === "wait");
      err.write(`mdview comments ${verb}: ${error.message}\n`);
      return missingTarget ? 2 : 1;
    }
    throw error;
  } finally {
    store?.close();
  }
}
