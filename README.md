# Pharos

A watch tower for one laptop host and its private Tailscale services. HTTP is
tailnet-only; Funnel is off.

| Tab | Shows |
|---|---|
| Overview | Services, running, health, network, updates, last problem |
| Services | Status, latency, and history per Service; details in place |
| Host | Disk, memory, load, power, backup; host services and containers with restart buttons; package and image updates |
| Network | Tailscale nodes, LAN route, tailnet DNS, tailnet and LAN devices, exposed ports, topology |
| Events | Problems and recoveries as incidents, 30 days; also sent as alerts |

Items link to each other: a headline issue, an event, or a topology box opens
its tab at that item.

## Layout

```text
compose.yaml               project pharos: tailscale (hosts the svc:* Services),
                           adguard (DNS), dashboard (nginx)
acl-recommended.json       ACL reference; apply it in the admin console
site/                      the dashboard, served as-is
  config.example.json      what the page shows; install.sh copies it to the
                           ignored config.json
  index.html app.css app.js
  sw.js manifest.json      PWA
  icons/ fonts/
scripts/pharos-status.py   status collector → ~/.local/state/pharos/
scripts/pharos-actions.py  owner-only actions behind /api
scripts/backup-state.sh    weekly backup: node state and AdGuard settings
scripts/install.sh         set up or move Pharos on a host
systemd/                   user units: pharos-status, pharos-actions, pharos-backup,
                           tailscale-web, opencode-web
docs/                      architecture, bootstrap, operations
```

## Use

Open the URL `tailscale serve status` prints. On a phone, add it to the home
screen; the cached copy opens while the host sleeps and shows as stale.

Set up or move to a new host with `scripts/install.sh`; it copies
`site/config.example.json` to the ignored `site/config.json`. Edit that file
(content) or `site/app.*` (UI) and hard-refresh; there is no build. Setup is
in [Bootstrap](docs/bootstrap.md); daily work, alerts, and backups in
[Operations](docs/operations.md); design in [Architecture](docs/architecture.md).

## Guardrails

- HTTP backends bind `127.0.0.1`; the tailnet sees 443, 53, and 22. AdGuard DNS
  also answers on the LAN.
- Pharos and OpenCode have no login; the ACL is the gate. Pharos actions
  (restart, update, quiet mode) answer only the Tailscale
  login that owns the host.
- Raw `5252` is plain HTTP and ACL-blocked; use `svc:ts` on 443.
- `.env` is for first registration only; the node identity lives in the
  `pharos_tailscale-state` volume.

## License

MIT, except the fonts in `site/fonts/`: they are under the SIL Open Font
License 1.1, in the `OFL-*.txt` files beside them.
