/**
 * One pass of the box backup loop. A timer runs it every 5 minutes.
 *
 * It only GETs. Changed specs come from `GET /api/specs?since=<last>`. The
 * full list is read too, so a vault edit to a spec the Worker has not
 * touched is still overwritten and logged. Bytes are written only when they
 * differ. Nothing is sent back.
 */
import fs from "node:fs";
import path from "node:path";
import { storeHome } from "./store.mjs";
import { sha256Bytes, vaultFileForSpec } from "./transfer.mjs";
import { accessHeaders } from "./remote.mjs";

export async function pullVault({ env = process.env, fetchImpl = globalThis.fetch, now = () => new Date(), log = (line) => console.error(line) } = {}) {
  if (!env.MDVIEW_URL) throw new Error("Set MDVIEW_URL.");
  if (!env.MDVIEW_VAULT) throw new Error("Set MDVIEW_VAULT.");
  const vault = env.MDVIEW_VAULT;
  const startedAt = now().toISOString();
  const statePath = env.MDVIEW_BACKUP_STATE || path.join(storeHome(env), "backup-state.json");
  const since = readSince(statePath);
  const changed = await getJson(env, since ? `/api/specs?since=${encodeURIComponent(since)}` : "/api/specs", fetchImpl);
  const full = since ? await getJson(env, "/api/specs", fetchImpl) : changed;
  const specs = new Map((full.specs ?? []).map((spec) => [spec.key, spec]));
  const todo = new Set((changed.specs ?? []).map((spec) => spec.key));
  for (const spec of specs.values()) {
    const local = readBytes(vaultFileForSpec(vault, spec.key));
    if (local == null || !spec.sha256 || sha256Bytes(local) !== spec.sha256) todo.add(spec.key);
  }

  const written = [];
  const overwritten = [];
  const unchanged = [];
  for (const key of [...todo].sort()) {
    const file = vaultFileForSpec(vault, key);
    const remote = await getBytes(env, `/api/specs/${key.split("/").map(encodeURIComponent).join("/")}`, fetchImpl);
    const local = readBytes(file);
    if (local && local.equals(remote)) {
      unchanged.push(key);
      continue;
    }
    if (local) {
      overwritten.push(key);
      logOverwrite(vault, key, startedAt);
      log(`backup: overwrote ${vaultPath(key)}; the vault copy differed from the Worker`);
    }
    writeBytes(file, remote);
    written.push(key);
  }
  for (const spec of specs.values()) {
    if (!todo.has(spec.key)) unchanged.push(spec.key);
  }
  writeSince(statePath, startedAt);
  return { written, overwritten, unchanged, since: startedAt };
}

async function getJson(env, pathname, fetchImpl) {
  const bytes = await getBytes(env, pathname, fetchImpl);
  const payload = JSON.parse(bytes.toString("utf8"));
  if (!payload || !Array.isArray(payload.specs)) throw new Error(`GET ${pathname} did not return specs.`);
  return payload;
}

async function getBytes(env, pathname, fetchImpl) {
  const res = await fetchImpl(new URL(pathname, env.MDVIEW_URL), {
    method: "GET",
    headers: accessHeaders(env, "agent"),
  });
  if (!res.ok) throw new Error(`GET ${pathname} returned ${res.status}.`);
  return Buffer.from(await res.arrayBuffer());
}

function readBytes(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function writeBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.mdview-tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

function logOverwrite(vault, key, at) {
  const file = path.join(vault, "inbox", "learnings.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = "";
  try {
    const current = fs.readFileSync(file, "utf8");
    if (current.length && !current.endsWith("\n")) prefix = "\n";
  } catch {
    /* the learnings file starts with this line */
  }
  fs.appendFileSync(file, `${prefix}- ${at} backup: overwrote ${vaultPath(key)}; the vault copy differed from the Worker\n`);
}

function vaultPath(key) {
  const [project, ...rest] = key.split("/");
  return `projects/${project}/specs/${rest.join("/")}`;
}

function readSince(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed.since === "string" && parsed.since ? parsed.since : null;
  } catch {
    return null;
  }
}

function writeSince(file, since) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ since })}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
