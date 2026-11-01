#!/usr/bin/env python3
"""Collect Pharos status and write it as JSON for the dashboard.

Reads site/config.json, checks every endpoint over HTTPS, reads both
tailscaled nodes, lists every Docker container and the host units named in
the config, audits ports listening beyond loopback, reads host health
(disk, memory, load, power), records state changes as events and sends
alerts for them (unless quiet mode is on), looks for newer image tags once
a day, and atomically writes status.json to $XDG_STATE_HOME/pharos/
(default ~/.local/state/pharos/), which nginx serves at /data/status.json.
SIGUSR1 starts the next cycle at once (pharos-actions sends it after an
action). Standard library only.
"""

import argparse
import concurrent.futures
import datetime as dt
import ipaddress
import json
import glob
import os
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request

VERSION = 1
HISTORY = 60
EVENTS = 20         # latest events kept in status.json (the Overview)
HISTORY_DAYS = 30   # events.json keeps this many days for the Events tab
CONFIRM = 2         # failing cycles in a row before a problem counts (one blip is not an alert)
DISK_WARN = 90      # % used
MEM_WARN = 10       # % available
BATTERY_WARN = 20   # % left while discharging
HTTP_TIMEOUT = 4
CMD_TIMEOUT = 8
UPDATE_TTL = 86400  # seconds between registry checks for newer image tags
KEY_WARN_DAYS = 14  # node key expiry warning
PKG_TTL = 3600      # seconds between package update checks
LAN_KEEP_DAYS = 7   # LAN devices not seen for this long drop off the list
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "pharos")


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # a 302 is a result, not something to follow


OPENER = urllib.request.build_opener(NoRedirect)


def check(url, expect):
    start = time.monotonic()
    code, error = None, None
    try:
        with OPENER.open(urllib.request.Request(url, headers={"User-Agent": "pharos-status"}), timeout=HTTP_TIMEOUT) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except urllib.error.URLError as e:
        error = "timeout" if isinstance(e.reason, TimeoutError) else str(e.reason)
    except TimeoutError:
        error = "timeout"
    except OSError as e:
        error = str(e)
    ms = round((time.monotonic() - start) * 1000)
    return {"code": code, "ms": ms, "ok": code in expect, "error": error}


def run_json(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=CMD_TIMEOUT, check=True).stdout
        return json.loads(out)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def node_info(status):
    if not status or not status.get("Self"):
        return {"online": False}
    me = status["Self"]
    return {
        "online": status.get("BackendState") == "Running" and bool(me.get("Online")),
        "ip": (me.get("TailscaleIPs") or [None])[0],
        "version": (status.get("Version") or "").split("-")[0] or None,
        "keyExpiry": me.get("KeyExpiry"),
        "name": me.get("HostName"),
    }


def run_text(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=CMD_TIMEOUT, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None


def containers():
    """Every container, running or not, from one docker inspect call."""
    ids = run_text(["docker", "ps", "-aq"])
    if ids is None:
        return None
    ids = ids.split()
    data = run_json(["docker", "inspect", *ids]) if ids else []
    out = []
    for c in data or []:
        st, cfg, labels = c.get("State") or {}, c.get("Config") or {}, (c.get("Config") or {}).get("Labels") or {}
        ports = []
        for binds in ((c.get("NetworkSettings") or {}).get("Ports") or {}).values():
            for b in binds or []:
                addr = f"{b.get('HostIp') or '0.0.0.0'}:{b.get('HostPort')}"
                if addr not in ports:
                    ports.append(addr)
        out.append({
            "name": c.get("Name", "").lstrip("/"),
            "image": cfg.get("Image"),
            "project": labels.get("com.docker.compose.project"),
            "dir": labels.get("com.docker.compose.project.working_dir"),
            "service": labels.get("com.docker.compose.service"),
            "files": labels.get("com.docker.compose.project.config_files"),
            "state": st.get("Status"),  # running, exited, restarting, ...
            "health": (st.get("Health") or {}).get("Status"),
            "since": st.get("StartedAt") if st.get("Running") else st.get("FinishedAt"),
            "exitCode": st.get("ExitCode"),
            "restarts": c.get("RestartCount", 0),
            "network": (c.get("HostConfig") or {}).get("NetworkMode"),
            "ports": ports,
        })
    out.sort(key=lambda x: x["name"])
    return out


def host_units(cfg):
    """State of the host systemd units listed in config.host."""
    out = []
    for u in cfg.get("host", []):
        cmd = ["systemctl"] + (["--user"] if u.get("scope") == "user" else [])
        text = run_text(cmd + ["show", u["unit"], "--timestamp=unix", "-p", "ActiveState,SubState,ActiveEnterTimestamp"]) or ""
        props = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
        since = props.get("ActiveEnterTimestamp", "").lstrip("@")
        out.append({
            "unit": u["unit"],
            "state": props.get("ActiveState") or "unknown",
            "sub": props.get("SubState"),
            "since": dt.datetime.fromtimestamp(int(since), dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z") if since.isdigit() else None,
        })
    return out


def scope_of(ip):
    if ip.is_loopback or ip.is_multicast:
        return None  # not reachable from other machines
    if ip in ipaddress.ip_network("100.64.0.0/10") or ip in ipaddress.ip_network("fd7a:115c:a1e0::/48"):
        return "tailnet"
    if ip in ipaddress.ip_network("172.16.0.0/12"):
        return None  # Docker bridges: host-local
    if ip.is_unspecified:
        return "all"
    if ip.is_private or ip.is_link_local:
        return "lan"
    return "public"


def exposure(cfg, peerapi):
    """TCP/UDP listeners that other machines could reach, marked expected or not."""
    text = run_text(["ss", "-H", "-tuln"])
    if text is None:
        return None
    rules = cfg.get("exposure", [])
    found = {}
    for line in text.splitlines():
        cols = line.split()
        if len(cols) < 5:
            continue
        proto, local = cols[0], cols[4]
        host, _, port = local.rpartition(":")
        host, _, iface = host.strip("[]").partition("%")
        host = host.strip("[]")
        if iface == "lo" or not port.isdigit():
            continue
        try:
            scope = scope_of(ipaddress.ip_address(host if host != "*" else "0.0.0.0"))
        except ValueError:
            continue
        if not scope:
            continue
        port = int(port)
        e = found.setdefault((port, proto), {"port": port, "proto": proto, "scopes": [], "expected": True, "note": None})
        if scope not in e["scopes"]:
            e["scopes"].append(scope)
        if (proto, port) in peerapi:
            note = "tailscaled peer API"
        else:
            rule = next((r for r in rules if r["port"] == port and r.get("proto", proto) == proto
                         and r.get("scope", scope) == scope), None)
            note = rule.get("note") if rule else None
            if not rule:
                e["expected"] = False  # one unmatched address makes the whole port unexpected
        e["note"] = e["note"] or note
    return sorted(found.values(), key=lambda e: (e["expected"], e["port"], e["proto"]))


def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def health():
    """Disk, memory, load, power, and boot time of the host."""
    disks, seen = [], set()
    for path, name in (("/", "/"), (os.path.expanduser("~"), "~")):
        try:
            u = shutil.disk_usage(path)
        except OSError:
            continue
        if (u.total, u.free) in seen:
            continue  # same filesystem (e.g. btrfs subvolumes)
        seen.add((u.total, u.free))
        disks.append({"path": name, "used": u.used, "total": u.total})
    mem = {}
    for line in (read("/proc/meminfo") or "").splitlines():
        k, _, v = line.partition(":")
        if k in ("MemTotal", "MemAvailable"):
            mem[k] = int(v.split()[0]) * 1024
    power = None
    bat = sorted(glob.glob("/sys/class/power_supply/BAT*"))
    if bat:
        ac = [read(p + "/online") for p in glob.glob("/sys/class/power_supply/A[CD]*")]
        cap = read(bat[0] + "/capacity")
        power = {
            "ac": "1" in ac,
            "battery": int(cap) if cap and cap.isdigit() else None,
            "status": read(bat[0] + "/status"),
        }
    up = read("/proc/uptime")
    boot = dt.datetime.fromtimestamp(time.time() - float(up.split()[0]), dt.timezone.utc) if up else None
    return {
        "disks": disks,
        "memory": {"total": mem.get("MemTotal"), "available": mem.get("MemAvailable")} if mem else None,
        "load": list(os.getloadavg()),
        "cpus": os.cpu_count(),
        "power": power,
        "boot": boot.isoformat(timespec="seconds").replace("+00:00", "Z") if boot else None,
    }


def backup(cfg):
    """Newest state backup matching config.backup, if any."""
    b = cfg.get("backup")
    if not b:
        return None
    files = glob.glob(os.path.join(os.path.expanduser(b["dir"]), b["glob"]))
    if not files:
        return {"last": None, "size": None, "count": 0, "maxDays": b.get("maxDays", 14)}
    newest = max(files, key=os.path.getmtime)
    st = os.stat(newest)
    return {
        "last": dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "size": st.st_size,
        "count": len(files),
        "maxDays": b.get("maxDays", 14),
        **verify(newest, st.st_mtime),
    }


_verified = {}


def verify(path, mtime):
    """Open the archive and count its files, once per new backup."""
    if (path, mtime) not in _verified:
        try:
            with tarfile.open(path, "r:gz") as t:
                n = sum(1 for m in t if m.isfile())
            _verified[(path, mtime)] = {"verified": n > 0, "files": n, "error": None if n else "no files inside"}
        except (tarfile.TarError, OSError, EOFError) as e:
            _verified[(path, mtime)] = {"verified": False, "files": 0, "error": str(e) or type(e).__name__}
    return _verified[(path, mtime)]


_tags, _declared = {}, {}


def hub_repo(image):
    """'nginx:1.2' -> ('library/nginx', '1.2'); None for local builds, digests, other registries."""
    name, sep, tag = (image or "").rpartition(":")
    if not sep or "/" in tag or "@" in image or not re.search(r"\d", tag):
        return None
    first = name.split("/")[0]
    if "/" in name and ("." in first or ":" in first or first == "localhost"):
        return None
    return (name if "/" in name else "library/" + name), tag


def hub_tags(repo):
    """Recent tags of a Docker Hub repository, fetched at most once a day (an hour after a failure)."""
    at, tags = _tags.get(repo, (0, None))
    if time.time() - at < UPDATE_TTL:
        return tags
    url = f"https://hub.docker.com/v2/repositories/{repo}/tags?page_size=100&ordering=last_updated"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "pharos-status"}), timeout=HTTP_TIMEOUT) as r:
            tags, at = [t["name"] for t in json.load(r)["results"]], time.time()
    except (OSError, ValueError, KeyError):
        at = time.time() - UPDATE_TTL + 3600
    _tags[repo] = (at, tags)
    return tags


def newest(tag, tags):
    """The highest tag with the same shape as tag (v1.2.3, 1.2.3-alpine, ...), if higher than tag."""
    shape = re.compile("^" + re.sub(r"\d+", r"\\d+", re.escape(tag)) + "$")
    num = lambda t: tuple(int(x) for x in re.findall(r"\d+", t))
    best = max((t for t in tags or [] if shape.match(t)), key=num, default=None)
    return best if best and num(best) > num(tag) else None


def declared(files):
    """Image per service as the compose files declare it, re-read when a file changes."""
    paths = files.split(",")
    try:
        key = tuple((p, os.path.getmtime(p)) for p in paths)
    except OSError:
        return None  # the project moved; recreate it from its new folder
    if key not in _declared:
        cfg = run_json(["docker", "compose", *[a for p in paths for a in ("-f", p)], "config", "--format", "json"])
        _declared[key] = {k: v.get("image") for k, v in ((cfg or {}).get("services") or {}).items()}
    return _declared[key]


def updates(ctrs):
    """Per container: the pinned image, whether it is running, and any newer tag."""
    images = []
    for c in ctrs or []:
        if not c.get("files") or not c.get("service"):
            continue
        pins = declared(c["files"])
        image = (pins or {}).get(c["service"])
        hub = hub_repo(image or c["image"])
        applied = image is None or image == c["image"]
        if not hub and applied:
            continue  # local build: nothing to compare
        images.append({
            "container": c["name"], "project": c["project"], "service": c["service"],
            "files": c["files"].split(",") if pins is not None else None,
            "image": image or c["image"], "running": c["image"], "applied": applied,
            "latest": newest(hub[1], hub_tags(hub[0])) if hub else None,
        })
    return {"images": images}


def checks(cfg, data, previous):
    """Everything that can fail, as key -> (ok, label, detail)."""
    out = {}
    before = {c["name"]: c.get("restarts", 0) for c in ((previous or {}).get("containers") or [])}
    for svc in cfg.get("services", []):
        for ep in svc.get("endpoints", []):
            r = data["endpoints"].get(svc["host"] + ep["path"]) or {}
            label = svc["name"] + ("" if ep["path"] == "/" else " " + ep["path"])
            out["ep:" + svc["host"] + ep["path"]] = (r.get("ok", False), label, str(r.get("code") or r.get("error") or "no response"))
    for name, n in data["nodes"].items():
        out["node:" + name] = (n.get("online", False), (n.get("name") or name) + " tailscaled", "online" if n.get("online") else "offline")
        exp = n.get("keyExpiry")
        if exp and not exp.startswith("0001-"):
            days = (dt.datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() - time.time()) / 86400
            out["key:" + name] = (days > KEY_WARN_DAYS, (n.get("name") or name) + " key",
                                  f"expires in {max(0, days):.0f} days; renew in the admin console")
    r = data["route"]
    if r.get("approved") is not None:
        detail = "approved" if r["approved"] else "not advertised" if r.get("advertised") is False else "not approved"
        out["route"] = (bool(r["approved"]), "LAN route", detail)
    # a Service live on tailscale that config.json does not list
    listed = {svc.get("service") for svc in cfg.get("services", [])}
    for name in sorted(data.get("serve") or {}):
        if name not in listed:
            out[name] = (False, name, "live but not in config.json")  # name is already svc:…
    d = data.get("dns")
    if d and d["adguard"] is not None:
        out["dns"] = (d["adguard"], "Tailnet DNS", "AdGuard" if d["adguard"] else "not using AdGuard (" + (", ".join(d["resolvers"]) or "no resolvers") + ")")
    for c in data["containers"] or []:
        # restarted since the last cycle; two cycles in a row is a crash loop
        looping = c["restarts"] > before.get(c["name"], c["restarts"])
        ok = c["state"] == "running" and c["health"] != "unhealthy" and not looping
        detail = f"restarting ({c['restarts']} restarts)" if looping else c["health"] or c["state"]
        out["ctr:" + c["name"]] = (ok, c["name"], detail)
    for u in data["host"]:
        out["unit:" + u["unit"]] = (u["state"] == "active", u["unit"], u["state"])
    for e in data["exposure"] or []:
        if not e["expected"]:  # only unexpected ports are tracked; closing one is the recovery
            out[f"port:{e['port']}/{e['proto']}"] = (False, f"Port {e['port']}/{e['proto']}", "unexpected listener on " + ", ".join(e["scopes"]))
    h = data["health"]
    for d in h["disks"]:
        pct = round(d["used"] * 100 / d["total"])
        out["disk:" + d["path"]] = (pct < DISK_WARN, "Disk " + d["path"], f"{pct}% used")
    m = h["memory"]
    if m and m["total"]:
        pct = round(m["available"] * 100 / m["total"])
        out["memory"] = (pct >= MEM_WARN, "Memory", f"{pct}% available")
    b = data.get("backup")
    if b is not None:
        age = (time.time() - dt.datetime.fromisoformat(b["last"].replace("Z", "+00:00")).timestamp()) / 86400 if b["last"] else None
        if b.get("verified") is False:
            out["backup"] = (False, "Backup", "newest archive unreadable: " + b["error"])
        else:
            out["backup"] = (age is not None and age < b["maxDays"], "Backup",
                             "none yet" if age is None else f"{age:.0f} days old")
    p = h["power"]
    if p and p["battery"] is not None:
        ok = p["ac"] or p["battery"] > BATTERY_WARN
        out["power"] = (ok, "Battery", f"{p['battery']}% · {'on AC' if p['ac'] else (p['status'] or 'discharging').lower()}")
    return out


def tail(cmd, n=12):
    """Last n lines of a command's stdout and stderr, trimmed for events.json."""
    try:
        out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=CMD_TIMEOUT).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [line[:300] for line in out.splitlines() if line.strip()][-n:]


def why(key, cfg, data):
    """Context for a failure, gathered once when it is confirmed: what the page shows under the event."""
    kind, _, name = key.partition(":")
    if kind == "ep":
        r = data["endpoints"].get(name) or {}
        svc = next((s for s in cfg.get("services", []) if name.startswith(s.get("host", "") + "/")), None)
        ep = next((e for e in (svc or {}).get("endpoints", []) if svc["host"] + e["path"] == name), {})
        got = r.get("code") or r.get("error") or "no response"
        out = [f"GET https://{name} → {got} in {r.get('ms')} ms; expected {', '.join(map(str, ep.get('expect', [200])))}"]
        hint = {502: "502: serve is up but its backend is not answering", 404: "404: serve has no handler for this path"}.get(r.get("code"))
        if hint:
            out.append(hint)
        proxy = ((data.get("serve") or {}).get((svc or {}).get("service")) or {}).get("/")
        if proxy:
            out.append(f"serve proxies {(svc or {}).get('service')} to {proxy}")
        return out
    if kind == "ctr":
        info = (run_json(["docker", "inspect", name]) or [{}])[0].get("State") or {}
        out = [f"state {info.get('Status')}, exit code {info.get('ExitCode')}"
               + (", killed: out of memory" if info.get("OOMKilled") else "")
               + (f", error: {info['Error']}" if info.get("Error") else "")]
        probe = ((info.get("Health") or {}).get("Log") or [{}])[-1]
        if probe.get("Output"):
            out.append(f"health check (exit {probe.get('ExitCode')}): {probe['Output'].strip()[:300]}")
        return out + ["--- docker logs ---"] + tail(["docker", "logs", "--tail", "12", name])
    if kind == "unit":
        user = ["--user"] if any(u["unit"] == name and u.get("scope") == "user" for u in cfg.get("host", [])) else []
        props = run_text(["systemctl", *user, "show", name, "-p", "SubState,Result,ExecMainStatus"]) or ""
        return [" ".join(props.split())] + ["--- journal ---"] + tail(["journalctl", *user, "-u", name, "-n", "12", "--no-pager", "-o", "short"])
    if kind == "node":
        cmd = ["tailscale", "status", "--json"]
        st = run_json(cmd if name == "host" else ["docker", "exec", "pharos-tailscale", *cmd]) or {}
        return [f"backend {st.get('BackendState', 'unreachable')}"] + list(st.get("Health") or [])
    if kind == "port":
        port, _, proto = name.partition("/")
        return tail(["ss", "-H", "-lnp", "--" + ("udp" if proto == "udp" else "tcp"), f"sport = :{port}"]) or ["listener owned by another user (run ss -lnp as root to see it)"]
    if key == "memory":
        return ["top memory users (RSS KiB):"] + (run_text(["ps", "-eo", "rss,comm", "--sort=-rss", "--no-headers"]) or "").splitlines()[:6]
    return None


def ago(seconds):
    return f"{round(seconds / 60)} min" if seconds < 3600 else f"{seconds / 3600:.1f} h"


def track(current, previous, t, interval):
    """Compare checks with the last cycle; return (state, events, new events)."""
    prev = (previous or {}).get("checks") or {}
    events = list((previous or {}).get("events") or [])
    new = []
    if previous and previous.get("generated"):
        gap = (dt.datetime.fromisoformat(t.replace("Z", "+00:00"))
               - dt.datetime.fromisoformat(previous["generated"].replace("Z", "+00:00"))).total_seconds()
        if gap > 5 * interval:
            new.append({"t": t, "key": "collector", "label": "Collector", "ok": None,
                        "detail": f"resumed after {ago(gap)}; the host was asleep or the collector stopped"})
    state = {}
    for key, (ok, label, detail) in current.items():
        # unseen keys start healthy when there is history, so a new failure still alerts
        p = prev.get(key) or {"ok": True if prev else ok, "since": t, "bad": 0}
        bad = 0 if ok else p.get("bad", 0) + 1
        confirmed, changed_at = p["ok"], p["since"]
        if (confirmed and bad >= CONFIRM) or (not confirmed and ok):
            confirmed, changed_at = ok, t
            new.append({"t": t, "key": key, "label": label, "ok": ok, "detail": detail})
        # ok/since are the confirmed state (alerts); bad > 0 means failing right now (the page)
        state[key] = {"ok": confirmed, "since": changed_at, "bad": bad, "label": label, "detail": detail}
    for key, p in prev.items():
        if key not in current and not p["ok"]:  # a failing thing went away (e.g. port closed)
            new.append({"t": t, "key": key, "label": p.get("label", key), "ok": True, "detail": "gone"})
    return state, (events + new)[-EVENTS:], new


def notify(cfg, events):
    """Send new problems and recoveries to the desktop and, if set, ntfy."""
    events = [e for e in events if e["ok"] is not None]
    alerts = cfg.get("alerts") or {}
    if not events:
        return
    bad = any(not e["ok"] for e in events)
    line = lambda e: ("✓ " if e["ok"] else "✕ ") + e["label"] + " · " + e["detail"]
    if len(events) == 1:
        e = events[0]
        title, body = e["label"] + (" recovered" if e["ok"] else " problem"), e["detail"]
    else:
        title, body = f"Pharos: {len(events)} changes", "\n".join(map(line, events))
    if alerts.get("desktop", True):
        try:
            subprocess.run(["notify-send", "-a", "Pharos", "-u", "critical" if bad else "normal", title, body],
                           timeout=CMD_TIMEOUT, check=False, capture_output=True)
        except (OSError, subprocess.SubprocessError):
            pass
    if alerts.get("ntfy"):
        req = urllib.request.Request(alerts["ntfy"], data=body.encode(), method="POST", headers={
            "Title": title.encode("latin-1", "replace").decode("latin-1"),
            "Priority": "high" if bad else "default",
            "Tags": "warning" if bad else "white_check_mark",
        })
        try:
            urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).close()
        except OSError as e:
            print(f"ntfy failed: {e}", file=sys.stderr, flush=True)


def last_seen(value):
    # tailscaled reports year 1 for peers that are online now
    return None if not value or value.startswith("0001-") else value


def path_of(peer):
    """How traffic reaches a peer: direct (with the address), through a relay, or idle."""
    if not peer.get("Online"):
        return {"path": None}
    if peer.get("CurAddr"):
        return {"path": "direct", "via": peer["CurAddr"]}
    if peer.get("PeerRelay"):
        return {"path": "relay", "via": "peer relay " + peer["PeerRelay"]}
    if peer.get("Active") and peer.get("Relay"):
        return {"path": "relay", "via": "DERP " + peer["Relay"]}
    return {"path": "idle"}  # no recent traffic, so no path yet


_names = {}


def ptr(ip, server, timeout=1.0):
    """Reverse-DNS name of ip, asked straight from server (the router knows its DHCP clients)."""
    qid = int.from_bytes(os.urandom(2), "big")
    name = ".".join(reversed(ip.split("."))) + ".in-addr.arpa"
    query = (struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
             + b"".join(bytes([len(x)]) + x.encode() for x in name.split(".")) + b"\0" + struct.pack(">HH", 12, 1))
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        try:
            s.sendto(query, (server, 53))
            data = s.recv(512)
        except OSError:
            return None

    def labels(off):  # a DNS name, following compression pointers
        out = []
        while data[off]:
            if data[off] & 0xC0 == 0xC0:
                return out + labels(((data[off] & 0x3F) << 8) | data[off + 1])[0], off + 2
            out.append(data[off + 1:off + 1 + data[off]].decode(errors="replace"))
            off += 1 + data[off]
        return out, off + 1

    try:
        rid, flags, _, answers = struct.unpack(">HHHH", data[:8])
        if rid != qid or flags & 0xF or not answers:
            return None
        off = labels(12)[1] + 4
        for _ in range(answers):
            off = labels(off)[1]
            kind, _, _, size = struct.unpack(">HHIH", data[off:off + 10])
            off += 10
            if kind == 12:
                return ".".join(labels(off)[0])
            off += size
    except (IndexError, struct.error, RecursionError):  # RecursionError: a pointer loop
        return None
    return None


def rdns(ip, server):
    """Short name for a LAN address, cached for an hour."""
    at, name = _names.get(ip, (0, None))
    if time.time() - at > 3600:
        full = ptr(ip, server) if server else None
        name = full.split(".")[0] if full else None
        _names[ip] = (time.time(), name)
    return name


def lan_devices(cfg, previous, devices, lan, gateway):
    """LAN hosts from the neighbour table (no scanning), with names and when each was last seen."""
    rows = run_json(["ip", "-j", "neigh", "show"])
    if not lan or rows is None:
        return None
    net, now = ipaddress.ip_network(lan), now_iso()
    labels = {k.lower(): v for k, v in ((cfg.get("network") or {}).get("names") or {}).items()}
    # a tailnet device reached directly over the LAN uses the same address
    tailnet = {(d.get("via") or "").rsplit(":", 1)[0]: d["name"] for d in devices or [] if d.get("path") == "direct"}
    prev = {d["mac"]: d for d in ((previous or {}).get("lan") or [])}
    found = {}
    for r in rows:
        ip, mac, state = r.get("dst", ""), (r.get("lladdr") or "").lower(), r.get("state") or []
        try:
            if not mac or ipaddress.ip_address(ip) not in net:
                continue
        except ValueError:
            continue
        online = any(x in state for x in ("REACHABLE", "DELAY", "PROBE"))
        p = prev.get(mac) or {}
        found[mac] = {"ip": ip, "mac": mac, "name": labels.get(mac) or ("Router" if ip == gateway else None),
                      "online": online, "seen": now if online else p.get("seen") or now, "tailnet": tailnet.get(ip)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for d, name in zip(found.values(), pool.map(lambda ip: rdns(ip, gateway), [d["ip"] for d in found.values()])):
            d["host"] = name
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=LAN_KEEP_DAYS)).isoformat(timespec="seconds").replace("+00:00", "Z")
    for mac, p in prev.items():  # gone from the table: keep it a while as offline
        if mac not in found and p.get("seen", "") >= cutoff:
            found[mac] = dict(p, online=False)
    return sorted(found.values(), key=lambda d: tuple(int(x) for x in d["ip"].split(".")))


_pkgs = {"at": 0, "repo": None, "aur": None, "running": False}


def pending_packages():
    """Pending repo (checkupdates) and AUR (yay -Qua) updates; refreshed hourly in the background."""
    def lines(cmd):
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        except (OSError, subprocess.SubprocessError):
            return None
        if p.returncode < 0 or (p.returncode and not p.stdout and p.stderr.strip()):
            return None  # a real failure; checkupdates (2) and yay (1) exit non-zero quietly when nothing is pending
        out = []
        for line in p.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 4 and parts[2] == "->":
                out.append({"name": parts[0], "from": parts[1], "to": parts[3]})
        return out

    def work():
        started = time.time()  # an update ending after this triggers a fresh check
        repo = lines(["checkupdates"]) if shutil.which("checkupdates") else None
        aur = lines(["yay", "-Qua"]) if shutil.which("yay") else None
        _pkgs.update(at=started, repo=repo, aur=aur, running=False)

    if not _pkgs["running"] and time.time() - _pkgs["at"] > PKG_TTL:
        _pkgs["running"] = True
        threading.Thread(target=work, daemon=True).start()


def packages():
    """Pending packages and whether the running kernel is still installed."""
    try:
        if os.path.getmtime("/var/lib/pacman/local") > _pkgs["at"]:
            _pkgs["at"] = 0  # packages changed (omarchy update, pacman, yay): check again
    except OSError:
        pass
    pending_packages()
    return {
        "checked": dt.datetime.fromtimestamp(_pkgs["at"], dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z") if _pkgs["at"] else None,
        "repo": _pkgs["repo"], "aur": _pkgs["aur"],
        "reboot": not os.path.isdir("/usr/lib/modules/" + os.uname().release),
        "kernel": os.uname().release,
    }


def collect(cfg, previous):
    host_st = run_json(["tailscale", "status", "--json"])
    # Services are <name>.<tailnet>; read the tailnet instead of storing it in config.json
    tailnet = (host_st or {}).get("MagicDNSSuffix") or (previous or {}).get("tailnet")
    for s in cfg.get("services", []):
        if not s.get("host") and tailnet:
            s["host"] = s["service"].split(":", 1)[1] + "." + tailnet
    endpoints = [
        (s["host"] + e["path"], e.get("expect", [200]))
        for s in cfg.get("services", []) if s.get("host")
        for e in s.get("endpoints", [])
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {key: pool.submit(check, "https://" + key, expect) for key, expect in endpoints}
        default = pool.submit(run_json, ["ip", "-j", "route", "show", "default"])
        prefs = pool.submit(run_json, ["tailscale", "debug", "prefs"])
        dns = pool.submit(run_json, ["tailscale", "dns", "status", "--json"])
        ctr_st = pool.submit(run_json, ["docker", "exec", "pharos-tailscale", "tailscale", "status", "--json"])
        serve = pool.submit(run_json, ["docker", "exec", "pharos-tailscale", "tailscale", "serve", "status", "--json"])
        ctrs = pool.submit(containers)
        hw = pool.submit(health)
        units = pool.submit(host_units, cfg)
        results = {key: f.result() for key, f in futures.items()}
        prefs, ctr_st, serve, default = prefs.result(), ctr_st.result(), serve.result(), default.result()
        dns = dns.result()
        ctrs, units, hw = ctrs.result(), units.result(), hw.result()

    t = now_iso()
    prev_eps = (previous or {}).get("endpoints") or {}
    for key, r in results.items():
        hist = (prev_eps.get(key) or {}).get("history") or []
        r["history"] = (hist + [{"t": t, "ok": r["ok"], "ms": r["ms"]}])[-HISTORY:]

    # the LAN is the IPv4 route the host advertises (0.0.0.0/0 would be an exit node)
    routes = [x for x in ((prefs or {}).get("AdvertiseRoutes") or []) if "." in x and x != "0.0.0.0/0"]
    lan = routes[0] if routes else (previous or {}).get("route", {}).get("lan")
    gateway = next((x["gateway"] for x in default or [] if x.get("gateway")), None)
    me = (host_st or {}).get("Self") or {}
    route = {
        "lan": lan, "gateway": gateway,
        "advertised": (lan in (prefs.get("AdvertiseRoutes") or [])) if prefs else None,
        "approved": (lan in (me.get("PrimaryRoutes") or [])) if host_st else None,
    }

    names = {d["host"]: d["name"] for d in cfg.get("devices", [])}
    devices = []
    for p in ((host_st or {}).get("Peer") or {}).values():
        if p.get("Tags"):
            continue  # tagged nodes are infrastructure, not devices
        host = p.get("HostName") or ""
        devices.append({
            "host": host,
            "name": names.get(host, host),
            "os": p.get("OS") or None,
            "online": bool(p.get("Online")),
            "lastSeen": last_seen(p.get("LastSeen")),
            "ips": p.get("TailscaleIPs") or [],
            "dns": (p.get("DNSName") or "").rstrip(".") or None,
            "created": p.get("Created"),
            "keyExpiry": p.get("KeyExpiry"),
            "rx": p.get("RxBytes"), "tx": p.get("TxBytes"),
            "handshake": last_seen(p.get("LastHandshake")),
            "exitNode": bool(p.get("ExitNodeOption")),
            **path_of(p),
        })
    devices.sort(key=lambda d: (not d["online"], d["name"].lower()))

    svc_map = None
    if serve is not None:
        svc_map = {}
        for name, svc in (serve.get("Services") or {}).items():
            paths = {}
            for web in (svc.get("Web") or {}).values():
                for path, h in (web.get("Handlers") or {}).items():
                    paths[path] = h.get("Proxy")
            svc_map[name] = paths

    # tailscaled picks its peer API port at start; read it rather than listing it
    peerapi = {("tcp", int(u.rsplit(":", 1)[1])) for u in (me.get("PeerAPIURL") or [])}

    # Tailnet-wide DNS: AdGuard listens on the host's tailnet IP, so that IP should be a resolver.
    host_ip = (me.get("TailscaleIPs") or [None])[0]
    resolvers = [r.get("Addr") for r in ((dns or {}).get("Resolvers") or [])]
    dns_info = None if dns is None else {
        "resolvers": resolvers,
        "adguard": host_ip in resolvers if host_ip else None,
    }

    return {
        "version": VERSION,
        "generated": t,
        "tailnet": tailnet,
        "endpoints": results,
        "nodes": {"host": node_info(host_st), "services": node_info(ctr_st)},
        "route": route,
        "dns": dns_info,
        "devices": devices if host_st else None,
        "serve": svc_map,
        "containers": ctrs,
        "host": units,
        "exposure": exposure(cfg, peerapi),
        "health": hw,
        "backup": backup(cfg),
        "updates": updates(ctrs),
        "lan": lan_devices(cfg, previous, devices if host_st else None, lan, gateway),
        "packages": packages(),
    }


def save_history(path, new, now):
    """Append new events to events.json and drop those older than HISTORY_DAYS."""
    if not new and os.path.exists(path):
        return
    cutoff = (now - dt.timedelta(days=HISTORY_DAYS)).isoformat(timespec="seconds").replace("+00:00", "Z")
    events = [e for e in (load(path) or []) if e.get("t", "") >= cutoff] + new
    write_atomic(path, events)


def write_atomic(path, data):
    folder = os.path.dirname(path)
    os.makedirs(folder, mode=0o755, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".status-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, separators=(",", ":"))
        os.chmod(tmp, 0o644)  # nginx in the container must read it
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def quiet_mode(state):
    """quiet.json (written by pharos-actions) pauses alerts until its time."""
    q = load(os.path.join(state, "quiet.json"))
    return q if q and q.get("until", "") > now_iso() else None


def take_pending(state):
    """Action events queued by pharos-actions; the rename makes each one count once."""
    path = os.path.join(state, "pending.jsonl")
    taken = path + ".taken"
    try:
        os.replace(path, taken)
    except FileNotFoundError:
        return []
    with open(taken) as f:
        lines = f.read().splitlines()
    os.remove(taken)
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def watch_docker(wake):
    """Start a cycle as soon as a container starts, stops, or changes health."""
    cmd = ["docker", "events", "--filter", "type=container", "--filter", "event=start",
           "--filter", "event=die", "--filter", "event=health_status"]  # one line per event
    while True:
        try:
            with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True) as p:
                for _ in p.stdout:
                    try:
                        wake.send(b"d")
                    except BlockingIOError:
                        pass  # a wake is already queued
        except OSError:
            pass
        time.sleep(10)  # docker restarted or is not running yet


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default=os.path.join(ROOT, "site", "config.json"))
    ap.add_argument("--out", default=os.path.join(STATE, "status.json"))
    ap.add_argument("--interval", type=int, default=30, help="seconds between checks")
    ap.add_argument("--once", action="store_true", help="run one cycle and exit")
    args = ap.parse_args()

    state = os.path.dirname(args.out)
    # Anything that should start a cycle at once writes a byte here: SIGUSR1 (from
    # pharos-actions) through set_wakeup_fd, and Docker events from their thread.
    woken, wake = socket.socketpair()
    woken.setblocking(False)
    wake.setblocking(False)
    signal.signal(signal.SIGUSR1, lambda *_: None)
    signal.set_wakeup_fd(wake.fileno())
    if not args.once:
        threading.Thread(target=watch_docker, args=(wake,), daemon=True).start()
    previous = load(args.out)
    history = os.path.join(os.path.dirname(args.out), "events.json")
    if not os.path.exists(history) and previous:
        write_atomic(history, previous.get("events") or [])  # seed from the older status.json
    while True:
        started = time.monotonic()
        cfg = load(args.config)  # re-read each cycle so config edits apply live
        if cfg is None:
            print(f"cannot read {args.config}", file=sys.stderr, flush=True)
        else:
            data = collect(cfg, previous)
            data["interval"] = args.interval
            data["checks"], data["events"], new = track(checks(cfg, data, previous), previous, data["generated"], args.interval)
            for e in new:
                if e["ok"] is False:
                    e["more"] = why(e["key"], cfg, data) or None
            data["quiet"] = quiet_mode(state)
            done = take_pending(state)  # actions are info events: logged, never alerted
            if done:
                data["events"] = sorted(data["events"] + done, key=lambda e: e["t"])[-EVENTS:]
            write_atomic(args.out, data)
            save_history(history, sorted(new + done, key=lambda e: e["t"]), dt.datetime.now(dt.timezone.utc))
            if not data["quiet"]:
                notify(cfg, new)
            for e in new:
                print("event:", e["label"], "·", e["detail"], flush=True)
            previous = data
            eps = data["endpoints"].values()
            bad = [k for k, v in data["endpoints"].items() if not v["ok"]]
            print(f"{sum(e['ok'] for e in eps)}/{len(eps)} endpoints ok"
                  + (f" · failing: {', '.join(bad)}" if bad else ""), flush=True)
        if args.once:
            return
        if select.select([woken], [], [], max(1, args.interval - (time.monotonic() - started)))[0]:
            time.sleep(2)  # let a burst (compose recreate, several actions) settle into one cycle
            try:
                woken.recv(4096)
            except BlockingIOError:
                pass


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
