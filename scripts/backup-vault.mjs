#!/usr/bin/env node
/**
 * One backup pass. A systemd timer on the box runs this every 5 minutes
 * with the read-only backup token. See MIGRATION.md.
 *
 *   MDVIEW_URL                  https://specs.neilsriv.tech
 *   MDVIEW_VAULT                /home/box/vaults/agent-brain
 *   MDVIEW_ACCESS_CLIENT_ID     backup service token
 *   MDVIEW_ACCESS_CLIENT_SECRET
 *   MDVIEW_BACKUP_KEY           the backup key, when the Worker runs AUTH_MODE=open
 *   MDVIEW_BACKUP_STATE         optional cursor file (default: $MDVIEW_HOME/backup-state.json)
 */
import { pullVault } from "../lib/backup.mjs";

try {
  const result = await pullVault({ env: process.env });
  console.log(`backup: ${result.written.length} written, ${result.overwritten.length} overwritten, ${result.unchanged.length} unchanged`);
} catch (err) {
  console.error(`backup: ${err.message}`);
  process.exit(1);
}
