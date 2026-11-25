/**
 * `mdview store` moves the Mac comment file. export writes the portable JSON.
 * import and observe talk to the Worker with the admin token. verify only
 * reads both sides. restore is the rollback: spec keys become vault paths in
 * a fresh local file.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { RemoteError, workerFetch } from "./remote.mjs";
import { openStore, storeHome } from "./store.mjs";
import {
  TransferError,
  compareParity,
  exportStore,
  importInto,
  localParity,
  openStoreDb,
  rekeyDocument,
  vaultFileForSpec,
} from "./transfer.mjs";

const USAGE = `Usage: mdview store <command> [options]

Moves the Mac comment store. export reads the local SQLite file. import,
observe and verify talk to the Worker. verify only reads.

Commands:
  export [--rekey-vault <dir>] [--out <file>]
                                    Dump threads, messages, revisions and documents.
                                    --rekey-vault rewrites each Mac path to <project>/<file>.md.
  import <file> [--force]           POST the export to /internal/import.
                                    Refuses a store that already holds something else.
  observe                           Observe every spec so the latest revision matches R2.
  verify --rekey-vault <dir>        Dry run. Compare thread counts, the inbox, and that
                                    every thread's block anchor resolves. Writes nothing.
  restore <file> --vault <dir>      Roll back: load the export into the local store with
                                    vault paths. Refuses a store that already has comments.

Environment:
  MDVIEW_HOME                       The local store (default: ~/.mdview)
  MDVIEW_URL                        The Worker, for import, observe and verify
  MDVIEW_ACCESS_CLIENT_ID
  MDVIEW_ACCESS_CLIENT_SECRET       Access service token
  MDVIEW_ADMIN_ACCESS_CLIENT_ID
  MDVIEW_ADMIN_ACCESS_CLIENT_SECRET Admin token. Falls back to the access pair.
  MDVIEW_ADMIN_KEY                  Admin key, for a Worker with AUTH_MODE=open
`;

export async function runStore(args, { out = process.stdout, err = process.stderr, env = process.env, fetchImpl } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        "rekey-vault": { type: "string" },
        vault: { type: "string" },
        out: { type: "string" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    err.write(`mdview store: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help || positionals.length === 0) {
    out.write(USAGE);
    return values.help ? 0 : 2;
  }
  const [command, ...rest] = positionals;
  try {
    if (command === "export" && rest.length === 0) return exportCommand(values, env, out);
    if (command === "import" && rest.length === 1) return await importCommand(rest[0], values, env, out, fetchImpl);
    if (command === "observe" && rest.length === 0) return await observeCommand(env, out, fetchImpl);
    if (command === "verify" && rest.length === 0) return await verifyCommand(values, env, out, err, fetchImpl);
    if (command === "restore" && rest.length === 1) return await restoreCommand(rest[0], values, env, out);
    err.write(`mdview store: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof TransferError || error instanceof RemoteError || error.code === "ENOENT") {
      err.write(`mdview store ${command}: ${error.message}\n`);
      return error instanceof RemoteError && error.status ? 1 : 1;
    }
    throw error;
  }
}

function exportCommand(values, env, out) {
  const db = openStoreDb(storeFile(env), { readOnly: true });
  try {
    const rekey = values["rekey-vault"] ? (key) => rekeyDocument(key, values["rekey-vault"]) : null;
    const payload = exportStore(db, { rekey });
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (values.out) {
      fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
      fs.writeFileSync(values.out, text, { mode: 0o600 });
      out.write(`Wrote ${payload.documents.length} documents to ${values.out}\n`);
    } else out.write(text);
  } finally {
    db.close();
  }
  return 0;
}

async function importCommand(file, values, env, out, fetchImpl) {
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  if (values.force) payload.force = true;
  const { payload: body } = await workerFetch(env, "POST", "/internal/import", { role: "admin", body: payload, fetchImpl });
  const again = body.idempotent ? " (already loaded)" : "";
  out.write(`Imported ${body.threads} threads across ${body.documents} documents${again}.\n`);
  return 0;
}

async function observeCommand(env, out, fetchImpl) {
  const { payload } = await workerFetch(env, "POST", "/internal/observe", { role: "admin", body: {}, fetchImpl });
  out.write(`Observed ${payload.observed.length} specs.\n`);
  return 0;
}

async function verifyCommand(values, env, out, err, fetchImpl) {
  if (!values["rekey-vault"]) throw new TransferError("invalid", "verify needs --rekey-vault.");
  const db = openStoreDb(storeFile(env), { readOnly: true });
  const store = await openStore(storeHome(env));
  try {
    const local = localParity(store, db, { vault: values["rekey-vault"] });
    const { payload: remote } = await workerFetch(env, "GET", "/internal/parity", { role: "admin", fetchImpl });
    const problems = compareParity(local, remote);
    out.write(`Dry run. Threads ${local.threads} on the Mac, ${remote.threads} on the Worker. Inbox ${local.inbox} and ${remote.inbox}.\n`);
    for (const doc of local.documents) {
      const unresolved = doc.anchors.filter((anchor) => !anchor.resolved).length;
      out.write(`${doc.key}  ${doc.threads} threads${unresolved ? `, ${unresolved} unresolved` : ""}\n`);
    }
    if (problems.length) {
      for (const problem of problems) err.write(`${problem}\n`);
      return 1;
    }
    out.write("Every thread's block anchor resolves.\n");
    return 0;
  } finally {
    store.close();
    db.close();
  }
}

async function restoreCommand(file, values, env, out) {
  if (!values.vault) throw new TransferError("invalid", "restore needs --vault.");
  const home = storeHome(env);
  const sqlite = storeFile(env);
  if (fs.existsSync(sqlite)) {
    const existing = openStoreDb(sqlite, { readOnly: true });
    try {
      const row = existing.get("SELECT count(*) AS n FROM documents");
      if (Number(row?.n ?? 0) > 0) throw new TransferError("not_empty", "The local store already has comments. Restore into an empty MDVIEW_HOME.");
    } finally {
      existing.close();
    }
  }
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const doc of payload.documents ?? []) {
    const target = vaultFileForSpec(values.vault, doc.key);
    if (!fs.existsSync(target)) throw new TransferError("invalid", `No vault copy at ${target}.`);
    doc.key = fs.realpathSync(target);
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const created = await openStore(home);
  created.close();
  const db = openStoreDb(sqlite);
  try {
    const loaded = importInto(db, payload, { keys: "path" });
    if (!loaded.ok) throw new TransferError(loaded.error, loaded.message);
    out.write(`Restored ${loaded.threads} threads into ${sqlite}.\n`);
  } finally {
    db.close();
  }
  return 0;
}

function storeFile(env) {
  return path.join(storeHome(env), "peanut.sqlite3");
}
