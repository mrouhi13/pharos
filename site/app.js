/* Pharos dashboard. Reads /config.json (hand-edited) and /data/status.json
   (written by scripts/pharos-status.py) and renders both views. */
(() => {
'use strict';

const CONFIG_URL = '/config.json';
const STATUS_URL = '/data/status.json';
const HISTORY_URL = '/data/events.json';
const API = '/api/'; // scripts/pharos-actions.py; only the host owner gets actions
const STALE_AFTER = 3;          // intervals without a new status before data counts as stale
const KEY_WARN_DAYS = 14;

const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const NAME = document.title; // the <title> in index.html
// cached: the service worker served a saved status; fetchErr: 'offline', an HTTP code, or 'invalid'
const S = { cfg: null, st: null, cached: false, fetchErr: null, err: null, view: 'overview', target: null, hist: null, histKey: '', evFilter: 'all', evLimit: 100, open: new Set(), key: '', stale: null, timer: 0, me: null, acting: new Set(), dirty: new Set() };

const I = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/></svg>',
  mon: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  wave: '<svg viewBox="0 0 24 24"><path d="M3 12h3l3-7 6 14 3-7h3"/></svg>',
  flat: '<svg viewBox="0 0 24 24"><path d="M3 12h18"/></svg>',
  ar: '<svg class="ar" viewBox="0 0 24 24"><path d="M7 17L17 7M8 7h9v9"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4M3 3l18 18"/></svg>',
};
const LABEL = { up: 'Online', warn: 'Partial', down: 'Offline', stale: 'Unknown' };
const ACCESS = { token: 'Bearer token', login: 'App login', tailnet: 'Tailnet ACL only' };
const RUNS = { docker: 'Docker', host: 'Host' };

/* ---------- DOM helpers: data only ever goes in as text ---------- */
function h(tag, props, kids) {
  const e = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'icon') e.innerHTML = I[v]; // trusted constants only
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids || []) if (c != null && c !== false) e.append(c);
  return e;
}
function svg(tag, attrs) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs || {}) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  return e;
}
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = I[name]; // trusted constants only
  return t.content.firstChild;
}
const dot = (state) => h('i', { class: 'dot', 'data-state': state });
const cpBtn = (text) => h('button', { class: 'cp', 'data-copy': text, 'aria-label': 'Copy ' + text, title: 'Copy', icon: 'copy' });
// Owner-only action: the first tap arms it, the second within 4s runs it.
const ACTING = { restart: 'Restarting…', update: 'Updating…' };
function actBtn(kind, target, label, warning) {
  const me = S.me;
  const can = me && me.owner && (kind === 'restart' ? (me.restart || []).includes(target) : (me.update || {})[target]);
  if (!can) return null;
  const running = S.acting.has(target) || (me.busy || {})[target];
  return h('button', { class: 'act', 'data-act': kind, 'data-target': target, 'data-warning': warning, disabled: !!running,
    text: running ? ACTING[(me.busy || {})[target] || kind] : label });
}
const dl = (rows) => h('dl', null, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', null, [v])]));

/* ---------- time ---------- */
function ago(sec) {
  if (sec < 60) return Math.max(0, Math.round(sec)) + 's ago';
  if (sec < 3600) return Math.round(sec / 60) + ' min ago';
  if (sec < 86400) return Math.round(sec / 3600) + 'h ago';
  return Math.round(sec / 86400) + 'd ago';
}
const since = (iso) => (Date.now() - Date.parse(iso)) / 1000;
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/* ---------- derived state ---------- */
const interval = () => (S.st && S.st.interval) || 30;
function isStale() {
  return !S.st || S.cached || S.fetchErr != null || since(S.st.generated) > STALE_AFTER * interval();
}
const epStatus = (svc, ep) => (S.st && S.st.endpoints && S.st.endpoints[svc.host + ep.path]) || null;
function epState(svc, ep) {
  const r = epStatus(svc, ep);
  return isStale() || !r ? 'stale' : r.ok ? 'up' : 'down';
}
function svcState(svc) {
  const states = svc.endpoints.map((e) => epState(svc, e));
  if (states.includes('stale')) return 'stale';
  const up = states.filter((s) => s === 'up').length;
  return up === states.length ? 'up' : up === 0 ? 'down' : 'warn';
}
function nodeState(id) {
  const n = S.st && S.st.nodes && S.st.nodes[id];
  return isStale() || !n ? 'stale' : n.online ? 'up' : 'down';
}
function dnsState() {
  const d = S.st && S.st.dns;
  if (isStale() || !d || d.adguard == null) return 'stale';
  return d.adguard ? 'up' : 'warn';
}
function routeState() {
  const r = S.st && S.st.route;
  if (isStale() || !r || r.approved == null) return 'stale';
  return r.approved && r.advertised !== false ? 'up' : r.advertised ? 'warn' : 'down';
}
function deviceStatus(host) {
  return ((S.st && S.st.devices) || []).find((d) => d.host === host) || null;
}
// The collector's verdicts. bad > 0 means the check failed in the latest cycle
// (ok/since are the confirmed state that drives alerts).
function check(key) {
  const c = S.st && S.st.checks && S.st.checks[key];
  return c && c.bad > 0 ? c : null;
}
function failing(prefix) {
  if (isStale()) return [];
  return Object.entries((S.st && S.st.checks) || {})
    .filter(([k, c]) => k.startsWith(prefix) && c.bad > 0)
    .map(([key, c]) => Object.assign({ key }, c));
}
// Red means something is down; host health, ports, backup, and brief unit
// transitions are amber.
function isRed(key, c) {
  if (key === 'route') return c.detail === 'not advertised';
  if (key.startsWith('unit:')) return !/^(activating|reloading)$/.test(c.detail);
  return !/^(port:|disk:|memory|power|backup|dns|svc:|key:)/.test(key);
}
function unitState(u) {
  if (isStale()) return 'stale';
  const c = check('unit:' + u.unit);
  return c ? (isRed('unit:' + u.unit, c) ? 'down' : 'warn') : 'up';
}
function ctrState(c) {
  if (isStale()) return 'stale';
  if (check('ctr:' + c.name)) return 'down'; // stopped, unhealthy, or restart loop
  return c.state === 'running' ? (c.health === 'starting' ? 'warn' : 'up') : 'down';
}
// Short uptime like 43m, 5h, 3d.
function dur(iso) {
  const s = since(iso);
  if (!iso || !(s >= 0)) return '';
  return s < 3600 ? Math.max(1, Math.round(s / 60)) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd';
}
function keyExpiry(iso) {
  if (!iso) return ['Disabled', ''];
  const days = Math.floor((Date.parse(iso) - Date.now()) / 86400000);
  if (days < 0) return ['Expired', 'bad-t'];
  return ['in ' + days + 'd', days < KEY_WARN_DAYS ? 'warn-t' : ''];
}

/* ---------- links: '#tab/id' opens a tab and scrolls to one item ---------- */
const slug = (x) => String(x).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
function linkFor(key) {
  if (key.startsWith('ep:')) {
    const svc = S.cfg.services.find((x) => key.slice(3).startsWith(x.host + '/'));
    return svc ? '#services/svc-' + svc.id : '#services';
  }
  if (key.startsWith('svc:')) return '#services';
  if (key.startsWith('ctr:')) return '#host/ctr-' + slug(key.slice(4));
  if (key.startsWith('unit:')) return '#host/unit-' + slug(key.slice(5));
  if (key.startsWith('node:') || key.startsWith('key:')) return '#network/node-' + slug(key.slice(key.indexOf(':') + 1));
  if (key.startsWith('port:')) return '#network/port-' + slug(key.slice(5));
  if (key === 'route' || key === 'dns') return '#network/route';
  if (key === 'backup') return '#host/backup';
  if (key === 'quiet') return '#events';
  if (/^(disk:|memory|power)/.test(key)) return '#host/health';
  return '#events';
}
// Who listens on a port (matched by number): a container or a host unit.
function ownerOfPort(port) {
  const tail = ':' + port;
  const c = ((S.st && S.st.containers) || []).find((x) => x.ports.some((a) => a.endsWith(tail)));
  if (c) return { name: c.name, href: '#host/ctr-' + slug(c.name) };
  const u = (S.cfg.host || []).find((x) => x.listen && x.listen.endsWith(tail));
  return u ? { name: u.unit, href: '#host/unit-' + slug(u.unit) } : null;
}
// The Service whose backend listens on a port.
const serviceOfPort = (port) => S.cfg.services.find((x) => x.endpoints.some((e) => String(e.port) === String(port)));
const portsOf = (addrs) => (addrs || []).map((a) => a.split(':').pop());
const ln = (href, text) => h('a', { class: 'ln', href, text });
function showTarget() {
  if (!S.target) return;
  const el = document.getElementById(S.target);
  if (!el) return; // not rendered yet; render() tries again
  S.target = null;
  el.scrollIntoView({ block: 'center' });
}

/* ---------- headline ---------- */
function fetchWhy() {
  return (S.fetchErr === 'invalid' ? 'status.json is not valid JSON' : 'status.json returned ' + S.fetchErr) + '; is pharos-status running?';
}
// Everything failing right now, red first.
function problems() {
  return failing('')
    .map((c) => ({ key: c.key, bad: isRed(c.key, c), text: c.label + ' ' + c.detail }))
    .sort((a, b) => b.bad - a.bad);
}
function renderHead() {
  const hl = $('#headline'), det = $('#detail');
  let state, title, parts;
  const stale = isStale();
  if (S.err === 'config') {
    state = 'error'; title = 'No config';
    parts = ['config.json could not be loaded.'];
  } else if (!S.st) {
    state = S.fetchErr ? 'error' : 'loading'; title = S.fetchErr ? 'No data' : 'Checking';
    parts = [S.fetchErr === 'offline' ? 'Host unreachable from this device.' : S.fetchErr ? fetchWhy() + '.' : 'Loading status…'];
  } else if (stale) {
    state = 'stale'; title = 'Stale';
    const why = S.fetchErr === 'offline' || S.cached ? 'host unreachable from this device' + (S.cached ? ' · showing the saved copy' : '')
      : S.fetchErr ? fetchWhy() : 'collector stopped or host asleep';
    parts = ['Last update ', h('b', { text: clock(S.st.generated) }), ' · ' + ago(since(S.st.generated)) + ' · ' + why];
  } else {
    const issues = problems();
    const bad = issues.filter((x) => x.bad).length;
    state = !issues.length ? 'ok' : bad ? 'fault' : 'partial';
    title = !issues.length ? 'All clear' : issues.length + (issues.length > 1 ? ' issues' : ' issue');
    parts = issues.length
      ? [...issues.flatMap((x, i) => [i ? ' · ' : '', h('a', { class: x.bad ? 'bad' : 'warn', href: linkFor(x.key), text: x.text })]), ' · updated ' + ago(since(S.st.generated))]
      : ['Updated ' + ago(since(S.st.generated))];
  }
  const key = state + title;
  hl.textContent = title;
  hl.dataset.state = state;
  if (key !== S.key) { // sweep the sheen once, only when the state changes
    S.key = key;
    hl.classList.remove('sweep'); void hl.offsetWidth; hl.classList.add('sweep');
  }
  const q = S.st && S.st.quiet;
  if (q && Date.parse(q.until) > Date.now()) parts.push(h('span', { class: 'warn-t', text: ' · alerts paused until ' + clock(q.until) }));
  det.replaceChildren(...parts);
  syncQuiet();
  document.title = state === 'fault' || state === 'partial' ? '(' + parseInt(title, 10) + ') ' + NAME : NAME;
}
$('#headline').addEventListener('animationend', (e) => e.target.classList.remove('sweep'));

/* ---------- services ---------- */
function spark(svc) {
  const N = 60, W = 120, H = 22, bw = W / N;
  const hist = svc.endpoints.map((e) => ((epStatus(svc, e) || {}).history) || []);
  const main = hist[0];
  const max = Math.max(80, ...main.map((x) => x.ms));
  const el = svg('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const off = N - main.length;
  for (let i = 0; i < N; i++) {
    const j = i - off;
    let ht = 1.5, cls = null;
    if (j >= 0) {
      // a sample fails if any endpoint of the service failed in that cycle
      const ok = hist.every((hh) => { const x = hh[hh.length - main.length + j]; return !x || x.ok; });
      ht = ok ? Math.max(2, (main[j].ms / max) * H) : H;
      cls = ok ? 'ok' : 'bad';
    }
    el.append(svg('rect', { x: (i * bw).toFixed(2), y: (H - ht).toFixed(2), width: (bw * 0.6).toFixed(2), height: ht.toFixed(2), class: cls }));
  }
  return el;
}

function uptime(svc) {
  const main = ((epStatus(svc, svc.endpoints[0]) || {}).history) || [];
  if (!main.length) return null;
  const ok = main.filter((x) => x.ok).length;
  const mins = Math.max(1, Math.round((main.length * interval()) / 60));
  return Math.round((ok / main.length) * 100) + '% · last ' + mins + ' min';
}

function details(svc) {
  const serve = S.st && S.st.serve;
  const eps = svc.endpoints.map((ep) => {
    const r = epStatus(svc, ep), state = epState(svc, ep);
    const url = 'https://' + svc.host + ep.path;
    const meta = r && state !== 'stale' ? (r.code || r.error || '—') + (r.code ? ' · ' + r.ms + ' ms' : '') : '—';
    const missing = serve && !(serve[svc.service] || {})[ep.path];
    return h('li', { class: 'ep' }, [
      dot(state),
      h('a', { class: 'ep-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, [h('span', { text: ep.path }), icon('ar')]),
      h('span', { class: 'ep-meta' }, [h('span', { text: meta }), cpBtn(url)]),
      h('span', { class: 'ep-sub' + (missing ? ' warn-t' : '') }, [
        (() => { const o = ownerOfPort(ep.port); return o ? ln(o.href, o.name) : 'nothing listening'; })(),
        ' · 127.0.0.1:' + ep.port + (missing ? ' · missing from live serve config' : ''),
      ]),
    ]);
  });
  const up = uptime(svc);
  return h('div', { class: 'det' }, [
    dl([
      ['Runs on', RUNS[svc.runsOn] || svc.runsOn],
      ['Via', svc.service + ' · :443'],
      ['Access', ACCESS[svc.access] || svc.access],
      up && ['Uptime', up],
      svc.internals && ['Workers', svc.internals.join(' · ')],
    ]),
    h('ul', { class: 'eps', 'aria-label': 'Endpoints' }, eps),
    svc.note && h('p', { class: 'note' + (svc.risk === 'write' ? ' warn' : ''), text: svc.note }),
  ]);
}

function tile(svc) {
  const state = svcState(svc), r = epStatus(svc, svc.endpoints[0]);
  const open = S.open.has(svc.id), id = 'more-' + svc.id;
  return h('article', { class: 'tile' + (open ? ' open' : ''), id: 'svc-' + svc.id, 'data-state': state, 'data-id': svc.id }, [
    h('div', { class: 't-top' }, [
      h('span', { class: 'st' }, [dot(state), LABEL[state]]),
      svc.risk === 'write' && h('span', { class: 'tag warn', text: 'Write access' }),
      r && state !== 'stale' && r.code && h('span', { class: 'ms', text: r.ms + ' ms' }),
    ]),
    h('h3', null, [h('a', { class: 'name', href: 'https://' + svc.host + '/', target: '_blank', rel: 'noopener noreferrer' }, [svc.name, icon('ar')])]),
    h('p', { class: 'desc', text: svc.description }),
    spark(svc),
    h('div', { class: 't-foot' }, [
      h('span', { class: 'host' }, [h('span', { text: svc.host }), cpBtn(svc.host)]),
      h('button', { class: 'info', 'data-info': svc.id, 'aria-expanded': String(open), 'aria-controls': id, 'aria-label': 'Details for ' + svc.name, title: 'Details', icon: 'chev' }),
    ]),
    h('div', { class: 'more', id }, [h('div', null, [details(svc)])]),
  ]);
}

function renderTiles() {
  const box = $('#tiles');
  if (S.err === 'config') {
    box.replaceChildren(h('div', { class: 'empty' }, [h('b', { text: 'No configuration' }), 'Check that site/config.json exists and is valid JSON.']));
  } else if (!S.cfg) {
    box.replaceChildren(...Array.from({ length: 4 }, () => h('div', { class: 'tile skel', 'aria-hidden': 'true' })));
  } else {
    box.replaceChildren(...S.cfg.services.map(tile));
  }
}

/* Everything running: host units and every container, grouped by Compose project. */
function invRow(state, id, name, meta, right, ports, portNums, act) {
  const svc = (portNums || []).map(serviceOfPort).find(Boolean);
  return h('li', { class: 'r', id }, [
    dot(state),
    h('span', { class: 'r-name', text: name }),
    h('span', { class: 'r-right' }, [right, act]),
    h('span', { class: 'r-sub' }, [[meta, ports].filter(Boolean).join(' · '), svc && ' · serves ', svc && ln('#services/svc-' + svc.id, svc.name)]),
  ]);
}
function group(title, sub, rows, id) {
  const up = rows.filter((r) => r.state === 'up').length;
  return h('article', { class: 'panel group', id, 'data-state': worst(rows.map((r) => r.state)) }, [
    h('div', { class: 'p-head' }, [h('h3', { text: title }), h('span', { class: 'label', text: sub }), h('span', { class: 'count', text: up + '/' + rows.length })]),
    h('ul', { class: 'rows' }, rows.map((r) => r.el)),
  ]);
}
const home = (dir) => (dir || '').replace(/^\/home\/[^/]+/, '~');
/* Host health: disk, memory, load, power as small meters. */
const gb = (b) => (b / 1e9 >= 100 ? Math.round(b / 1e9) : (b / 1e9).toFixed(1)) + ' GB';
function meter(label, value, sub, pct, ok, id) {
  const state = isStale() ? 'stale' : ok ? 'up' : 'warn';
  return h('div', { class: 'meter', id, 'data-state': state }, [
    h('span', { class: 'label', text: label }),
    h('b', { text: value }),
    h('span', { class: 'm-sub', text: sub }),
    pct != null && h('i', { class: 'bar' }, [h('i', { style: 'width:' + Math.min(100, Math.max(2, pct)) + '%' })]),
  ]);
}
function healthPanel() {
  const hw = S.st.health;
  if (!hw) return null;
  const ok = (k) => !check(k);
  const out = hw.disks.map((d) => {
    const pct = Math.round((d.used * 100) / d.total);
    return meter('Disk ' + d.path, pct + '%', gb(d.total - d.used) + ' free of ' + gb(d.total), pct, ok('disk:' + d.path));
  });
  if (hw.memory) {
    const used = hw.memory.total - hw.memory.available, pct = Math.round((used * 100) / hw.memory.total);
    out.push(meter('Memory', pct + '%', gb(hw.memory.available) + ' available of ' + gb(hw.memory.total), pct, ok('memory')));
  }
  const l = hw.load[0];
  out.push(meter('Load', l.toFixed(2), '5m ' + hw.load[1].toFixed(2) + ' · 15m ' + hw.load[2].toFixed(2) + ' · ' + hw.cpus + ' CPUs', (l * 100) / hw.cpus, l < hw.cpus));
  const p = hw.power;
  if (p) out.push(meter('Power', p.ac ? 'AC' : 'Battery', (p.battery != null ? p.battery + '% · ' : '') + (p.status || '').toLowerCase(), p.battery, ok('power')));
  return h('article', { class: 'panel meters', id: 'health', 'data-state': worst(out.map((m) => m.dataset.state)) }, out);
}

/* Event times: 14:02 today, Mon 14:02 earlier. */
function when(iso) {
  const d = new Date(iso), today = new Date().toDateString() === d.toDateString();
  return (today ? '' : d.toLocaleDateString([], { weekday: 'short' }) + ' ') + clock(iso);
}
/* ---------- host tab: health, backup, everything running ---------- */
function backupMeter() {
  const b = S.st.backup;
  if (!b) return null;
  const ok = !check('backup');
  const sub = !b.last ? 'run scripts/backup-state.sh'
    : b.verified === false ? 'unreadable: ' + b.error
    : b.count + ' kept · ' + Math.round(b.size / 1024) + ' KB · ' + (b.verified ? b.files + ' files checked' : 'weekly');
  return meter('Backup', b.last ? dur(b.last) + ' ago' : 'None', sub, null, ok, 'backup');
}

// Host services: systemd units from config.host, split by scope.
function unitGroups() {
  const units = new Map((S.st.host || []).map((u) => [u.unit, u]));
  const scopes = [['system', 'System', 'systemd'], ['user', 'User', 'systemd --user']];
  return scopes.map(([scope, title, sub]) => {
    const rows = (S.cfg.host || []).filter((c) => c.scope === scope).map((c) => {
      const u = units.get(c.unit) || { state: 'unknown' }, state = unitState(u);
      const right = state === 'up' ? dur(u.since) : u.state;
      const act = actBtn('restart', 'unit:' + c.unit, 'Restart');
      return { state, el: invRow(state, 'unit-' + slug(c.unit), c.unit, c.note, right, c.listen, c.listen && portsOf([c.listen]), act) };
    });
    return rows.length && group(title, sub, rows);
  }).filter(Boolean);
}
// Docker: every container, grouped by Compose project in config.groups order.
function containerGroups() {
  const projects = new Map();
  for (const c of S.st.containers || []) {
    const key = c.project || c.name;
    if (!projects.has(key)) projects.set(key, []);
    projects.get(key).push(c);
  }
  const order = (S.cfg.groups || []).map((g) => g.project);
  const rank = (p) => (order.includes(p) ? order.indexOf(p) : order.length);
  const names = Object.fromEntries((S.cfg.groups || []).map((g) => [g.project, g.name]));
  return [...projects].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([key, list]) => {
    const dir = home(list[0].dir);
    const rows = list.map((c) => {
      const state = ctrState(c);
      const right = c.state === 'running' ? (c.health ? c.health + ' · ' : '') + dur(c.since) : c.state + (c.exitCode ? ' (' + c.exitCode + ')' : '');
      const ports = c.network === 'host' ? 'host network' : c.ports.join(', ');
      const restarts = c.restarts ? c.restarts + ' restart' + (c.restarts > 1 ? 's' : '') : null;
      const act = actBtn('restart', 'ctr:' + c.name, 'Restart', c.name === 'pharos-tailscale' ? 'Drops every Service' : null);
      return { state, el: invRow(state, 'ctr-' + slug(c.name), c.name, [c.image, restarts].filter(Boolean).join(' · '), right, ports, portsOf(c.ports), act) };
    });
    return group(names[key] || (dir ? dir.split('/').pop() : key), dir || 'docker', rows);
  });
}
// Updates: pinned images (newer tags checked daily, pins not running yet) and
// system packages (checked hourly; official repos can be updated from here).
const pkgList = (list) => list.slice(0, 4).map((x) => x.name + ' ' + x.from + ' → ' + x.to).join(', ') + (list.length > 4 ? ' and ' + (list.length - 4) + ' more' : '');
// an image needs action: a newer tag exists, or its compose pin is not running yet
const imgPending = (x) => x.latest || !x.applied;
function updateCount() {
  const u = S.st && S.st.updates, p = S.st && S.st.packages;
  return (u ? u.images.filter(imgPending).length : 0)
    + (p && p.repo && p.repo.length ? 1 : 0) + (p && p.aur && p.aur.length ? 1 : 0) + (p && p.reboot ? 1 : 0);
}
function imageCard() {
  const u = S.st.updates, stale = isStale();
  if (!u || !u.images.length) return null;
  const tag = (img) => img.split(':').pop();
  const rows = u.images.map((x) => {
    const state = stale ? 'stale' : imgPending(x) ? 'warn' : 'up';
    const right = x.latest ? tag(x.latest) + ' available' : x.applied ? 'current' : 'pin not applied';
    const meta = x.applied ? x.image : 'compose pins ' + tag(x.image) + ', runs ' + tag(x.running);
    const act = actBtn('update', 'ctr:' + x.container, x.latest ? 'Update' : 'Apply');
    const note = x.container === 'pharos-tailscale' && imgPending(x) ? 'update by hand (node identity)' : null;
    return { state, el: invRow(state, 'upd-' + slug(x.container), x.container, [meta, note].filter(Boolean).join(' · '), right, null, null, act) };
  });
  return group('Images', 'pinned · checked daily', rows, 'updates');
}
function packageCard() {
  const p = S.st.packages, stale = isStale();
  if (!p) return null;
  const st = (bad) => (stale ? 'stale' : bad ? 'warn' : 'up');
  const row = (state, id, name, meta, right, act) => ({ state, el: invRow(state, id, name, meta, right, null, null, act) });
  const rows = [];
  if (p.repo) {
    const n = p.repo.length;
    rows.push(row(st(n), 'pkg-repo', 'Official', n ? pkgList(p.repo) + ' · update with omarchy update' : 'pacman', n ? n + ' pending' : 'current'));
  }
  if (p.aur) {
    const n = p.aur.length;
    rows.push(row(st(n), 'pkg-aur', 'AUR', n ? pkgList(p.aur) + ' · update with yay' : 'yay', n ? n + ' pending' : 'current'));
  }
  if (p.reboot) rows.push(row(st(true), 'pkg-reboot', 'Reboot needed', 'running kernel ' + p.kernel + ' is no longer installed', 'kernel'));
  if (!rows.length) return null;
  return group('System', p.checked ? 'packages · checked ' + ago(since(p.checked)) : 'packages · checking…', rows, 'packages');
}
function renderHost() {
  const box = $('#host-body');
  if (!S.cfg || !S.st || !S.st.containers) { box.replaceChildren(); return; }
  const boot = S.st.health && S.st.health.boot;
  const health = healthPanel();
  const b = backupMeter();
  if (health && b) { health.append(b); health.dataset.state = worst([...health.children].map((m) => m.dataset.state)); }
  const units = (S.st.host || []).length, ctrs = S.st.containers.length;
  const projects = new Set(S.st.containers.map((c) => c.project || c.name)).size;
  box.replaceChildren(...[
    h('div', { class: 'sec first' }, [h('h2', { text: 'Health' }), h('span', { text: boot ? 'up ' + dur(boot) + ' since boot' : '' })]),
    health && h('div', { class: 'lift' }, [health]),
    h('div', { class: 'sec' }, [h('h2', { text: 'Host services' }), h('span', { text: units + ' units' })]),
    h('div', { class: 'groups' }, unitGroups()),
    h('div', { class: 'sec' }, [h('h2', { text: 'Docker' }), h('span', { text: ctrs + ' containers · ' + projects + ' projects' })]),
    h('div', { class: 'groups' }, containerGroups()),
    (S.st.updates || S.st.packages) && h('div', { class: 'sec' }, [h('h2', { text: 'Updates' }), h('span', { text: updateCount() ? updateCount() + ' pending' : 'all current' })]),
    h('div', { class: 'groups' }, [packageCard(), imageCard()].filter(Boolean)),
  ].filter(Boolean));
}

/* ---------- network tab extra: exposed ports ---------- */
function renderPorts() {
  const box = $('#ports');
  if (!S.st || !S.st.exposure) { box.replaceChildren(); return; }
  const rows = S.st.exposure.map((e) => {
    const o = ownerOfPort(e.port);
    return h('li', { class: 'r', id: 'port-' + slug(e.port + '/' + e.proto) }, [
      dot(isStale() ? 'stale' : e.expected ? 'up' : 'warn'),
      h('span', { class: 'r-name', text: e.port + '/' + e.proto }),
      h('span', { class: 'r-right', text: e.scopes.join(', ') }),
      h('span', { class: 'r-sub' + (e.expected ? '' : ' warn-t') }, [e.note || 'Unexpected', o && ' · ', o && ln(o.href, o.name)]),
    ]);
  });
  box.replaceChildren(
    h('div', { class: 'sec' }, [h('h2', { text: 'Exposed ports' }), h('span', { text: 'Beyond loopback' })]),
    h('div', { class: 'lift' }, [h('article', { class: 'panel', 'data-state': isStale() ? 'stale' : S.st.exposure.some((e) => !e.expected) ? 'warn' : 'up' }, [h('ul', { class: 'rows ports' }, rows)])]),
  );
}

/* ---------- events tab: problem + recovery pairs as incidents ---------- */
const AREAS = {
  services: /^(ep:|svc:)/,
  host: /^(ctr:|unit:|disk:|memory|power|backup|packages)/,
  network: /^(node:|route|port:|dns)/,
};
function incidents(events) {
  const open = new Map(), out = [];
  for (const e of events) { // oldest first
    if (e.ok == null) out.push({ key: e.key, label: e.label, detail: e.detail, start: e.t, info: true });
    else if (!e.ok) { const inc = { key: e.key, label: e.label, detail: e.detail, more: e.more, start: e.t, end: null }; open.set(e.key, inc); out.push(inc); }
    else if (open.has(e.key)) { open.get(e.key).end = e.t; open.delete(e.key); }
    else out.push({ key: e.key, label: e.label, detail: e.detail, start: null, end: e.t }); // its start is older than the history
  }
  return out.sort((a, b) => Date.parse(b.start || b.end) - Date.parse(a.start || a.end));
}
function span(sec) {
  if (sec < 60) return Math.max(1, Math.round(sec)) + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.round((sec % 3600) / 60) + 'm';
  return Math.round(sec / 86400) + 'd';
}
function dayLabel(iso) {
  const d = new Date(iso), today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}
function incidentRow(x) {
  const ongoing = !x.info && !x.end && x.start;
  const state = x.info ? 'stale' : ongoing ? (isRed(x.key, x) ? 'down' : 'warn') : 'up';
  const right = x.info ? clock(x.start)
    : ongoing ? 'since ' + clock(x.start) + ' · ' + span(since(x.start))
    : x.start ? clock(x.start) + '–' + clock(x.end) + ' · ' + span((Date.parse(x.end) - Date.parse(x.start)) / 1000)
    : 'recovered ' + clock(x.end);
  return h('li', { class: 'r' }, [
    dot(state),
    x.info && linkFor(x.key) === '#events' ? h('span', { class: 'r-name', text: x.label }) : h('a', { class: 'r-name ln', href: linkFor(x.key), text: x.label }),
    h('span', { class: 'r-right', text: right }),
    h('span', { class: 'r-sub', text: x.detail + (x.info ? '' : ongoing ? ' · ongoing' : ' · recovered') }),
    x.more && h('details', { class: 'r-more', 'data-ev': x.key + '@' + x.start, open: S.open.has(x.key + '@' + x.start) }, [
      h('summary', { text: 'Why' }), h('pre', { text: x.more.join('\n') })]),
  ]);
}
function renderEvents() {
  syncMotion();
  const box = $('#events-body');
  const events = S.hist || (S.st && S.st.events);
  if (!events) { box.replaceChildren(); return; }
  const all = incidents(events);
  const filters = {
    all: () => true,
    open: (x) => !x.info && !x.end && x.start,
    services: (x) => AREAS.services.test(x.key),
    host: (x) => AREAS.host.test(x.key),
    network: (x) => AREAS.network.test(x.key),
  };
  const list = all.filter(filters[S.evFilter]);
  const shown = list.slice(0, S.evLimit);
  const days = [];
  for (const x of shown) {
    const d = dayLabel(x.start || x.end);
    if (!days.length || days[days.length - 1].day !== d) days.push({ day: d, rows: [] });
    days[days.length - 1].rows.push(incidentRow(x));
  }
  box.replaceChildren(...[
    h('div', { class: 'sec first' }, [h('h2', { text: 'Events' }), h('span', { text: 'Last 30 days' })]),
    h('nav', { class: 'launch', 'aria-label': 'Filter events' }, Object.keys(filters).map((f) =>
      h('button', { class: 'chip', 'data-ev-filter': f, 'aria-pressed': String(S.evFilter === f) }, [f[0].toUpperCase() + f.slice(1), h('span', { class: 'dim-t', text: String(all.filter(filters[f]).length) })]))),
    h('div', { class: 'lift' }, [shown.length
      ? h('article', { class: 'panel' }, days.flatMap((d) => [h('h3', { class: 'day', text: d.day }), h('ul', { class: 'rows' }, d.rows)]))
      : h('article', { class: 'panel' }, [h('p', { class: 'note', text: S.evFilter === 'all' ? 'No changes yet.' : 'Nothing here.' })])]),
    list.length > shown.length && h('button', { class: 'chip more', 'data-ev-more': '1', text: 'Show ' + Math.min(100, list.length - shown.length) + ' more' }),
  ].filter(Boolean));
}

/* ---------- overview tab: one cell per area, no details ---------- */
function worst(states) {
  if (!states.length || states.includes('stale')) return 'stale';
  return states.includes('down') ? 'down' : states.includes('warn') ? 'warn' : 'up';
}
function cell(href, state, label, value, sub) {
  return h('a', { class: 'cell', href, 'data-state': state }, [
    h('span', { class: 'c-top' }, [dot(state), h('span', { class: 'label', text: label }), icon('ar')]),
    h('b', { text: value }),
    h('span', { class: 'c-sub', text: sub }),
  ]);
}
function renderOverview() {
  const box = $('#ov');
  if (!S.cfg) { box.replaceChildren(); return; }
  const svcs = S.cfg.services, sst = svcs.map(svcState);
  if (!S.st) { box.replaceChildren(); return; }
  const st = S.st, stale = isStale();
  const names = (list) => list.slice(0, 3).join(', ') + (list.length > 3 ? '…' : '');
  const count = (states) => states.filter((x) => x === 'up').length + '/' + states.length;

  const svcDown = svcs.filter((_, i) => sst[i] !== 'up').map((x) => x.name);
  const ctrs = st.containers || [], units = st.host || [];
  const run = ctrs.map(ctrState).concat(units.map(unitState));
  const runDown = ctrs.map((c) => c.name).concat(units.map((u) => u.unit)).filter((_, i) => run[i] !== 'up');
  const nst = S.cfg.nodes.map((n) => nodeState(n.id));
  const r = routeState();
  const online = (st.devices || []).filter((d) => d.online).length;
  const ports = failing('port:').length, keys = failing('key:');
  const hw = st.health || {}, disk = (hw.disks || [])[0], mem = hw.memory, pw = hw.power;
  const hwBad = ['disk:', 'memory', 'power', 'backup'].flatMap(failing).map((c) => c.label);
  const b = st.backup;
  const hwSub = [
    disk && 'disk ' + Math.round((disk.used * 100) / disk.total) + '%',
    mem && 'mem ' + Math.round(((mem.total - mem.available) * 100) / mem.total) + '%',
    pw && (pw.ac ? 'AC' : 'battery') + (pw.battery != null ? ' ' + pw.battery + '%' : ''),
    'backup ' + (b && b.last ? dur(b.last) + ' ago' : 'none'),
  ].filter(Boolean).join(' · ');
  const problem = (st.events || []).filter((e) => e.ok === false).slice(-1)[0];
  const ongoing = problem && check(problem.key);
  const orStale = (state) => (stale ? 'stale' : state);
  const ups = updateCount();
  const pendingImages = ((st.updates && st.updates.images) || []).filter(imgPending).length;
  const pk = st.packages || {}, repo = (pk.repo || []).length, aur = (pk.aur || []).length;
  const plural = (n, word) => n + ' ' + word + (n > 1 ? 's' : '');
  const q = st.quiet && Date.parse(st.quiet.until) > Date.now() ? st.quiet : null;
  const dns = dnsState();
  const netSub = ['route ' + (r === 'up' ? 'ok' : r === 'stale' ? 'unknown' : 'off'),
    'DNS ' + (dns === 'up' ? 'AdGuard' : dns === 'stale' ? 'unknown' : 'not AdGuard'),
    ports ? ports + ' unexpected port' + (ports > 1 ? 's' : '') : null,
    keys.length ? keys.map((c) => c.label).join(', ') + ' expiring' : null,
    online + ' devices'].filter(Boolean).join(' · ');

  box.replaceChildren(h('div', { class: 'cells' }, [
    cell('#services', worst(sst), 'Services', count(sst), svcDown.length ? names(svcDown) + ' failing' : 'all responding'),
    cell('#host', worst(run), 'Running', count(run), runDown.length ? names(runDown) + ' down' : ctrs.length + ' containers · ' + units.length + ' units'),
    cell('#host/health', orStale(hwBad.length ? 'warn' : 'up'), 'Health', hwBad.length ? 'Check' : 'Healthy', hwBad.length ? names(hwBad) + ' need a look' : hwSub),
    cell('#network', worst(nst.concat(r, dns, ports || keys.length ? 'warn' : 'up')), 'Network', count(nst) + ' nodes', netSub),
    // amber like the pending rows on the Host tab; pending is not a failure, so the headline ignores it
    cell(pendingImages ? '#host/updates' : '#host/packages', orStale(ups ? 'warn' : 'up'), 'Updates', ups ? ups + ' pending' : 'All current',
      ups ? [pendingImages && plural(pendingImages, 'image'), repo && 'system ' + plural(repo, 'package'), aur && 'AUR ' + plural(aur, 'package'), pk.reboot && 'reboot needed'].filter(Boolean).join(' · ') : 'images and packages'),
    cell('#events', problem ? (ongoing ? (isRed(problem.key, ongoing) ? 'down' : 'warn') : 'up') : 'up', 'Last problem',
      problem ? when(problem.t) : 'None', problem ? problem.label + ' · ' + (ongoing ? 'ongoing' : 'resolved') : 'nothing has failed in this window'),
    q && cell('#events', 'warn', 'Alerts paused', 'until ' + clock(q.until), 'by ' + q.by + ' · tap the bell to resume'),
  ].filter(Boolean)));
}

/* ---------- system ---------- */
function panel(state, title, label, body, id) {
  return h('article', { class: 'panel', id, 'data-state': state }, [
    h('div', { class: 'p-head' }, [dot(state), h('h3', { text: title }), label && h('span', { class: 'label', text: label })]),
    ...body,
  ]);
}

function renderPanels() {
  const out = [];
  for (const n of S.cfg.nodes) {
    const st = (S.st && S.st.nodes && S.st.nodes[n.id]) || {};
    const [exp, expCls] = keyExpiry(st.keyExpiry);
    out.push(panel(nodeState(n.id), st.name || n.name || n.id, n.role, [dl([
      ['IP', st.ip || '—'],
      ['Version', st.version || '—'],
      ['Key expiry', st.online == null ? '—' : h('span', { class: expCls, text: exp })],
    ])], 'node-' + slug(n.id)));
  }
  const r = (S.st && S.st.route) || {};
  const yn = (v) => (v == null ? '—' : h('span', { class: v ? 'ok-t' : 'bad-t', text: v ? 'Yes' : 'No' }));
  const dns = (S.st && S.st.dns) || {};
  const dnsText = dns.resolvers ? (dns.adguard ? 'AdGuard · ' : 'Not AdGuard · ') + (dns.resolvers.join(', ') || 'none') : '—';
  out.push(panel(worst([routeState(), dnsState()]), 'LAN and DNS', null, [
    dl([
      ['CIDR', r.lan || 'none advertised'],
      ['Advertised', yn(r.advertised)],
      ['Approved', yn(r.approved)],
      ['Tailnet DNS', dns.resolvers ? h('span', { class: dns.adguard ? 'ok-t' : 'warn-t', text: dnsText }) : '—'],
      ['Gateway', r.gateway ? h('a', { class: 'ep-link', href: 'http://' + r.gateway, target: '_blank', rel: 'noopener noreferrer' }, [h('span', { text: r.gateway }), icon('ar')]) : '—'],
    ]),
    h('p', { class: 'note', text: 'Host sleep stops the route and tailnet DNS.' }),
  ], 'route'));
  $('#panels').replaceChildren(...out);
}

/* Devices: tailnet peers (from tailscaled) and LAN hosts (from the neighbour table). */
const bytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round((n || 0) / 1e3) + ' KB');
const day = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
function renderDevices() {
  const box = $('#devices-body');
  if (!S.cfg) { box.replaceChildren(); return; }
  const stale = isStale() || !S.st;
  const live = (S.st && S.st.devices) || [];
  const lan = (S.st && S.st.lan) || [];
  const expected = S.cfg.devices.map((d) => deviceStatus(d.host) || { host: d.host, name: d.name, online: null });
  const all = expected.concat(live.filter((d) => !S.cfg.devices.some((x) => x.host === d.host)));
  const lanOf = (d) => d.path === 'direct' && lan.find((l) => l.ip === d.via.split(':')[0]);
  const tail = all.map((d) => {
    const state = stale || d.online == null ? 'stale' : d.online ? 'up' : 'down';
    const right = state === 'stale' ? 'unknown' : !d.online ? (d.lastSeen ? 'seen ' + ago(since(d.lastSeen)) : 'offline')
      : d.path === 'direct' ? 'direct' : d.path === 'relay' ? d.via : 'idle';
    const [exp, expCls] = keyExpiry(d.keyExpiry);
    const l = lanOf(d);
    const sub = h('span', null, [
      [d.os, (d.ips || [])[0], d.dns].filter(Boolean).join(' · '),
      d.rx != null && ' · ↓' + bytes(d.rx) + ' ↑' + bytes(d.tx),
      d.handshake && ' · handshake ' + ago(since(d.handshake)),
      d.created && ' · added ' + day(d.created),
      d.keyExpiry !== undefined && h('span', { class: expCls }, [' · key ' + (exp === 'Disabled' ? 'never expires' : 'expires ' + exp)]),
      d.exitNode && ' · exit node',
      l && ' · on LAN as ', l && ln('#network/lan-' + slug(l.mac), l.ip),
    ]);
    return { state, el: h('li', { class: 'r', id: 'dev-' + slug(d.host) }, [dot(state), h('span', { class: 'r-name', text: d.name }),
      h('span', { class: 'r-right' + (d.path === 'relay' && !stale ? ' warn-t' : ''), text: right }), h('span', { class: 'r-sub' }, [sub])]) };
  });
  const cards = [group('Tailnet', 'Tailscale devices', tail, 'devices')];
  if (S.st && S.st.lan) {
    const rows = lan.map((d) => {
      const state = stale ? 'stale' : d.online ? 'up' : 'stale'; // gone quiet is not a fault
      const name = d.name || d.host || d.tailnet || d.ip;
      const t = d.tailnet && all.find((x) => x.name === d.tailnet);
      const sub = h('span', null, [[name !== d.ip && d.ip, d.mac, d.name && d.host && d.host !== d.name.toLowerCase() && d.host].filter(Boolean).join(' · '),
        t && ' · tailnet ', t && ln('#network/dev-' + slug(t.host), t.name)]);
      return { state, el: h('li', { class: 'r', id: 'lan-' + slug(d.mac) }, [dot(state), h('span', { class: 'r-name', text: name }),
        h('span', { class: 'r-right', text: d.online ? 'online' : 'seen ' + ago(since(d.seen)) }), h('span', { class: 'r-sub' }, [sub])]) };
    });
    cards.push(group('LAN', (S.st.route && S.st.route.lan) + ' · neighbour table', rows, 'lan'));
  }
  box.replaceChildren(
    h('div', { class: 'sec' }, [h('h2', { text: 'Devices' }), h('span', { text: 'tailnet and LAN' })]),
    h('div', { class: 'groups' }, cards),
  );
}

let topoEls = {};
function boxInfo(b) {
  if (b.endpoint) {
    const [sid, path] = b.endpoint.split(' ');
    const svc = S.cfg.services.find((s) => s.id === sid);
    const ep = svc && svc.endpoints.find((e) => e.path === path);
    if (!ep) return { title: b.endpoint, sub: ['unknown endpoint'], state: 'stale' };
    const where = svc.service + (path === '/' ? '' : ' ' + path);
    const owner = (ownerOfPort(ep.port) || {}).name || 'port ' + ep.port;
    return { title: owner, sub: [':' + ep.port, where, ...(b.sub || [])], state: epState(svc, ep) };
  }
  let state = null, title = b.title;
  if (b.device) {
    const d = deviceStatus(b.device), c = S.cfg.devices.find((x) => x.host === b.device);
    title = title || (c ? c.name : b.device);
    state = isStale() || !d ? 'stale' : d.online ? 'up' : 'down';
  } else if (b.node) state = nodeState(b.node);
  else if (b.svc) state = svcState(S.cfg.services.find((s) => s.id === b.svc) || { endpoints: [] });
  else if (b.route) { state = routeState(); const lan = S.st && S.st.route && S.st.route.lan; if (lan) return { title, sub: [lan, ...(b.sub || [])], state }; }
  else if (b.self) state = 'up'; // this page loaded, so nginx answered
  return { title, sub: b.sub || [], state };
}

function boxLink(b) {
  if (b.endpoint) { const svc = S.cfg.services.find((x) => x.id === b.endpoint.split(' ')[0]); return svc && '#services/svc-' + svc.id; }
  if (b.svc) return '#services/svc-' + b.svc;
  if (b.node) return '#network/node-' + slug(b.node);
  if (b.device) return '#network/dev-' + slug(b.device);
  if (b.route) return '#network/route';
  if (b.self) { const o = ownerOfPort(8080); return o && o.href; }
  return null;
}
function renderTopo() {
  const t = S.cfg.topology;
  topoEls = {};
  const tiers = t.tiers.map((tier) => h('div', { class: 'tier' }, [
    h('span', { class: 'tier-label', text: tier.label }),
    ...tier.boxes.map((b) => {
      const info = boxInfo(b);
      const href = boxLink(b);
      const el = h(href ? 'a' : 'div', { class: 'box' + (b.ghost ? ' ghost' : ''), href, 'data-state': info.state, style: 'flex-grow:' + (b.span || 1) }, [
        h('b', { text: info.title }),
        ...info.sub.map((x) => h('span', { text: x })),
        info.state && dot(info.state),
      ]);
      topoEls[b.id] = el;
      return el;
    }),
  ]));
  $('#topo').replaceChildren(svg('svg', { class: 'wires', 'aria-hidden': 'true' }), ...tiers);
  drawWires();
}

function drawWires() {
  const topo = $('#topo'), w = topo.querySelector('.wires');
  if (!w || !S.cfg) return;
  const base = topo.getBoundingClientRect();
  if (!base.width || getComputedStyle(w).display === 'none') return; // hidden view or stacked layout
  const R = (id) => {
    const el = topoEls[id]; if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
  };
  const marker = svg('marker', { id: 'ah', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto' });
  marker.append(svg('path', { d: 'M0 0L8 4L0 8z', class: 'ah' }));
  const defs = svg('defs'); defs.append(marker);
  const kids = [defs];
  for (const [a, b, label] of S.cfg.topology.edges) {
    const A = R(a), B = R(b);
    if (!A || !B) continue;
    const blocked = label === 'blocked';
    let ax = A.x + A.w / 2, bx = B.x + B.w / 2;
    // drop straight down when one box sits over the other's centre
    if (bx > A.x + 8 && bx < A.x + A.w - 8) ax = bx;
    else if (ax > B.x + 8 && ax < B.x + B.w - 8) bx = ax;
    else ax = Math.min(Math.max(bx, A.x + 24), A.x + A.w - 24);
    const ay = A.y + A.h, by = B.y - (blocked ? 0 : 2), mid = (ay + by) / 2;
    const d = ax === bx ? `M${ax} ${ay}V${by}` : `M${ax} ${ay}V${mid}H${bx}V${by}`;
    kids.push(svg('path', { d, class: blocked ? 'x' : null, 'marker-end': blocked ? null : 'url(#ah)' }));
    if (label) {
      // straight edges label beside the line; bent ones on their horizontal run
      const tx = ax === bx ? svg('text', { x: bx + 6, y: mid + 4, class: blocked ? 'x' : null })
        : svg('text', { x: (ax + bx) / 2, y: mid - 5, 'text-anchor': 'middle' });
      tx.textContent = blocked ? '✕ Funnel off' : label;
      kids.push(tx);
    }
  }
  w.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
  w.replaceChildren(...kids);
}

/* ---------- render ---------- */
// Looping animations take a negative delay from the wall clock, so elements
// rebuilt by a refresh continue in phase instead of restarting. 24s is a
// common multiple of every loop length in app.css (1.2s, 1.6s, 3s).
function syncMotion() { root.style.setProperty('--t0', -((Date.now() / 1000) % 24).toFixed(3) + 's'); }
// Only the open tab is rebuilt; the others are marked stale and rebuilt when opened.
const PAINT = {
  overview: [renderOverview], services: [renderTiles], host: [renderHost],
  network: [renderPorts, renderPanels, renderDevices, renderTopo], events: [renderEvents],
};
function paintView() {
  if (!S.cfg || !S.dirty.has(S.view)) return;
  S.dirty.delete(S.view);
  for (const f of PAINT[S.view]) f();
}
function render() {
  syncMotion();
  S.stale = isStale();
  renderHead();
  if (!S.cfg) { renderTiles(); renderOverview(); return; } // loading skeletons
  S.dirty = new Set(VIEWS);
  paintView();
  showTarget();
}

/* ---------- data ---------- */
// Network failures and timeouts throw without a status; HTTP and JSON errors carry one.
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
  if (!r.ok) throw Object.assign(new Error(url + ' ' + r.status), { status: r.status });
  let data;
  try { data = await r.json(); } catch (e) { throw Object.assign(e, { status: 'invalid' }); }
  return { data, cached: r.headers.get('x-pharos-cache') === '1' };
}
let busy = false, meSeq = 0;
async function refresh(manual) {
  if (busy) return;
  busy = true;
  try {
    const b = $('#rf'); b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
    // whoami can take seconds (it may ask tailscaled), so status never waits for it
    const seq = ++meSeq, me = getJSON(API + 'whoami').then((r) => r.data, () => null); // no actions service, or offline: read-only
    const [cfg, st] = await Promise.allSettled([getJSON(CONFIG_URL), getJSON(STATUS_URL)]);
    if (cfg.status === 'fulfilled') { S.cfg = cfg.value.data; if (S.err === 'config') S.err = null; }
    else if (!S.cfg) S.err = 'config';
    if (st.status === 'fulfilled') { S.st = st.value.data; S.cached = st.value.cached; S.fetchErr = null; }
    else S.fetchErr = st.reason.status || 'offline'; // keep the last data; it now reads as stale
    const tailnet = S.st && S.st.tailnet;
    if (S.cfg) for (const svc of S.cfg.services) svc.host = svc.host || svc.service.slice(4) + (tailnet ? '.' + tailnet : '');
    // Load the full event history only when a new event has arrived.
    const last = ((S.st && S.st.events) || []).slice(-1)[0];
    const key = last ? last.t + last.key : '';
    if (S.st && key !== S.histKey) {
      try { S.hist = (await getJSON(HISTORY_URL)).data; S.histKey = key; } catch (e) { /* keep the short list */ }
    }
    // the collector writes every 30s and polls come every 10s: rebuild only when something changed
    const sig = [S.st && S.st.generated, S.cached, S.fetchErr, S.err, S.histKey, JSON.stringify(S.cfg)].join('|');
    if (manual || sig !== S.sig) { S.sig = sig; render(); }
    if (manual) toast('Status refreshed');
    me.then((m) => {
      if (seq !== meSeq || JSON.stringify(m) === JSON.stringify(S.me)) return; // a newer whoami won, or nothing changed
      S.me = m;
      if (S.cfg && !$('[data-armed]')) render(); // an armed button re-renders itself after 4s
    });
  } finally {
    busy = false;
    clearTimeout(S.timer);
    // no polling in the background; visibilitychange refreshes on return
    S.timer = setTimeout(() => { if (!document.hidden) refresh(false); }, Math.min(10, interval()) * 1000);
  }
}
// Keep "updated Xs ago" current; re-render fully only when freshness flips.
setInterval(() => {
  if (!S.cfg || document.hidden) return;
  if (isStale() !== S.stale) render(); else renderHead();
}, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });

/* ---------- interaction ---------- */
let tt;
function toast(t, ms) {
  const e = $('#toast'); e.textContent = t; e.classList.add('on');
  clearTimeout(tt); tt = setTimeout(() => e.classList.remove('on'), ms || 1400);
}
function copy(t) {
  const ok = () => toast('Copied');
  const fb = () => {
    try {
      const a = document.createElement('textarea'); a.value = t; a.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); ok();
    } catch (e) { toast('Copy failed'); }
  };
  try { navigator.clipboard.writeText(t).then(ok, fb); } catch (e) { fb(); }
}
async function post(action, body) {
  try {
    const r = await fetch(API + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, detail: d.detail || d.error || 'HTTP ' + r.status };
  } catch (e) { return { ok: false, detail: 'host unreachable' }; }
}
async function act(btn) {
  const { act: kind, target } = btn.dataset;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = btn.dataset.warning ? btn.dataset.warning + ' · confirm' : 'Confirm';
    setTimeout(() => { if (btn.isConnected && btn.dataset.armed) render(); }, 4000);
    return;
  }
  S.acting.add(target);
  btn.disabled = true; btn.removeAttribute('data-armed'); btn.textContent = ACTING[kind];
  const r = await post(kind, { target });
  S.acting.delete(target);
  toast(r.ok ? (target.split(':')[1] || 'System') + ' · ' + r.detail : r.detail, 2500);
  setTimeout(() => refresh(false), 1500); // the collector re-checks right after an action
}
const quietBtn = $('#quiet');
function syncQuiet() {
  const q = S.st && S.st.quiet, on = !!(q && Date.parse(q.until) > Date.now());
  quietBtn.hidden = !(S.me && S.me.owner);
  quietBtn.innerHTML = on ? I.mute : I.bell;
  quietBtn.setAttribute('aria-pressed', String(on));
  const label = on ? 'Alerts paused until ' + clock(q.until) + '. Click to resume' : 'Alerts on. Click to pause for 1 hour';
  quietBtn.setAttribute('aria-label', label); quietBtn.title = label;
}
quietBtn.addEventListener('click', async () => {
  const on = quietBtn.getAttribute('aria-pressed') === 'true';
  const r = await post('quiet', { minutes: on ? 0 : 60 });
  toast(r.ok ? r.detail[0].toUpperCase() + r.detail.slice(1) : r.detail, 2000);
  setTimeout(() => refresh(false), 800);
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a) { act(a); return; }
  const c = e.target.closest('[data-copy]');
  if (c) { copy(c.dataset.copy); return; }
  const f = e.target.closest('[data-ev-filter]');
  if (f) { S.evFilter = f.dataset.evFilter; S.evLimit = 100; renderEvents(); return; }
  if (e.target.closest('[data-ev-more]')) { S.evLimit += 100; renderEvents(); return; }
  const i = e.target.closest('[data-info]');
  if (i) {
    const t = i.closest('.tile'), id = i.dataset.info, o = t.classList.toggle('open');
    i.setAttribute('aria-expanded', String(o));
    if (o) S.open.add(id); else S.open.delete(id);
  }
});

// keep an event's Why open across re-renders; toggle does not bubble, so listen in capture
document.addEventListener('toggle', (e) => {
  const d = e.target.dataset && e.target.dataset.ev;
  if (d) { if (e.target.open) S.open.add(d); else S.open.delete(d); }
}, true);

/* touch: a clear sideways swipe moves to the next or previous tab; the page follows the finger */
let swipe = null;
function scrollsX(el) {
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}
function dragTo(m, dx) {
  m.style.transform = dx ? 'translateX(' + dx + 'px)' : '';
  m.style.opacity = dx ? String(1 - Math.min(Math.abs(dx) / 400, 0.3)) : '';
}
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  // skip multi-touch, the screen edges (the browser's back/forward gesture), and anything that scrolls sideways itself
  swipe = e.touches.length > 1 || t.clientX < 24 || t.clientX > innerWidth - 24 || scrollsX(e.target) ? null
    : { x: t.clientX, y: t.clientY, at: Date.now(), m: $('#v-' + S.view), side: false };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!swipe || root.dataset.motion === 'off') return;
  const t = e.touches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
  if (!swipe.side) swipe.side = Math.abs(dx) > 10 && Math.abs(dx) > 2 * Math.abs(dy);
  if (!swipe.side) return;
  const i = VIEWS.indexOf(S.view) + (dx < 0 ? 1 : -1);
  swipe.m.style.transition = 'none';
  dragTo(swipe.m, dx * (i >= 0 && i < VIEWS.length ? 0.35 : 0.12)); // resists past the first and last tab
}, { passive: true });
function endSwipe(t) {
  if (!swipe) return;
  const { m, x, y, at } = swipe, dx = t ? t.clientX - x : 0, dy = t ? t.clientY - y : 0;
  swipe = null;
  const i = VIEWS.indexOf(S.view) + (dx < 0 ? 1 : -1);
  const go = t && Date.now() - at < 600 && Math.abs(dx) >= 60 && Math.abs(dx) >= 2 * Math.abs(dy)
    && !getSelection().toString() && i >= 0 && i < VIEWS.length;
  m.style.transition = go ? 'none' : ''; // a cancelled swipe springs back (transition in app.css)
  dragTo(m, 0);
  if (!go) return;
  if (root.dataset.motion !== 'off') $('#v-' + VIEWS[i]).dataset.in = dx < 0 ? 'next' : 'prev'; // slides in from the side it was pulled from
  location.hash = '#' + VIEWS[i];
}
document.addEventListener('touchend', (e) => endSwipe(e.changedTouches[0]), { passive: true });
document.addEventListener('touchcancel', () => endSwipe(null), { passive: true });
document.addEventListener('animationend', (e) => { if (e.target.dataset && e.target.dataset.in) delete e.target.dataset.in; });

/* pages: one hash per tab; old names redirect */
const VIEWS = ['overview', 'services', 'host', 'network', 'events'];
const ALIAS = { system: 'network', architecture: 'network' };
function route() {
  let [v, target] = location.hash.slice(1).split('/');
  if (ALIAS[v]) { v = ALIAS[v]; history.replaceState(null, '', '#' + v + (target ? '/' + target : '')); }
  S.view = VIEWS.includes(v) ? v : 'overview';
  S.target = target || null;
  for (const x of VIEWS) $('#v-' + x).hidden = x !== S.view;
  paintView();
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.dataset.v === S.view) { t.setAttribute('aria-current', 'page'); t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    else t.removeAttribute('aria-current');
  });
  if (S.view === 'network') drawWires();
  showTarget();
}
window.addEventListener('hashchange', () => { if (!location.hash.includes('/')) window.scrollTo(0, 0); route(); });
if (window.ResizeObserver) new ResizeObserver(() => drawWires()).observe($('#topo'));
if (document.fonts) document.fonts.ready.then(drawWires);

/* theme: System > Light > Dark. System = no data-theme, so CSS follows the OS live. */
const themeBtn = $('#theme'), MODES = ['system', 'light', 'dark'];
const TLABEL = { system: 'System', light: 'Light', dark: 'Dark' }, TICON = { system: 'mon', light: 'sun', dark: 'moon' };
const mq = matchMedia('(prefers-color-scheme: dark)');
let mode = 'system';
function syncThemeColor() {
  document.querySelector('meta[name=theme-color]').content = (mode === 'system' ? mq.matches : mode === 'dark') ? '#050607' : '#edeef0';
}
function setMode(m, save) {
  mode = m;
  if (m === 'system') root.removeAttribute('data-theme'); else root.dataset.theme = m;
  if (save) { try { localStorage.setItem('tn-theme', m); } catch (e) {} }
  themeBtn.innerHTML = I[TICON[m]];
  themeBtn.setAttribute('aria-label', 'Theme: ' + TLABEL[m] + '. Click to change');
  themeBtn.title = 'Theme: ' + TLABEL[m];
  syncThemeColor();
}
themeBtn.addEventListener('click', () => { const n = MODES[(MODES.indexOf(mode) + 1) % 3]; setMode(n, true); toast('Theme: ' + TLABEL[n]); });
if (mq.addEventListener) mq.addEventListener('change', syncThemeColor);

/* motion: on/off, remembered; without a saved choice it follows the device setting */
const motionBtn = $('#motion'), rm = matchMedia('(prefers-reduced-motion: reduce)');
function setMotion(on, save) {
  if (on) delete root.dataset.motion; else root.dataset.motion = 'off';
  if (save) { savedMotion = on ? 'on' : 'off'; try { localStorage.setItem('tn-motion', savedMotion); } catch (e) {} }
  motionBtn.innerHTML = on ? I.wave : I.flat;
  motionBtn.setAttribute('aria-pressed', String(!on));
  motionBtn.setAttribute('aria-label', 'Motion: ' + (on ? 'on' : 'off') + '. Click to change');
  motionBtn.title = 'Motion: ' + (on ? 'on' : 'off');
}
motionBtn.addEventListener('click', () => { const on = root.dataset.motion === 'off'; setMotion(on, true); toast('Motion: ' + (on ? 'on' : 'off')); });
let savedMotion = null;
try { savedMotion = localStorage.getItem('tn-motion'); } catch (e) {}
setMotion(savedMotion ? savedMotion === 'on' : !rm.matches, false);
if (rm.addEventListener) rm.addEventListener('change', () => { if (!savedMotion) setMotion(!rm.matches, false); });
try { const s = localStorage.getItem('tn-theme'); setMode(s === 'light' || s === 'dark' ? s : 'system', false); } catch (e) { setMode('system', false); }

$('#rf').innerHTML = I.refresh;
$('#rf').addEventListener('click', () => refresh(true));

/* start */
route();
render();
refresh(false);
// Offline shell only; the page works without it (insecure origins, private windows).
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {}));
}
})();
