#!/bin/sh
# Set up Pharos on this host, or bring it up to date. Safe to run again.
#
#   scripts/install.sh ~/backups/tailscale-state-<date>.tgz  # move: restore the pharos node
#                                                            # (and adguard-conf-<date>.tgz beside it)
#   scripts/install.sh tskey-auth-...                        # fresh: register a new pharos node
#   scripts/install.sh                                       # re-run on a set-up host
#
# Needs Docker, Tailscale (logged in as you) and python3; asks for sudo once,
# for the node serve and the LAN route. Prints the admin console steps it cannot do.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
vol=pharos_tailscale-state
arg=${1:-}
say() { printf '\n== %s\n' "$*"; }
js() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

for c in docker tailscale python3 ip ss; do
  command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 1; }
done
[ "$(tailscale status --json | js 'd["BackendState"]')" = Running ] ||
  { echo "Tailscale is not logged in: run 'sudo tailscale up' first" >&2; exit 1; }
tailnet=$(tailscale status --json | js 'd["MagicDNSSuffix"]')
hostip=$(tailscale ip -4)
node=$(tailscale status --json | js 'd["Self"]["HostName"]')
# the LAN is the subnet of the interface that holds the default route
lan=$(python3 - <<'EOF'
import ipaddress, json, subprocess
run = lambda *a: json.loads(subprocess.run(["ip", "-j", *a], capture_output=True, text=True).stdout or "[]")
dev = next((r["dev"] for r in run("route", "show", "default")), None)
for a in (run("-4", "addr", "show", "dev", dev)[0]["addr_info"] if dev else []):
    print(ipaddress.ip_interface(f"{a['local']}/{a['prefixlen']}").network)
    break
EOF
)

# volumes made here carry compose's labels, so compose adopts them without warnings
mkvol() { docker volume create --label com.docker.compose.project=pharos --label "com.docker.compose.volume=$1" "pharos_$1" >/dev/null; }

say "pharos node"
if docker volume inspect "$vol" >/dev/null 2>&1; then
  fresh=no
  echo "state volume exists; keeping it"
elif [ -f "$arg" ]; then
  fresh=no
  mkvol tailscale-state
  docker run --rm -v "$vol":/data -v "$(cd "$(dirname "$arg")" && pwd)":/backup:ro alpine:3.24 \
    tar xzf "/backup/$(basename "$arg")" -C /data
  echo "restored $arg; stop tailscale on the old host so one identity runs once"
  adg="$(dirname "$arg")/adguard-conf-$(basename "$arg" | sed 's/^.*-state-//')"
  if [ -f "$adg" ] && ! docker volume inspect pharos_adguard-conf >/dev/null 2>&1; then
    mkvol adguard-conf
    docker run --rm -v pharos_adguard-conf:/data -v "$(cd "$(dirname "$adg")" && pwd)":/backup:ro alpine:3.24 \
      tar xzf "/backup/$(basename "$adg")" -C /data
    echo "restored $adg"
  fi
elif [ "${arg#tskey-}" != "$arg" ]; then
  fresh=yes
  (umask 077 && printf 'TS_AUTHKEY=%s\n' "$arg" > .env)
  echo "wrote .env (first boot only)"
else
  echo "no state volume: pass a backup archive (move) or a tag:services auth key (fresh)" >&2
  exit 1
fi
# AdGuard answers DNS on this host's LAN and tailnet IPs only; keep those
# host-specific binds in the ignored override so compose.yaml stays generic.
lanip=$(ip -j route show default | js 'd[0]["prefsrc"]' 2>/dev/null || true)
{
  printf 'services:\n  adguard:\n    ports:\n'
  [ -z "$lanip" ] || printf '      - "%s:53:53/tcp"\n      - "%s:53:53/udp"\n' "$lanip" "$lanip"
  printf '      - "%s:53:53/tcp"\n      - "%s:53:53/udp"\n' "$hostip" "$hostip"
} > compose.override.yaml
echo "compose.override.yaml: AdGuard DNS on ${lanip:-no LAN} and $hostip"
mkdir -p "$HOME/.local/state/pharos" "$HOME/.config/systemd/user"  # before compose, or Docker makes it root's
if [ ! -f site/config.json ]; then
  cp site/config.example.json site/config.json
  echo "wrote site/config.json from the example; edit it for this host"
fi
docker compose up -d
i=0
until [ "$(docker exec pharos-tailscale tailscale status --json 2>/dev/null | js 'd["BackendState"]' 2>/dev/null)" = Running ]; do
  i=$((i + 1)); [ $i -lt 60 ] || { echo "tailscale did not come online; see docker compose logs tailscale" >&2; exit 1; }
  sleep 1
done
if [ "$fresh" = yes ]; then
  # publish every Service endpoint from config.json; a non-root path keeps its path on the backend
  python3 -c '
import json
for s in json.load(open("site/config.json"))["services"]:
    for e in s["endpoints"]:
        p = e["path"]
        print(s["service"], p, "http://127.0.0.1:%d%s" % (e["port"], "" if p == "/" else p))
' | while read -r svc path backend; do
    set -- --service="$svc" --https=443
    [ "$path" = / ] || set -- "$@" --set-path="$path"
    docker exec pharos-tailscale tailscale serve --bg "$@" "$backend" || true  # warns until the host is approved
  done
fi

say "user units"
for f in systemd/*.service systemd/*.timer; do
  sed -e "s#%h/Projects/pharos#$repo#g" -e "s#TAILNET#$tailnet#g" "$f" > "$HOME/.config/systemd/user/$(basename "$f")"
done
systemctl --user daemon-reload
systemctl --user enable --now pharos-status pharos-actions tailscale-web pharos-backup.timer
systemctl --user restart pharos-status pharos-actions tailscale-web  # pick up new code on a re-run
if [ -x "$HOME/.local/share/mise/shims/opencode" ]; then
  systemctl --user enable --now opencode-web
else
  echo "opencode is not installed (mise use -g opencode); svc:ai stays down until it is"
fi
loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"

say "node serve and LAN route (sudo)"
sudo tailscale serve --bg http://127.0.0.1:8080
sudo tailscale serve --bg --set-path /api "unix:${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/pharos-actions.sock"
[ -z "$lan" ] || sudo tailscale set --advertise-routes="$lan"  # replaces any other advertised routes

say "backup"
ls "$HOME"/backups/tailscale-state-*.tgz >/dev/null 2>&1 || scripts/backup-state.sh

say "check"
python3 scripts/pharos-status.py --once --out "$(mktemp -d)/status.json" || true
echo "Pharos: https://$(tailscale status --json | js 'd["Self"]["DNSName"].rstrip(".")')/"

say "left for you in the admin console (login.tailscale.com/admin)"
[ "$fresh" = no ] || echo "- Services: approve 'pharos' as host of each svc:*, then revoke the key and remove .env"
[ -z "$lan" ] || echo "- Machines -> $node -> Subnets: approve $lan"
echo "- DNS: nameserver $hostip (AdGuard) with Override local DNS"
echo "- Access controls: paste acl-recommended.json with the example host IP and SSH user replaced"
docker run --rm -v pharos_adguard-conf:/c:ro alpine:3.24 test -s /c/AdGuardHome.yaml ||
  echo "- AdGuard is new: finish its setup at https://dns.$tailnet/"
