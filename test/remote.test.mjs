import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pullVault } from "../lib/backup.mjs";
import { accessHeaders, workerFetch } from "../lib/remote.mjs";

const KEYS = {
  MDVIEW_URL: "http://worker.test/",
  MDVIEW_AUTHOR: "specs",
  MDVIEW_AGENT_KEY: "agent-key",
  MDVIEW_BACKUP_KEY: "backup-key",
  MDVIEW_ADMIN_KEY: "admin-key",
};

test("each role sends only its own open-mode key", () => {
  const agent = accessHeaders(KEYS, "agent");
  const backup = accessHeaders(KEYS, "backup");
  const admin = accessHeaders(KEYS, "admin");

  assert.equal(agent.Authorization, "Bearer agent-key");
  assert.equal(agent["X-Mdview-Agent"], "specs");
  assert.equal(backup.Authorization, "Bearer backup-key");
  assert.equal(backup["X-Mdview-Agent"], undefined);
  assert.equal(admin.Authorization, "Bearer admin-key");
  assert.equal(admin["X-Mdview-Agent"], undefined);
});

test("no key set means no Authorization header, so Access mode is unchanged", () => {
  const headers = accessHeaders({ MDVIEW_ACCESS_CLIENT_ID: "id", MDVIEW_ACCESS_CLIENT_SECRET: "secret" }, "agent");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["CF-Access-Client-Id"], "id");
});

test("admin calls send the admin key and the backup loop sends the backup key", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    seen.push({ pathname, auth: init.headers.Authorization });
    if (pathname === "/api/specs") return Response.json({ specs: [] });
    return Response.json({ threads: 0, inbox: 0, documents: [] });
  };
  await workerFetch(KEYS, "GET", "/internal/parity", { role: "admin", fetchImpl });
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-remote-"));
  await pullVault({ env: { ...KEYS, MDVIEW_VAULT: vault, MDVIEW_BACKUP_STATE: path.join(vault, "state.json") }, fetchImpl });

  assert.deepEqual(seen.find((call) => call.pathname === "/internal/parity").auth, "Bearer admin-key");
  assert.ok(seen.filter((call) => call.pathname === "/api/specs").every((call) => call.auth === "Bearer backup-key"));
});
