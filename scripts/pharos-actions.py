#!/usr/bin/env python3
"""Pharos actions: restart, update, and quiet mode, for the host owner only.

Listens on a mode-600 Unix socket ($XDG_RUNTIME_DIR/pharos-actions.sock), not a
TCP port, so only this user and root (tailscaled) can reach it; the host node
serve maps /api to it. Tailscale serve adds the caller's login (Tailscale-User-Login) and removes any copy the
client sent, so only requests from the owner of the host node are accepted.
Actions come from a fixed list derived from config.json and status.json; a
request names one of them and never carries a command. Every action is logged
to pending.jsonl, which the collector turns into events. Standard library only.
"""

import argparse
import datetime as dt
import http.server
import json
import os
import re
import socket
import socketserver
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "pharos")
CONFIG = os.path.join(ROOT, "site", "config.json")
PROTECTED = {"pharos-tailscale"}  # holds the node identity and every svc:* handler; update it by hand
COOLDOWN = 10                # seconds before the same target can run again
QUIET_MAX = 12 * 60          # minutes

lock = threading.Lock()
busy = {}   # target -> "restart" | "update", while running
done = {}   # target -> monotonic time it finished
who = {"at": 0, "login": None, "dns": None}


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def run(cmd, timeout):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode == 0, (p.stderr or p.stdout).strip().splitlines()[-1:] or [""]
    except subprocess.TimeoutExpired:
        return False, ["timed out"]
    except OSError as e:
        return False, [str(e)]


def owner():
    """Login and DNS name of the host node's owner, refreshed every 5 minutes."""
    if time.monotonic() - who["at"] > 300 or not who["login"]:
        try:
            st = json.loads(subprocess.run(["tailscale", "status", "--json"], capture_output=True,
                                           text=True, timeout=8, check=True).stdout)
            me = st["Self"]
            who.update(at=time.monotonic(), login=st["User"][str(me["UserID"])]["LoginName"],
                       dns=me["DNSName"].rstrip("."))
        except (OSError, subprocess.SubprocessError, ValueError, KeyError):
            pass
    return who["login"], who["dns"]


def allowed():
    """What can run now: restart and update targets, from config and the latest status."""
    cfg = load(CONFIG) or {}
    st = load(os.path.join(STATE, "status.json")) or {}
    projects = {g["project"] for g in cfg.get("groups", [])}
    restart = [f"ctr:{c['name']}" for c in st.get("containers") or [] if c.get("project") in projects]
    restart += [f"unit:{u['unit']}" for u in cfg.get("host", []) if u.get("scope") == "user"]
    update = {}
    for u in (st.get("updates") or {}).get("images") or []:
        if u["container"] in PROTECTED or not u.get("files") or not (u.get("latest") or not u.get("applied")):
            continue
        update[f"ctr:{u['container']}"] = u
    return restart, update


def log(key, label, detail):
    """Queue an info event; the collector moves it to events.json on its next cycle."""
    line = json.dumps({"t": now_iso(), "key": key, "label": label, "ok": None, "detail": detail}) + "\n"
    os.makedirs(STATE, exist_ok=True)
    with open(os.path.join(STATE, "pending.jsonl"), "a") as f:
        f.write(line)
    print("action:", label, "·", detail, flush=True)


def wake_collector():
    subprocess.run(["systemctl", "--user", "kill", "--kill-whom=main", "-s", "USR1", "pharos-status"], capture_output=True, timeout=5)


def restart(target, login):
    kind, name = target.split(":", 1)
    cmd = ["docker", "restart", "-t", "10", name] if kind == "ctr" else ["systemctl", "--user", "restart", name]
    ok, out = run(cmd, 90)
    log(target, name, f"restarted by {login}" if ok else f"restart failed: {out[0]}")
    return ok, "restarted" if ok else out[0]


def put(path, text):
    """Replace a file atomically, keeping its mode."""
    with open(path + ".pharos-tmp", "w") as f:
        f.write(text)
    os.chmod(path + ".pharos-tmp", os.stat(path).st_mode & 0o777)
    os.replace(path + ".pharos-tmp", path)


def update(target, u, login):
    """Move the compose pin to the newest tag (if newer), then pull and recreate that one service."""
    files, name, image = u["files"], u["container"], u["image"]
    pin = re.compile(r"^(\s*image:\s*[\"']?)" + re.escape(image) + r"([\"']?\s*(#.*)?)$", re.M)
    try:
        texts = {}
        for f in files:
            with open(f) as fh:
                texts[f] = fh.read()
    except OSError as e:
        log(target, name, f"update failed: {e}")
        return
    # the pin may live in an override file; edit the one file that has it
    hits = [f for f, t in texts.items() for _ in pin.findall(t)]
    path = hits[0] if len(hits) == 1 else files[0]
    before = text = texts[path]
    if u.get("latest"):
        repo = image.rsplit(":", 1)[0]
        if len(hits) != 1:
            log(target, name, f"update skipped: '{image}' is not pinned exactly once in {', '.join(files)}")
            return
        image = f"{repo}:{u['latest']}"
        text = pin.sub(lambda m: m.group(1) + image + m.group(2), before)
        put(path, text)
    compose = ["docker", "compose", "-p", u["project"], *[a for f in files for a in ("-f", f)]]
    ok, out = run(compose + ["pull", u["service"]], 600)
    if ok:
        ok, out = run(compose + ["up", "-d", u["service"]], 300)
    if not ok and text != before:
        put(path, before)  # put the old pin back
    log(target, name, f"updated to {image} by {login}" if ok else f"update to {image} failed: {out[0]}")


def quiet(minutes, login):
    path = os.path.join(STATE, "quiet.json")
    if minutes <= 0:
        try:
            os.remove(path)
        except FileNotFoundError:
            return "alerts already on"
        log("quiet", "Alerts", f"resumed by {login}")
        return "alerts resumed"
    until = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=minutes)).isoformat(timespec="seconds").replace("+00:00", "Z")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"until": until, "by": login}, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    log("quiet", "Alerts", f"paused for {minutes} min by {login}")
    return f"alerts paused for {minutes} min"


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "pharos-actions"

    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def route(self):
        p = self.path.split("?", 1)[0]
        return p[4:] if p.startswith("/api/") else p  # serve may or may not strip the mount path

    def caller(self):
        login, _ = owner()
        user = self.headers.get("Tailscale-User-Login")
        return user, bool(user and login and user == login)

    def do_GET(self):
        if self.route() != "/whoami":
            return self.send(404, {"error": "not found"})
        user, is_owner = self.caller()
        if not is_owner:
            return self.send(200, {"login": user, "owner": False})
        restart_, update_ = allowed()
        with lock:
            running = dict(busy)
        self.send(200, {
            "login": user, "owner": True, "restart": restart_,
            "update": {k: u.get("latest") or "apply" for k, u in update_.items()},
            "busy": running,
        })

    def do_POST(self):
        user, is_owner = self.caller()
        if not is_owner:
            return self.send(403, {"error": "read-only: only the host owner can run actions"})
        # A cross-site page cannot send a JSON body without a CORS preflight, which this never answers.
        _, dns = owner()
        origin = self.headers.get("Origin")
        if (not self.headers.get("Content-Type", "").startswith("application/json")
                or self.headers.get("Sec-Fetch-Site", "same-origin") != "same-origin"
                or (origin and origin != f"https://{dns}")):
            return self.send(403, {"error": "cross-site request"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n)) if 0 < n <= 1024 else {}
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        action, target = self.route(), str(body.get("target") or "")
        user = user.split("@")[0]  # events show the short login, not the full address

        if action == "/quiet":
            minutes = body.get("minutes")
            if type(minutes) is not int or not 0 <= minutes <= QUIET_MAX:
                return self.send(400, {"error": "minutes must be 0 to 720"})
            detail = quiet(minutes, user)
            wake_collector()
            return self.send(200, {"ok": True, "detail": detail})
        if action not in ("/restart", "/update"):
            return self.send(404, {"error": "unknown action"})

        restart_, update_ = allowed()
        if (action == "/restart" and target not in restart_) or (action == "/update" and target not in update_):
            return self.send(403, {"error": "not an allowed target"})
        with lock:
            if target in busy or time.monotonic() - done.get(target, -COOLDOWN) < COOLDOWN:
                return self.send(429, {"error": "already running or just ran"})
            if action == "/update" and "update" in busy.values():
                return self.send(429, {"error": "another update is running"})
            busy[target] = action[1:]

        def finish():
            with lock:
                busy.pop(target, None)
                done[target] = time.monotonic()
            wake_collector()

        if action == "/restart":
            try:
                ok, detail = restart(target, user)
            finally:
                finish()
            return self.send(200 if ok else 500, {"ok": ok, "detail": detail})

        def work():  # pulls can take minutes; answer now, report through events
            try:
                update(target, update_[target], user)
            except Exception as e:  # never fail silently: the page only hears through events
                log(target, update_[target]["container"], f"update failed: {e}")
            finally:
                finish()
        threading.Thread(target=work, daemon=True).start()
        self.send(202, {"ok": True, "detail": "update started"})

    def log_message(self, fmt, *args):
        pass  # actions are logged; requests are not


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--socket", default=os.path.join(os.environ.get("XDG_RUNTIME_DIR") or STATE, "pharos-actions.sock"))
    args = ap.parse_args()
    # remove a socket left by a crash, but never one a running copy still answers on
    probe = socket.socket(socket.AF_UNIX)
    try:
        probe.connect(args.socket)
        sys.exit(f"{args.socket} is in use: pharos-actions is already running")
    except FileNotFoundError:
        pass
    except ConnectionRefusedError:
        os.remove(args.socket)
    finally:
        probe.close()
    mask = os.umask(0o177)  # socket mode 600: a TCP port would trust any local process's login header
    server = Server(args.socket, Handler)
    os.umask(mask)
    print(f"listening on {args.socket}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
