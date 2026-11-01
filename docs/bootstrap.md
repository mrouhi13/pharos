# Bootstrap

## Quick path

With Docker, Tailscale (logged in) and the repo on the new host:

```sh
scripts/install.sh ~/backups/tailscale-state-<date>.tgz   # move: same pharos node
scripts/install.sh tskey-auth-...                          # fresh: key from step 1
```

On a move it restores the `pharos` node and, from the
`adguard-conf-<date>.tgz` beside it, AdGuard's settings; fresh, it registers
the node and publishes the Services from `config.json`. Either way it fits
AdGuard's DNS binds to this host's IPs, starts compose, installs the user units
(including `opencode-web`) with this host's repo path and tailnet, serves
Pharos, advertises the LAN, takes a first backup, and prints the console steps
left (approvals, DNS, ACL). It is safe
to re-run. The sections below are the same steps by hand.

Assumes the repo is at `~/Projects/pharos`; the install script reads your
user, tailnet, and LAN. Examples use `example.ts.net`, `100.101.102.103`,
and `192.0.2.0/24`.

## Prerequisites

- Tailscale logged in; MagicDNS and HTTPS enabled.
- Docker Engine and Compose.
- Admin console access.
- OpenCode installed with mise (AdGuard and the `opencode-web` unit come with
  this repo).
- Tailscale 1.86+ on the host.

## 1. Tag and key

In **Access controls**, add this fragment:

```json
"tagOwners": {
  "tag:services": ["autogroup:admin"]
}
```

In **Settings → Keys**, create a key tagged `tag:services`, non-ephemeral, and
preferably single-use. Then:

```sh
cd ~/Projects/pharos
cp .env.example .env
chmod 600 .env
$EDITOR .env   # TS_AUTHKEY=tskey-auth-...
```

Never commit `.env`. It is only needed for registration and is optional to
Compose after that.

## 2. Define the Services

In **Services → Advertise → Define a Service**, create three:

| Name | Endpoint | Result |
|---|---|---|
| `dns` | `tcp:443` | `svc:dns`, `dns.example.ts.net` |
| `ai` | `tcp:443` | `svc:ai`, `ai.example.ts.net` |
| `ts` | `tcp:443` | `svc:ts`, `ts.example.ts.net` |

The names become MagicDNS labels. Renaming one means updating the serve
commands, ACL, `site/config.json`, and the `ts` unit's `--origin`.

## 3. Start and publish

The dashboard mounts the collector's folder; create it first, or Docker creates
it as root:

```sh
mkdir -p ~/.local/state/pharos
cp site/config.example.json site/config.json   # local, ignored; edit it
docker compose up -d
docker compose ps
docker compose logs -f tailscale
```

The DNS binds in `compose.override.yaml` are this host's LAN and tailnet IPs
(`ip route`, `tailscale ip -4`); `install.sh` writes them. A new AdGuard
starts its setup wizard; finish it at `https://dns.<tailnet>/` after step 3.

Approve the `pharos` node in **Machines** if required. Check it:

```sh
docker exec pharos-tailscale tailscale status
```

`TS_AUTH_ONCE=true`; state lives in `pharos_tailscale-state`.

Publish the endpoints:

```sh
docker exec pharos-tailscale tailscale serve --service=svc:dns --https=443 http://127.0.0.1:3000
docker exec pharos-tailscale tailscale serve --service=svc:ai --https=443 http://127.0.0.1:49374
docker exec pharos-tailscale tailscale serve --service=svc:ts --https=443 http://127.0.0.1:5252
```

The first command per Service reports that approval is required. Approve
`pharos` under **Services → name → Service hosts**. Verify:

```sh
docker exec pharos-tailscale tailscale serve status
```

Expect three HTTPS services.

## 4. Pharos, status collector, and web UI

Start the status collector, which feeds the dashboard:

```sh
mkdir -p ~/.config/systemd/user
cp systemd/pharos-status.service systemd/pharos-actions.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pharos-status pharos-actions
```

Schedule the weekly state backup and take the first one:

```sh
cp systemd/pharos-backup.service systemd/pharos-backup.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pharos-backup.timer
scripts/backup-state.sh
```

Serve Pharos as a node route:

```sh
tailscale serve --bg http://127.0.0.1:8080
sudo tailscale serve --bg --set-path /api unix:/run/user/1000/pharos-actions.sock   # actions, owner only
tailscale serve status
```

Install the web UI:

```sh
sed "s#TAILNET#$(tailscale status --json | jq -r .MagicDNSSuffix)#" systemd/tailscale-web.service > ~/.config/systemd/user/tailscale-web.service
systemctl --user daemon-reload
systemctl --user enable --now tailscale-web
systemctl --user status tailscale-web --no-pager
```

Start the OpenCode server (`svc:ai`; OpenCode itself comes from mise):

```sh
cp systemd/opencode-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencode-web
```

`tailscale-web` needs the host `tailscaled` socket and sets `--origin
https://ts.example.ts.net`. The unit runs writable (no `--readonly`), so
the UI can change the host client. If `ts` is renamed, update the
origin and restart. Enable lingering so the user units start at boot:

```sh
loginctl enable-linger "$USER"
```

### LAN subnet route

Tailnet devices can reach LAN hosts (FritzBox, TV, NAS) through the host:

```sh
sudo tailscale set --advertise-routes=192.0.2.0/24   # your LAN CIDR
```

Approve `192.0.2.0/24` under **Machines → the host node → Subnets**; the
ACL grant is in step 5. Host sleep withdraws the route.

## 5. Apply the ACL

Replace the example host IP (`100.101.102.103`), LAN (`192.0.2.0/24`), and
SSH user (`<your-user>`) in `acl-recommended.json` with yours:

```sh
tailscale ip -4
```

Paste the file into **Access controls** and save. It grants:

- Members to the host on TCP 443, TCP/UDP 53, and TCP 22.
- Members to the three `svc:*` Services on TCP 443.
- Members to the LAN subnet `192.0.2.0/24` (subnet route).
- Tailscale SSH as `<your-user>`, with check mode.

It does not grant 5252, so the raw web UI port stays unreachable. Keep console
access while editing the ACL.

## 6. Revoke the key

Revoke the bootstrap key in **Settings → Keys**, then remove `.env`; the state
volume holds the node identity. If the volume is lost, create a new key, add a
temporary `.env`, and start the proxy again.

## 7. Verify

Run the checks in [Operations](operations.md#health). Expected: three `tcp:443`
Services, dashboard/AI/`ts` return 200, and DNS 200 or 302. The dashboard
headline reads `ALL CLEAR`.
