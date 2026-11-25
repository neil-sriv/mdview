/**
 * Uploads a vault's specs, and the revision texts existing threads cite,
 * into the Worker. Current files go through `POST /api/specs` (agent token).
 * Older revisions go through `POST /internal/revisions` (admin token), which
 * writes `revs/` and does not change the current text.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "peanut/anchors/markdown-block";
import { RemoteError, workerFetch } from "./remote.mjs";
import { exportStore, listVaultSpecs, openStoreDb, referencedRevisions, rekeyDocument } from "./transfer.mjs";
import { storeHome } from "./store.mjs";

const SOURCE_REV = /^[0-9a-f]{7,64}$/i;

export async function seedVault({ vault, sourceRev, exportFile, env, fetchImpl, out }) {
  if (!SOURCE_REV.test(sourceRev ?? "")) throw new Error("sourceRev must be the hex commit the vault was read at.");
  const found = listVaultSpecs(vault);
  if (found.missing) throw new Error(`No projects/ directory in ${vault}.`);
  if (found.skipped.length) {
    throw new Error(`These files are not spec keys:\n${found.skipped.map((rel) => `  ${rel}`).join("\n")}`);
  }
  if (!found.specs.length) throw new Error(`No specs under ${vault}/projects/*/specs/.`);

  const created = [];
  const same = [];
  for (const spec of found.specs) {
    const content = fs.readFileSync(spec.file, "utf8");
    try {
      const { payload } = await workerFetch(env, "POST", "/api/specs", {
        role: "agent",
        fetchImpl,
        body: { key: spec.key, content, sourceRev, requestId: crypto.randomUUID() },
      });
      created.push(spec.key);
      out?.write(`${spec.key}  ${payload.sha256}\n`);
    } catch (err) {
      if (!(err instanceof RemoteError) || err.status !== 409) throw err;
      const current = await workerFetch(env, "GET", `/api/specs/${encodeKey(spec.key)}`, { role: "agent", fetchImpl });
      if (sha256(current.text) !== sha256(content)) {
        throw new Error(`${spec.key} is already on the Worker with different text. Nothing was overwritten.`);
      }
      same.push(spec.key);
      out?.write(`${spec.key}  unchanged\n`);
    }
  }

  const payload = exportFile ? JSON.parse(fs.readFileSync(exportFile, "utf8")) : exportFromVault(vault, env);
  let revisions = 0;
  for (const revision of referencedRevisions(payload)) {
    await workerFetch(env, "POST", "/internal/revisions", {
      role: "admin",
      fetchImpl,
      body: {
        key: revision.key,
        content: revision.content,
        sha256: revision.sha256,
        sourceRev,
      },
    });
    revisions += 1;
  }
  return { created, same, revisions };
}

function exportFromVault(vault, env) {
  const file = path.join(storeHome(env), "peanut.sqlite3");
  const db = openStoreDb(file, { readOnly: true });
  try {
    return exportStore(db, { rekey: (key) => rekeyDocument(key, vault) });
  } finally {
    db.close();
  }
}

function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}
