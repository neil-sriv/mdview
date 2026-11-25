# Moving comments and specs onto the Worker

Run this from a checkout of mdview, with the Mac store still at `~/.mdview/peanut.sqlite3`. The vault in the examples is `~/cs/agent-brain`. Nothing here contains a token. Each command reads `MDVIEW_URL` and the Access service-token pair from the environment.

`MDVIEW_ACCESS_CLIENT_ID` and `MDVIEW_ACCESS_CLIENT_SECRET` are the agent token, except where a step says to point them at the admin or backup token. `MDVIEW_ADMIN_ACCESS_CLIENT_ID` and `MDVIEW_ADMIN_ACCESS_CLIENT_SECRET` are the admin token. When those are unset, the admin calls use the access pair.

The import body can be up to 64 MiB. An export larger than that has to be split by hand; the store this was written for fits.

## 1. Stop the Mac jobs and copy the database

```bash
launchctl bootout gui/$UID/tech.neilsriv.mdview-notify
launchctl bootout gui/$UID/tech.neilsriv.mdview-viewer
sqlite3 ~/.mdview/peanut.sqlite3 ".backup /tmp/mdview-export.sqlite3"
```

Leave the plists in place. The copy is the rollback file if export itself fails.

## 2. Export, then import

Export rewrites each Mac path under the vault to `<project>/<file>.md` and keeps every id.

```bash
export MDVIEW_URL=https://specs.neilsriv.tech
export MDVIEW_HOME=~/.mdview
mdview store export --rekey-vault ~/cs/agent-brain --out /tmp/mdview-export.json
```

Point the access pair at the admin service token (or set the `MDVIEW_ADMIN_*` pair) and load it. This is one transaction. Running it again with the same file does nothing. A different file is refused while the Worker store already holds comments; `--force` replaces those rows.

```bash
mdview store import /tmp/mdview-export.json
```

## 3. Seed the specs, observe, then check

`SOURCE_REV` is the Origin commit the vault was read at. Seeding uploads every `projects/<project>/specs/**/*.md` file, including `index.md` and `archive/`, through `mdview specs new`, and uploads the revision texts the imported threads cite into `revs/`. A file that is not a spec key stops the command. The agent token creates the current files. The admin token writes the older revisions, so set both pairs for this command.

```bash
export MDVIEW_AUTHOR=specs
export SOURCE_REV=$(git -C ~/cs/agent-brain rev-parse HEAD)
mdview specs seed --vault ~/cs/agent-brain --source-rev "$SOURCE_REV" --export /tmp/mdview-export.json
```

`sourceRev` is stored on each uploaded object. Then make every tracked spec's latest revision the bytes now in R2, and compare the two stores. Verify only reads. It checks thread counts, the inbox, and that every thread's block anchor resolves.

```bash
mdview store observe
mdview store verify --rekey-vault ~/cs/agent-brain
```

`verify` prints `Dry run` and exits 0 when the counts match and every anchor resolves. It writes nothing.

## 4. Start the backup loop

On the box, the backup token goes in `/home/box/.secrets/mdview-backup-token.env`:

```bash
MDVIEW_URL=https://specs.neilsriv.tech
MDVIEW_VAULT=/home/box/vaults/agent-brain
MDVIEW_ACCESS_CLIENT_ID=
MDVIEW_ACCESS_CLIENT_SECRET=
```

The timer runs one pass every 5 minutes. The script only sends GET. It asks for specs changed since the previous pass, and also reads the full list so a local edit is overwritten even when R2 has not changed. It writes a file only when the bytes differ, logs the overwrite to `inbox/learnings.md`, and never writes back.

```ini
# /etc/systemd/system/mdview-backup.service
[Unit]
Description=Pull mdview specs into the vault

[Service]
Type=oneshot
User=box
EnvironmentFile=/home/box/.secrets/mdview-backup-token.env
ExecStart=/usr/bin/node /home/box/mdview/scripts/backup-vault.mjs

# /etc/systemd/system/mdview-backup.timer
[Unit]
Description=Pull mdview specs every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=15s

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now mdview-backup.timer
```

Then stop the Mac proxy jobs, keep their plists, and stop the tailnet serve:

```bash
launchctl bootout gui/$UID/tech.neilsriv.mdview-proxy
launchctl bootout gui/$UID/tech.neilsriv.mdview-autopull
tailscale serve off
```

## Rollback

Keep `/tmp/mdview-export.json`. To put comments back on the Mac, point `MDVIEW_HOME` at an empty directory and reverse the rekey into a fresh SQLite file. The vault copies are the spec text.

```bash
export MDVIEW_HOME=/tmp/mdview-rollback
mdview store restore /tmp/mdview-export.json --vault ~/cs/agent-brain
```

That refuses a store that already has comments. Open the viewer on the vault afterwards. The Worker is left as it is; this only rebuilds the local file.
