# Operations

## Health

```sh
cd ~/Projects/pharos
docker compose ps
docker exec pharos-tailscale tailscale serve status
tailscale serve status
tailscale service list
systemctl --user status tailscale-web opencode-web --no-pager
systemctl --user status pharos-status --no-pager
systemctl --user status pharos-actions --no-pager
systemctl --user list-timers pharos-backup.timer --no-pager
```

The dashboard shows the same checks: `scripts/pharos-status.py` writes
`~/.local/state/pharos/status.json` every 30s, served at `/data/status.json`.
`STALE` on the page means no new status for 90s: the collector stopped, the
host is asleep, or this device cannot reach the host.

HTTP checks:

```sh
DASH=$(tailscale serve status | awk 'NR==1 {print $1}')

for url in \
  "$DASH/" \
  https://dns.example.ts.net/ \
  https://ai.example.ts.net/ \
  https://ts.example.ts.net/
do
  printf '%-46s ' "$url"
  curl -fsS -o /dev/null -w '%{http_code}\n' "$url" || echo fail
done
```

## Alerts

The collector sends every confirmed problem and recovery as a desktop
notification (`alerts.desktop` in `site/config.json`). A check has to fail
twice in a row (about a minute) before it alerts. The same changes appear on
the **Events** tab as incidents (problem plus recovery), from
`~/.local/state/pharos/events.json`, which keeps 30 days. A problem carries
a **Why** block gathered when it was confirmed: the HTTP result and backend
for an endpoint, state, exit code, health-check output and the last log lines
for a container, the result and journal tail for a unit, `tailscaled` health
messages for a node, the owning process for an unexpected port, and the top
memory users. Anyone who can open the page can read it, logs included.

For phone alerts, set `alerts.ntfy` to an [ntfy](https://ntfy.sh) topic URL
and subscribe to it in the ntfy app. A public `ntfy.sh` topic sends alert text
(service names, codes) outside your network; a self-hosted ntfy reachable only
on the tailnet keeps it private. Leave it empty to disable.

**Quiet mode** (the bell in the header) pauses alerts for an hour while you
work on the host; events are still recorded and the headline says until when.
It is `~/.local/state/pharos/quiet.json`; delete the file to end it early.

## Actions

The host owner (the Tailscale login that owns the host node) sees buttons on
the **Host** tab: restart a container or user unit, apply or update a pinned
image, and the quiet-mode bell. Everyone else sees Pharos read-only.

- `scripts/pharos-actions.py` (user unit `pharos-actions`) listens on
  the mode-600 socket `/run/user/1000/pharos-actions.sock` (not a TCP port, so
  other local processes cannot forge the login header); the node serve maps
  `/api` to it. `1000` is `id -u`; serving a socket needs `sudo tailscale
  serve` (see [serve configuration](#serve-configuration)). If the owner
  buttons and the alerts bell are gone and `/api/whoami` returns 502, serve
  still points `/api` somewhere else. Serve adds the caller's
  `Tailscale-User-Login`, so only the owner is accepted; cross-site requests
  are refused.
- Targets come from `config.json` and `status.json`: containers in `groups`,
  `user` units in `host`, images in the Updates list. A request names a
  target and never carries a command. System units (`tailscaled`, Docker) are
  not offered; restarting them would cut off the page.
- Each tap needs a confirming second tap. Every action is an info event
  ("restarted by …") on the **Events** tab; nothing is alerted.
- **Update** moves the pin in the compose file to the newest tag of the same
  shape (`v1.2.3`, `1.2.3-alpine`; no betas or unstable), then pulls and
  recreates that one service; on failure the old pin is put back. **Apply**
  recreates a container whose pin is not running yet. `pharos-tailscale` is never
  updated from the page (node identity); edits to `compose.yaml` still need a
  commit.

## Logs

```sh
docker compose logs -f --tail=100 tailscale dashboard
journalctl --user -u tailscale-web -f
journalctl --user -u pharos-status -f
journalctl --user -u pharos-actions -f
journalctl --user -u opencode-web -f
docker logs -f pharos-adguard
```

Backend errors are in the backend's own logs.

## Restart

```sh
docker compose restart dashboard      # static Pharos
docker compose restart tailscale      # svc:* down a few seconds
docker compose restart adguard        # DNS down a few seconds
docker compose up -d                  # apply compose changes
systemctl --user restart tailscale-web opencode-web
systemctl --user restart pharos-status pharos-actions
```

Editing anything in `site/` needs no restart; hard-refresh the browser. The
collector re-reads `site/config.json` every cycle.

Never run `docker compose down -v`: it deletes `pharos_tailscale-state` (the
node identity and serve config) and `pharos_adguard-conf` (all DNS settings).

## Dashboard changes

1. Edit `site/config.json`; hard-refresh. Use the health check above.
   - To watch another host unit, add it to `host` (`unit`, `scope` `system`
     or `user`, `note`). Containers appear on their own.
   - A port flagged as unexpected is listening beyond loopback without a
     matching `exposure` entry. Close it, or add `port`, optional `proto` and
     `scope` (`tailnet`, `lan`, `all`), and a `note`.
2. For a new or renamed Service, add it to `services` in `site/config.json`
   (each endpoint with its `path`, backend `port`, and `expect` codes; the
   page finds the backend by its port) and to the
   topology, then update `docs/architecture.md`, `acl-recommended.json`, and
   the serve commands in `docs/bootstrap.md`.
3. Commit.

## Serve configuration

```sh
tailscale serve status                          # host node
docker exec pharos-tailscale tailscale serve status  # svc:* handlers
```

Record the host route:

```sh
mkdir -p ~/backups
tailscale serve status --json > ~/backups/host-serve.json
```

`set-config` cannot restore the node serve; restore it with:

```sh
tailscale serve --bg http://127.0.0.1:8080
sudo tailscale serve --bg --set-path /api unix:/run/user/1000/pharos-actions.sock
```

## LAN subnet route

```sh
tailscale debug prefs | grep -A2 AdvertiseRoutes   # what the host advertises
```

Approval lives in **Machines → the host node → Subnets**; the ACL must grant
`192.0.2.0/24`. Sleep withdraws the route; approval and the grant persist.

After state loss, re-run the commands in `docs/bootstrap.md`.

## Backup

Back up:

- `pharos_tailscale-state` — node identity and serve config.
- `pharos_adguard-conf` — AdGuard settings (`AdGuardHome.yaml`). Its
  `pharos_adguard-work` (query log, stats, filter cache) is rebuilt, so it
  is not backed up.
- `site/`, `scripts/`, `compose.yaml`, `systemd/`, and `acl-recommended.json`
  — tracked in git. `~/.local/state/pharos/` is regenerated; no backup needed.

The auth key is bootstrap-only; do not back it up.

Both volumes are backed up weekly by the `pharos-backup.timer` user unit,
which runs `scripts/backup-state.sh`. It writes
`~/backups/tailscale-state-YYYY-MM-DD.tgz` (mode 600; it holds node keys)
and `~/backups/adguard-conf-YYYY-MM-DD.tgz` (mode 600; the admin login hash),
and keeps the newest 4 of each; `scripts/install.sh` restores both. The timer
is persistent, so a slot missed during sleep runs at the next wake. The dashboard shows the last backup under **Host**,
opens each new archive to check it is readable, and alerts when it is
unreadable or older than 14 days (`backup.maxDays` in `config.json`).

```sh
systemctl --user list-timers pharos-backup.timer   # next run
scripts/backup-state.sh                              # back up now
```

Restore (pick a file; `ls -t ~/backups`):

```sh
f=$(ls -t ~/backups/tailscale-state-*.tgz | head -1)
docker compose stop tailscale
docker run --rm \
  -v pharos_tailscale-state:/data \
  -v "$HOME/backups":/backup \
  alpine:3.24 sh -c "find /data -mindepth 1 -delete && tar xzf /backup/$(basename "$f") -C /data"
docker compose start tailscale
```

AdGuard's settings the same way (DNS is down while it is stopped):

```sh
f=$(ls -t ~/backups/adguard-conf-*.tgz | head -1)
docker compose stop adguard
docker run --rm -v pharos_adguard-conf:/data -v "$HOME/backups":/backup alpine:3.24 \
  sh -c "find /data -mindepth 1 -delete && tar xzf /backup/$(basename "$f") -C /data"
docker compose start adguard
```

Check with:

```sh
docker exec pharos-tailscale tailscale status
docker exec pharos-tailscale tailscale serve status
```

If the volume is lost: create a new tagged key, add a temporary `.env`, run
`scripts/install.sh tskey-auth-…` (it publishes the Services), and approve
the `pharos` host. The ACL lives in Tailscale, so it survives.

## Upgrades

Images are pinned, so `docker compose pull` never changes anything by itself.
The **Host** tab's Updates list checks Docker Hub once a day for a newer tag
of each pin and flags a pin that is not running yet. AdGuard and nginx can
be updated from there (see [Actions](#actions)); the rest by hand:

| Image | Pinned in |
|---|---|
| `tailscale/tailscale:v1.104.4` | `compose.yaml` (`tailscale`) |
| `nginx:1.31.8-alpine` | `compose.yaml` (`dashboard`) |
| `adguard/adguardhome:v0.107.79` | `compose.yaml` (`adguard`) |
| `alpine:3.24` | `scripts/backup-state.sh` |

To upgrade one, back up first (`scripts/backup-state.sh`), change its tag to
the new release, then:

```sh
docker compose pull
docker compose up -d
docker compose ps
```

Recreating `tailscale` interrupts the Services for a few seconds and keeps
the state volume. Keep the host Tailscale close to the container's version;
upgrade it with your package manager, then restart `tailscaled`.

## Packages

The **Host** tab's System card lists pending official (`checkupdates`) and
AUR (`yay -Qua`) updates, checked hourly, and says when a reboot is needed
(the running kernel is no longer installed). The list re-checks as soon
as the package database changes. Updating stays manual: run `omarchy update`
at the laptop. Omarchy's pacman hook blocks a direct `pacman -Syu`, and its
updater needs your sudo and builds AUR packages, so Pharos does not offer it.
Read Arch news before big upgrades; an update that breaks `tailscaled` cuts
remote access until you are at the laptop.

## Sleep

The host is a laptop. Suspend stops `tailscaled`, Docker, and every service.
Keep it awake on AC power for availability. After wake, restart the proxy if
the `svc:*` URLs do not recover:

```sh
docker compose restart tailscale
```

## Security

- The ACL is the only gate for Pharos, OpenCode, and the LAN subnet. Funnel is off.
- Raw 5252 is plain HTTP and ACL-blocked; only `svc:ts` on 443 is allowed.
- Add a grant for each new Service and keep `acl-recommended.json` aligned.
- Rotate the key: generate a new one, add a temporary `.env`, then
  `docker exec pharos-tailscale tailscale logout` and
  `docker compose up -d --force-recreate tailscale`. If it does not
  re-authenticate, delete only its identity as a last resort
  (`docker compose rm -sf tailscale && docker volume rm pharos_tailscale-state`),
  then run `scripts/install.sh tskey-auth-…` and re-approve. Never use
  `down -v`, which also deletes AdGuard's settings. The ACL is unaffected.

## Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| 502 from a `svc:*` URL | Backend listening on its loopback port | Start the backend |
| "service host not approved" | Services → service → Service hosts | Approve `pharos` |
| Pharos 502 | `docker compose ps` | `docker compose up -d dashboard` |
| Dashboard says `STALE` or `No data` | `systemctl --user status pharos-status`, `ls ~/.local/state/pharos` | Start the unit; create the folder before `docker compose up -d` |
| `ts` shows a read-only banner | Unit still has `--readonly` | Remove the flag, restart `tailscale-web` |
| DNS fails | `docker logs pharos-adguard`, port 53 | `docker compose restart adguard` |
| Works on host, not phone | ACL grants, client version | Fix the grant; use client 1.94+ |
| LAN hosts unreachable | Route approved? ACL grant? host awake? | Approve in the console, grant the CIDR, wake the host |
| Certificate warning | Host `tailscaled`, HTTPS | Restart `tailscaled` |
| All `svc:*` fail after wake | `docker exec pharos-tailscale tailscale status` | `docker compose restart tailscale` |
| `pharos` node missing | `docker compose ps`, logs | Check `TS_AUTHKEY` and restart |
