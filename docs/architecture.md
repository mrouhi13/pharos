# Architecture

The host is a laptop running Tailscale, Docker, and the services. Pharos is
the dashboard; Tailscale is the ingress for HTTP. AdGuard DNS on 53 is the only
non-HTTP application listener and also answers on the LAN. Funnel is off.

## Request path

```text
tailnet client (phone, tablet, laptop)
  │  MagicDNS · WireGuard · ACL
  ▼
Tailscale
  ├─ node “host” · 100.101.102.103 (host tailscaled)
  │   ├─ :443 node serve   ──▶ 127.0.0.1:8080    pharos-dashboard
  │   │                    └─ /api ──▶ pharos-actions socket
  │   ├─ subnet route      ──▶ 192.0.2.0/24       FritzBox, TV, NAS
  │   ├─ :53  DNS          ──▶ pharos-adguard (also on the LAN)
  │   ├─ :22  SSH
  │   └─ :5252 tailscale-web (host unit, writable; ACL-blocked)
  │
  └─ node “pharos” · 100.101.102.104 (pharos-tailscale, tag:services, userspace)
      ├─ svc:dns    ──▶ 127.0.0.1:3000   pharos-adguard (admin UI)
      ├─ svc:ai     ──▶ 127.0.0.1:49374  opencode-web
      └─ svc:ts     ──▶ 127.0.0.1:5252   tailscale-web
```

- `svc:*` are Tailscale Services hosted by the tagged `pharos` node
  (`pharos-tailscale` container).
- `pharos-tailscale` uses host networking, so `127.0.0.1` is the host's loopback.
- The host node advertises `192.0.2.0/24` as a subnet route; it is approved
  in the console and granted in the ACL, so tailnet devices can reach LAN hosts
  (router, TV, NAS). Host sleep withdraws the route.

## Nodes

| Node | Daemon | Address | Tags | Owns |
|---|---|---|---|---|
| `host` | host `tailscaled` | `100.101.102.103` | — | TLS certs, node serve, SSH, LAN subnet route, `tailscale-web` |
| `pharos` | `pharos-tailscale` `tailscaled` (userspace, host network) | `100.101.102.104` | `tag:services` | `svc:ai`, `svc:dns`, `svc:ts` |

## Host vs Docker

| Component | Runs in | Role | Listener |
|---|---|---|---|
| `tailscaled` | Host | Node identity, certs, node serve, SSH, LAN route | 443 and 22 on tailnet; `192.0.2.0/24` |
| `tailscale-web` | Host, systemd user | Client web UI (writable) | `127.0.0.1:5252` |
| `pharos-tailscale` | Docker | Tagged host for the three `svc:*` Services | Host network, userspace; WireGuard UDP 41642 |
| `pharos-dashboard` | Docker | Static dashboard via nginx | `127.0.0.1:8080` |
| `pharos-status` | Host, systemd user | Status collector for the dashboard | none; writes `~/.local/state/pharos/status.json` |
| `pharos-actions` | Host, systemd user | Owner-only restart, update, quiet mode | Unix socket `/run/user/1000/pharos-actions.sock`, node serve `/api` |
| `pharos-backup` | Host, systemd user timer | Weekly snapshot of `pharos_tailscale-state` and `pharos_adguard-conf` | none; writes `~/backups/` |
| `pharos-adguard` | Docker, this compose project | DNS and admin UI | 53 (LAN/tailnet), `127.0.0.1:3000` |
| `opencode-web` | Host, systemd user (`systemd/opencode-web.service`) | OpenCode shared server: `svc:ai` | `127.0.0.1:49374` |

## Dashboard data

```text
site/config.json ──▶ pharos-status (host, every 30s) ──▶ ~/.local/state/pharos/status.json
      │                 HTTPS checks · tailscale status · serve status        │
      ▼                                                                       ▼ mounted at /data/
   browser ◀─────────────── nginx (pharos-dashboard) ◀──────────────┘
```

- `config.json` is the local copy of `config.example.json`, hand-edited;
  `status.json` is generated and never committed. The page merges them.
- Besides the Services, the collector inventories every Docker container, the
  host units listed in `config.json`, and every port listening beyond
  loopback, so nothing runs or listens on the host without showing up.
- It also reads host health and compares every check with the last cycle;
  confirmed changes become events on the page and alerts (desktop, optional
  ntfy).
- The collector runs on the host, so it sees real HTTP codes (a 502 is a
  fault) and both `tailscaled` nodes. The browser only fetches `status.json`;
  a failed fetch or old data shows as `STALE`, never as online. The headline
  and every status dot read the collector's checks, so they match the alerts.
- Actions go the other way: the page posts to `/api` (node serve →
  `pharos-actions`), which checks the caller's Tailscale login, runs one
  allowed action, queues an event, and wakes the collector (SIGUSR1) so the
  page shows the result within seconds. Container starts, stops, and health
  changes (`docker events`) wake it the same way.

## Key decisions

- **Separate tagged proxy.** `pharos-tailscale` has its own Tailscale identity, so
  the proxy and its serve config can change without touching the host node.
- **One Service per app.** Each app gets its own ACL grant and stable name.
- **Web UI on the host.** `tailscale web` needs the host `tailscaled` socket.
  It binds loopback 5252; `tailscaled` also opens the tailnet IP on 5252 as
  plain HTTP. The ACL blocks that raw port; only `svc:ts` on 443 is usable.
- **Loopback HTTP backends.** No Funnel or public binds. AdGuard DNS on 53 is
  the intentional LAN exception.
- **`--accept-dns=false`.** The proxy shares the host network namespace; it
  must not rewrite the host resolver.
- **Status from the host, not the browser.** Browser `no-cors` probes cannot
  read status codes, so a 502 looked online. The collector reads real codes
  and marks old data stale instead of green.
- **Actions in a separate process.** nginx stays static and read-only; the
  only code that changes the host is `pharos-actions`, a fixed list of
  targets, behind the owner's login. No logs on the page (they can hold
  tokens) and no ACL API key on the host.
- **ACL reference in git.** `acl-recommended.json` is applied manually in the
  admin console.

## Dependencies

- Tailscale 1.86+ on the host; 1.94+ on clients for Services without
  `--accept-routes`.
- MagicDNS, HTTPS certificates, Docker, and Compose.
- A `tag:services` auth key for the first proxy start.
- OpenCode installed with mise; this repo's `opencode-web` unit starts its
  server. AdGuard is part of this repo's compose.

## Failure behavior

| Failure | Effect |
|---|---|
| `pharos-tailscale` down | All `svc:*` URLs fail; Pharos, SSH, and DNS still work. |
| Host `tailscaled` down | All tailnet URLs fail. |
| Host suspended | Everything fails, including Docker and the web UI. Tailnet devices also lose DNS, since AdGuard on the host is the tailnet resolver. |
| LAN route unapproved or ungranted | LAN hosts are unreachable from tailnet clients; the rest is unaffected. |
| OpenCode down | Its Service returns 502; other services are unaffected. |
| `pharos-adguard` down | DNS fails for the tailnet and the LAN, and `svc:dns` returns 502. |
