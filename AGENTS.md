# AGENTS.md

## Repo

- Pharos is the watch tower for a single-machine Tailscale stack: every
  Service, host service, container, and exposed port on one page. No package
  manager, build, tests, lint, or CI.
- "tailnet" means the Tailscale network, not this project. Docs and UI call
  the machine "the host"; its node name comes from `tailscale status`.
- The Compose project is `pharos`; each service is named for what it is:
  `tailscale` (the tagged node that hosts the `svc:*` Services), `adguard`
  (DNS), `dashboard` (this page). Containers add the project prefix
  (`pharos-tailscale`, …): `docker` commands take the container name,
  `docker compose` the service name. Volumes: `pharos_tailscale-state`,
  `pharos_adguard-conf`, `pharos_adguard-work`. The tagged node is `pharos`
  (`TS_HOSTNAME`; rename it there, not in the console, which the container
  overrides); its tag stays `tag:services`. Node ids are internal (`host`,
  `services`); the live name comes from `tailscale status`.
- Services, host approvals, DNS, and the ACL live in the Tailscale admin
  console. Committing does not deploy: `site/` is live, compose needs
  `docker compose up -d`, units need copying (below), console changes are
  manual.
- Keep it minimal: no new files, fields, or UI without a use; trust live
  config over docs, and update docs when they drift.

## Never break

- `.env` is first-boot only (mode 600, ignored); never commit it.
- Never `docker compose down -v`: it would delete `pharos_adguard-conf` (all
  DNS settings) too. Never delete `pharos_tailscale-state`; it
  holds the tagged node identity and every `svc:*` handler.
- `pharos-tailscale` needs a `tag:services` auth key; user keys cannot host
  Services.
- `tailscale-web` stays a host user unit; it needs the host `tailscaled` socket.
- HTTP backends stay on `127.0.0.1`; no Funnel or public binds. AdGuard DNS on
  53 is intentionally also on the LAN.
- `svc:ts` is writable: any device granted it can reconfigure the host client.
  Keep that grant tight; raw 5252 is plain HTTP and stays ACL-blocked.
- `acl-recommended.json` is a reference; editing it does not change the ACL.
- `pharos-actions` is the only write path, with no root actions: owner login
  only (serve's `Tailscale-User-Login`), JSON POST, same origin, fixed
  targets, never a command from the request. Never offer system units, volume
  deletion, or `pharos-tailscale` updates.

## Topology

| Name | Served by | Backend |
|---|---|---|
| Pharos | host `tailscaled` node serve | `127.0.0.1:8080`, `/api` → `unix:/run/user/1000/pharos-actions.sock` |
| `ai.example.ts.net` (`svc:ai`) | `pharos-tailscale` | `127.0.0.1:49374` |
| `dns.example.ts.net` (`svc:dns`) | `pharos-tailscale` | `127.0.0.1:3000` |
| `ts.example.ts.net` (`svc:ts`) | `pharos-tailscale` | `127.0.0.1:5252` |
| LAN `192.0.2.0/24` | host subnet route | LAN hosts |

- Nodes: the host (id `host`, 100.101.102.103; name from `tailscale status`)
  and `pharos` (container `pharos-tailscale`, 100.101.102.104, `tag:services`,
  WireGuard pinned to UDP 41642; the host uses 41641).
- The tailnet DNS resolver is AdGuard at `100.101.102.103`. Host sleep stops
  the LAN route and tailnet DNS unless the console lists a fallback.
- `tailscale serve status` shows the node route;
  `docker exec pharos-tailscale tailscale serve status` shows the Services.
- AdGuard runs here (compose service `adguard`, volumes
  `pharos_adguard-conf` and `pharos_adguard-work`). The `opencode-web` user unit
  (`systemd/opencode-web.service`, the shared OpenCode server behind `svc:ai`)
  is Pharos's too; OpenCode itself comes from mise.

## Commands

```sh
cd ~/Projects/pharos
docker compose config --quiet
docker compose up -d
docker compose logs -f --tail=100 tailscale dashboard
docker exec pharos-tailscale tailscale serve status
systemctl --user status pharos-status pharos-actions --no-pager
journalctl --user -u pharos-status -u pharos-actions -f
python3 scripts/pharos-status.py --once
scripts/install.sh            # set up, move, or bring a host up to date; safe to re-run
```

Units in `systemd/` take effect only after copying to `~/.config/systemd/user/`,
`daemon-reload`, and a restart.

## Actions (`scripts/pharos-actions.py`)

- User unit `pharos-actions` on a mode-600 Unix socket
  (`$XDG_RUNTIME_DIR/pharos-actions.sock`), node serve `/api`; a TCP port
  would let any local process forge the login header. A second copy refuses
  to start while the socket answers.
  `GET /whoami` says whether the caller is the owner and lists allowed
  targets; `POST /restart`, `/update` (`{"target":"ctr:x"|"unit:x"}`), and
  `/quiet` (`{"minutes":0..720}`). The page shows buttons only for the owner;
  the first tap arms, the second runs.
- No package updates: Omarchy blocks direct `pacman -Syu`, and `omarchy
  update` needs sudo and builds AUR. Never add those, reboot, or other root
  actions here.
- Restart: containers of `groups` projects, `user` units in `host`. Update:
  entries in `status.updates` with a newer tag or an unapplied pin; it edits
  that one `image:` line, pulls, recreates, and reverts the line on failure.

## Dashboard (`site/`)

- `config.example.json` is the committed sample; `install.sh` copies it to
  the ignored `config.json`, which holds intent, not machine facts: Services
  (endpoints with expected codes), host units to watch (`scope` system/user),
  Docker group order, expected ports, nodes, devices, LAN names by MAC
  (`network.names`, optional), topology, backup, alerts. The collector reads
  the rest from commands: Service hosts (`<svc name>.<tailnet>`), node names,
  the LAN (the advertised route) and the gateway. Never hardcode data in
  `app.js`.
- `index.html` is the shell; `app.js` renders five hash tabs: `#overview`
  (default), `#services`, `#host`, `#network`, `#events`. `#system` and
  `#architecture` redirect to `#network`. `#tab/id` opens a tab and scrolls
  to that element (`svc-<id>`, `ctr-<name>`, `unit-<name>`, `node-<id>`,
  `port-<n>-<proto>`, `route`, `devices`, `health`, `backup`, `packages`,
  `updates`); `linkFor()`
  maps check keys to these. Service ↔ container links match by port. Element
  ids must not equal a tab name.
- Names: anything that runs (container, systemd unit, `tailscaled`) is shown
  by its real name everywhere (page, topology, events, alerts), the name you
  type in `docker` or `systemctl`; what it does goes in the caption. Display
  names are only for Services and devices. Backend names are not in config:
  the page finds who listens on each endpoint's port.
- The headline, Overview, and container/unit dots read the collector's
  `checks` (`bad > 0` = failing now). Add checks in the collector, not in
  `app.js`. Red = down; host health, ports, backup, DNS, key expiry (under
  14 days), and unit transitions are amber.
- The page polls status every 10s while open, and on focus or refresh (8s
  timeout); `whoami` loads separately so status never waits for it.
  Old data, a service-worker copy, or a failed fetch reads as `STALE`, never
  online, and says which.
- Data enters the DOM as text only; only the icon constants use markup.
  External links use `target="_blank" rel="noopener noreferrer"`.
- Design: sci-fi, kept minimal. Tokens in `app.css` (`--f1`…`--f6` type
  scale, `--s1`…`--s6` spacing, OKLCH colours: light has a cool steel tint,
  dark is pure black with neutral greys and deep state colours (`--ok`,
  `--warn`, `--bad` at the darkest that still read as text on black, 4.5:1;
  dots, glows, and coloured text all use them), `--shadow`). Solid surfaces with the
  logo's cut corner and a light top edge, over an aura and a faint grid that
  form one fixed backdrop (`body::after`, `body::before`; never on `html`, or
  overscroll pulls them apart); colour only for state (dots glow, cards with a
  state carry a faint corner glow at 40% of the state tint, down items are
  striped); the headline
  glows and sweeps once on change. No outlines; focus is keyboard-only
  (`:focus-visible`). Cut corners clip `box-shadow`, so shadows are a `filter`
  on the container (`.lift`, `.tiles`, `.cells`, `.groups`, …); wrap a
  standalone card in `.lift`. Cards sit in grids (not CSS columns, which
  stack and misalign them) with equal heights per row; only the Services
  tiles are top-aligned, since a tile expands in place; meter bars sit at the bottom so a
  wrapping caption cannot push one out of line. Uppercase labels use `.04em` tracking.
- Motion: topology lines flow, healthy dots breathe, down dots pulse, tabs fade
  in (desktop), the logo's beam breathes. Loops take their delay from `--t0` (set from the
  clock in `syncMotion()`) so 30s re-renders never restart them; keep loop
  lengths dividing 24s. The header motion switch (`localStorage.tn-motion`,
  `data-motion="off"`) turns it all off; with no saved choice it follows
  `prefers-reduced-motion`.
- Performance (iOS Safari kills a page that uses too much memory): infinite
  loops animate only `opacity` and `transform` (dots move a `::after`), never
  `box-shadow` or other paint properties; the topology wires, which must
  repaint, sit on their own layer. Shadow filters and the tab fade are
  desktop-only (`hover:hover` and `pointer:fine`): a filter keeps an
  offscreen copy of a whole container. Dark mode has no shadow (black on
  black). Only the open tab is built (`PAINT`, `paintView()`); the others are
  built when opened. A poll re-renders only when something changed, stops
  while the page is hidden, and revalidates (`cache: 'no-cache'`, ETag), so an
  unchanged file is a 304; the service worker saves a copy only on a new ETag.
- The viewport blocks zoom. Theme cycles system → light → dark
  (`localStorage.tn-theme`).
- PWA: `manifest.json` (stays `.json`; nginx lacks the MIME type), `sw.js`,
  and `icons/` (`favicon.svg`, the Beam: a point of light and its fading sweep, a
  lighthouse seen from above; the beam is a ring slice centred on the lamp
  (inner edge hugging it, radial fade, softened corners via a mask) and the
  lamp is a shaded lens; transparent, ink follows the theme, is the source; PNGs are
  rendered from it).
  `sw.js` is network-first for pages, code, config, and status, cache-first
  for fonts and icons: bump `CACHE` when those change.

## Collector (`scripts/pharos-status.py`)

- Runs as the `pharos-status` user unit, every 30s, re-reading `config.json`;
  a container start, stop, or health change (`docker events`) or SIGUSR1
  starts a cycle at once.
- Checks each endpoint by GET without following redirects; reads both
  `tailscaled` nodes, LAN route, tailnet DNS, peers, every container, the
  `host` units, `ss` listeners beyond loopback (expected if in `exposure` or
  the tailscaled peer API), host health, and the newest backup.
- A check must fail 2 cycles to alert; recovery counts at once. Changes go to
  `events.json` (30 days, the Events tab), `notify-send`, and `alerts.ntfy`
  if set. A gap over 5 intervals is an info event.
- Writes `~/.local/state/pharos/{status,events}.json` atomically. Compose
  mounts that folder read-only at `/data/` (a folder, so renames show);
  `site/data/` is only the ignored mount point.
- A Service live on `pharos-tailscale` but missing from `services` in config is an
  amber `svc:*` issue ("live but not in config.json").
- Also: device details (IPs, MagicDNS name, traffic, handshake, key expiry),
  LAN hosts from `ip neigh` named by the router's reverse DNS (or
  `network.names` by MAC; offline ones kept 7 days), pending packages
  (`checkupdates`, `yay -Qua`, hourly) (re-checked when the pacman
  database changes) and whether a reboot is needed, device paths (direct, or
  relay and where), a daily Docker Hub check
  for newer tags of each compose pin plus pins not running yet (`updates`),
  and each new backup archive
  opened once (`verified`). None of these alert except an unreadable backup.
- `quiet.json` (written by actions) pauses alerts, not events. Actions append
  to `pending.jsonl`; the collector moves those into events as info (never
  alerted).
- Do not add `pharos-status` or `pharos-actions` to `host`: they cannot report
  themselves down.
- `pharos-backup.timer` runs `scripts/backup-state.sh` weekly (catches up
  after sleep): `pharos_tailscale-state` → `~/backups/tailscale-state-<date>.tgz`
  and `pharos_adguard-conf` → `adguard-conf-<date>.tgz`, mode 600, newest 4
  of each kept.

## Verify

| URL | Expected |
|---|---|
| `https://ai.example.ts.net/` | 200 |
| `https://dns.example.ts.net/` | 302 |
| `https://ts.example.ts.net/` | 200 |

- `DASH=$(tailscale serve status | awk 'NR==1 {print $1}')`; `$DASH/` is 200
  and `$DASH/data/status.json` is under a minute old.
- 502 = backend down; 404 = serve path missing.
- `tailscale service list` shows the configured Services on `tcp:443`.

## Gotchas

- Node serve recovery: [Operations](docs/operations.md#serve-configuration).
- Approving a Service host is console-only; the CLI only advertises.
- `TS_AUTH_ONCE=true`: a new `.env` key may not re-authenticate while state
  exists.
- `acl-recommended.json` hardcodes an example host IP; replace it.
- `compose.override.yaml` holds this host's AdGuard DNS binds; `install.sh`
  writes it and it is ignored. Never commit it.
- Images are pinned (Tailscale, nginx, AdGuard, the backup's alpine); upgrade
  by changing the tag: [Operations](docs/operations.md#upgrades).
- The host is a laptop; sleep stops everything.

## Read first

- `docs/bootstrap.md`: Services, auth, serve, ACL.
- `docs/operations.md`: health, alerts, recovery, backups.
- `docs/architecture.md`: request flow and decisions.
