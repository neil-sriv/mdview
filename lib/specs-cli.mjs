/**
 * `mdview specs` talks only to the Worker (MDVIEW_URL). get saves the ETag
 * it received; put sends that ETag as If-Match.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { keyHeaders } from "./remote.mjs";
import { storeHome } from "./store.mjs";

const USAGE = `Usage: mdview specs <command> [options]

Reads and edits specs on the Worker. Set MDVIEW_URL. A local files-and-SQLite
viewer does not serve these commands.

Commands:
  list [--project p] [--prefix p] [--since <iso>] [--json]
  get <key>
  new <key> <file>
  put <key> <file>
  move <key> <to>
  delete <key>                      Remove a spec (after get). Its revisions and threads stay.
  revisions <key> [<sha256>]
  seed --vault <dir> --source-rev <sha> [--export <file>]
                                    Upload every projects/<project>/specs file, including
                                    index.md, and the revision texts threads cite.

A key is <project>/<file>.md. get prints the text and remembers its ETag.
put sends that ETag as If-Match. If the spec changed, put exits 3 and prints
the current text.

Environment:
  MDVIEW_URL                    The Worker, for example https://specs.neilsriv.tech
  MDVIEW_AUTHOR                 The agent's name (default: agent)
  MDVIEW_ACCESS_CLIENT_ID
  MDVIEW_ACCESS_CLIENT_SECRET   Access service token
  MDVIEW_ADMIN_ACCESS_CLIENT_ID
  MDVIEW_ADMIN_ACCESS_CLIENT_SECRET
                                Admin token for seed's revision upload. Falls back to the access pair.
  MDVIEW_AGENT_KEY              Agent key, for a Worker with AUTH_MODE=open
  MDVIEW_ADMIN_KEY              Admin key for seed's revision upload in open mode
  MDVIEW_HOME                   Where the saved ETags live (default: ~/.mdview)
`;

const AGENT_NAME = /^[a-z0-9 _-]{1,40}$/;

class UsageError extends Error {}

function etagPath(env) {
  return path.join(storeHome(env), "etags.json");
}

function readEtags(env) {
  try {
    return JSON.parse(fs.readFileSync(etagPath(env), "utf8"));
  } catch {
    return {};
  }
}

function saveEtag(env, key, sha) {
  const all = readEtags(env);
  all[key] = sha;
  fs.mkdirSync(path.dirname(etagPath(env)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(etagPath(env), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}

function forgetEtag(env, key) {
  const all = readEtags(env);
  delete all[key];
  fs.mkdirSync(path.dirname(etagPath(env)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(etagPath(env), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}

function shaFrom(header) {
  const match = /^(?:W\/)?"?([0-9a-f]{64})"?$/i.exec(header ?? "");
  return match ? match[1] : null;
}

function headers(env, { json = false, ifMatch } = {}) {
  const out = { "X-Mdview-Author": env.MDVIEW_AUTHOR || "agent" };
  Object.assign(out, keyHeaders(env, "agent"));
  if (env.MDVIEW_ACCESS_CLIENT_ID) out["CF-Access-Client-Id"] = env.MDVIEW_ACCESS_CLIENT_ID;
  if (env.MDVIEW_ACCESS_CLIENT_SECRET) out["CF-Access-Client-Secret"] = env.MDVIEW_ACCESS_CLIENT_SECRET;
  if (json) out["Content-Type"] = "application/json";
  if (ifMatch) out["If-Match"] = `"${ifMatch}"`;
  return out;
}

async function call(env, method, pathname, { body, ifMatch } = {}) {
  let res;
  try {
    res = await fetch(new URL(pathname, env.MDVIEW_URL), {
      method,
      headers: headers(env, { json: body !== undefined, ifMatch }),
      body: body === undefined ? undefined : JSON.stringify({ ...body, requestId: crypto.randomUUID() }),
    });
  } catch (err) {
    throw new UsageError(`Could not reach ${env.MDVIEW_URL}: ${err.message}`);
  }
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  const payload = type.includes("json") && text ? JSON.parse(text) : text;
  return { status: res.status, payload, etag: shaFrom(res.headers.get("etag")), text };
}

function fail(status, payload) {
  const message = payload && typeof payload === "object" ? payload.message || payload.error : payload;
  const error = new Error(message || `HTTP ${status}`);
  error.status = status;
  error.payload = payload;
  return error;
}

async function list(values, env, out) {
  const params = new URLSearchParams();
  if (values.project) params.set("project", values.project);
  if (values.prefix) params.set("prefix", values.prefix);
  if (values.since) params.set("since", values.since);
  const { status, payload } = await call(env, "GET", `/api/specs?${params}`);
  if (status !== 200) throw fail(status, payload);
  if (values.json) {
    out.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  for (const spec of payload.specs) {
    out.write(`${spec.key}  ${spec.sha256}  ${spec.updatedAt ?? ""}  ${spec.updatedBy ?? ""}\n`);
  }
}

async function get(key, env, out) {
  const { status, payload, etag, text } = await call(env, "GET", `/api/specs/${key.split("/").map(encodeURIComponent).join("/")}`);
  if (status === 404) throw fail(status, payload);
  if (status !== 200) throw fail(status, payload);
  if (etag) saveEtag(env, key, etag);
  out.write(text);
}

async function create(key, file, env, out, err) {
  const content = readFile(file);
  const { status, payload, etag } = await call(env, "POST", "/api/specs", { body: { key, content } });
  if (status !== 201) throw fail(status, payload);
  saveEtag(env, key, etag || payload.sha256);
  out.write(`${key}  ${payload.sha256}\n`);
  err.write(`Created ${key}.\n`);
}

async function put(key, file, env, out, err) {
  const ifMatch = readEtags(env)[key];
  if (!ifMatch) throw new UsageError(`No saved ETag for ${key}. Run mdview specs get ${key} first.`);
  const content = readFile(file);
  const { status, payload } = await call(env, "PUT", `/api/specs/${key.split("/").map(encodeURIComponent).join("/")}`, { body: { content }, ifMatch });
  if (status === 412) {
    out.write(payload?.current?.content ?? "");
    if (payload?.current?.content && !payload.current.content.endsWith("\n")) out.write("\n");
    err.write(`mdview specs put: the spec changed (${payload?.current?.sha256 ?? "unknown"}). Nothing was written.\n`);
    return 3;
  }
  if (status !== 200) throw fail(status, payload);
  saveEtag(env, key, payload.sha256);
  out.write(`${key}  ${payload.sha256}\n`);
  return 0;
}

async function move(key, to, env, out) {
  const ifMatch = readEtags(env)[key];
  if (!ifMatch) throw new UsageError(`No saved ETag for ${key}. Run mdview specs get ${key} first.`);
  const { status, payload } = await call(env, "POST", `/api/specs/${key.split("/").map(encodeURIComponent).join("/")}/move`, {
    body: { to },
    ifMatch,
  });
  if (status !== 200) throw fail(status, payload);
  forgetEtag(env, key);
  saveEtag(env, to, payload.sha256 || ifMatch);
  out.write(`${to}\n`);
}

async function remove(key, env, out) {
  const ifMatch = readEtags(env)[key];
  if (!ifMatch) throw new UsageError(`No saved ETag for ${key}. Run mdview specs get ${key} first.`);
  const { status, payload } = await call(env, "POST", `/api/specs/${key.split("/").map(encodeURIComponent).join("/")}/delete`, { body: {}, ifMatch });
  if (status !== 200) throw fail(status, payload);
  forgetEtag(env, key);
  out.write(`Deleted ${key}.\n`);
}

async function revisions(key, sha, env, out) {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  if (!sha) {
    const { status, payload } = await call(env, "GET", `/api/specs/${encoded}/revisions`);
    if (status !== 200) throw fail(status, payload);
    for (const rev of payload.revisions) out.write(`${rev.sha256}  ${rev.updatedAt ?? ""}  ${rev.updatedBy ?? ""}\n`);
    return;
  }
  const { status, payload, text } = await call(env, "GET", `/api/specs/${encoded}/revisions/${sha}`);
  if (status !== 200) throw fail(status, payload);
  out.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
}

async function seedCommand(values, env, out) {
  if (!values.vault) throw new UsageError("seed needs --vault.");
  if (!values["source-rev"]) throw new UsageError("seed needs --source-rev, the commit the vault was read at.");
  const { seedVault } = await import("./seed.mjs");
  try {
    const result = await seedVault({
      vault: values.vault,
      sourceRev: values["source-rev"],
      exportFile: values.export,
      env,
      out,
    });
    out.write(`Seeded ${result.created.length} specs, ${result.same.length} already matched, ${result.revisions} revisions.\n`);
  } catch (error) {
    if (error instanceof UsageError || error.status) throw error;
    throw new UsageError(error.message);
  }
  return 0;
}

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`No such file: ${file}`);
  }
}

export async function runSpecs(args, { out = process.stdout, err = process.stderr, env = process.env } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        project: { type: "string" },
        prefix: { type: "string" },
        since: { type: "string" },
        json: { type: "boolean" },
        vault: { type: "string" },
        "source-rev": { type: "string" },
        export: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    err.write(`mdview specs: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help || positionals.length === 0) {
    out.write(USAGE);
    return values.help ? 0 : 2;
  }
  const [command, ...rest] = positionals;
  if (!env.MDVIEW_URL) {
    err.write(`mdview specs: set MDVIEW_URL. specs are edited on the Worker, not in the local files.\n`);
    return 2;
  }
  const author = env.MDVIEW_AUTHOR || "agent";
  if (!AGENT_NAME.test(author)) {
    err.write(`mdview specs: MDVIEW_AUTHOR must be 1-40 characters of lowercase letters, digits, spaces, _ or -, not ${author}\n`);
    return 2;
  }
  try {
    if (command === "list") return (await list(values, env, out), 0);
    if (command === "get" && rest.length === 1) return (await get(rest[0], env, out), 0);
    if (command === "new" && rest.length === 2) return (await create(rest[0], rest[1], env, out, err), 0);
    if (command === "put" && rest.length === 2) return put(rest[0], rest[1], env, out, err);
    if (command === "move" && rest.length === 2) return (await move(rest[0], rest[1], env, out), 0);
    if (command === "delete" && rest.length === 1) return (await remove(rest[0], env, out), 0);
    if (command === "revisions" && (rest.length === 1 || rest.length === 2)) return (await revisions(rest[0], rest[1], env, out), 0);
    if (command === "seed" && rest.length === 0) return await seedCommand(values, env, out);
    err.write(`mdview specs: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof UsageError || error.status) {
      err.write(`mdview specs ${command}: ${error.message}\n`);
      return error instanceof UsageError ? 2 : 1;
    }
    throw error;
  }
}
