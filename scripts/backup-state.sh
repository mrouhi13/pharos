#!/bin/sh
# Snapshot the tailscale state volume (tagged node identity and every svc:*
# handler) and AdGuard's settings to ~/backups, keeping the newest 4 of each.
# Run weekly by pharos-backup.timer.
set -eu
dir="${BACKUP_DIR:-$HOME/backups}"
name="tailscale-state-$(date +%F).tgz"
adg="adguard-conf-$(date +%F).tgz"
owner="$(id -u):$(id -g)"
mkdir -p "$dir"
# The volumes are root-owned, so tar runs in a container; the archives hold node
# keys and the AdGuard login hash, so they are handed back with mode 600.
docker run --rm -v pharos_tailscale-state:/data:ro -v pharos_adguard-conf:/adg:ro -v "$dir":/backup alpine:3.24 \
  sh -c "tar czf /backup/$name -C /data . && tar czf /backup/$adg -C /adg . &&
         chown $owner /backup/$name /backup/$adg && chmod 600 /backup/$name /backup/$adg"
for kind in tailscale-state adguard-conf; do
  ls -1t "$dir"/$kind-*.tgz 2>/dev/null | tail -n +5 | xargs -r rm --
done
echo "saved $dir/$name and $dir/$adg"
