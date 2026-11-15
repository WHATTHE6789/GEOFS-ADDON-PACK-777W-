// ==UserScript==
// @name         GeoFS 777-300ER SimBrief Import (flight plan -> CDU)
// @namespace    https://github.com/geofs-overhead
// @version      1.0.0
// @description  Fetches your latest SimBrief flight plan and loads it into the Lower Panel CDU: airports, callsign, cruise altitude, cost index, weights, fuel, runways, SID/STAR names and every waypoint with coordinates. ATC and the PERF page then use it. Install after the Lower Panel and Nav Data scripts.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * USE: tap the SBRF tab (▤ handle) or Alt+B. Enter your SimBrief username (or numeric Pilot ID), tap FETCH. It reads your LATEST generated plan.
 * If the browser blocks the request (CORS/network), open this address in a normal tab, copy all the text, and paste it into the PASTE box:
 *     https://www.simbrief.com/api/xml.fetcher.php?username=YOURNAME&json=1
 * NOTES: Waypoints, airways and SID/STAR names come from SimBrief's own navlog, so they are as real as your AIRAC data there.
 * This script could not be tested against the live SimBrief service from where it was written - the field names follow SimBrief's published OFP JSON; tell me if something loads empty.
 */
(function () {
  'use strict';
  if (window.GeoFSSimBrief) return;
  const safe = (f, d) => { try { const r = f(); return r === undefined ? d : r; } catch (e) { return d; } };
  const $ = (s, r = document) => r.querySelector(s), esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const LO = () => safe(() => window.GeoFSLower, null), STORE = 'geofsSimBrief.v1';
  const S = { open: false, x: 120, y: 52, user: '' }; try { Object.assign(S, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) { /* ignore */ } S.open = false;
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } };
  let OFP = null, MSG = '', PLAN = null;

  const arr = x => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const n = x => { const v = parseFloat(x); return isFinite(v) ? v : null; };
  function parse(o) { // OFP JSON -> plan
    if (!o || !o.origin || !o.destination) throw new Error('This does not look like a SimBrief plan (no origin/destination).');
    const lbs = /lb/i.test(safe(() => o.params.units, '') || ''), kg = v => (v == null ? null : lbs ? v * 0.45359237 : v), g = o.general || {}, fu = o.fuel || {}, w = o.weights || {};
    const fixes = arr(safe(() => o.navlog.fix, [])), real = fixes.map((f, i) => ({ i, sid: String(f.is_sid_star) === '1', f }));
    const firstEnr = real.findIndex(r => !r.sid && r.f.type !== 'apt'), lastEnr = real.map(r => !r.sid && r.f.type !== 'apt').lastIndexOf(true);
    const legs = []; real.forEach(r => { const f = r.f, lat = n(f.pos_lat), lon = n(f.pos_long); if (lat == null || lon == null) return; if (f.type === 'apt' && (r.i === 0 || r.i === fixes.length - 1)) return; const p = r.sid ? (r.i < firstEnr ? 'SID' : r.i > lastEnr ? 'STAR' : '') : ''; legs.push({ id: String(f.ident || 'WPT').toUpperCase().slice(0, 5), lat, lon, alt: n(f.altitude_feet) || null, _p: p || undefined, via: f.via_airway || '' }); });
    const sidFix = fixes.find((f, i) => String(f.is_sid_star) === '1' && i < (firstEnr < 0 ? 99 : firstEnr) && f.via_airway), starFix = fixes.slice().reverse().find((f, i) => String(f.is_sid_star) === '1' && f.via_airway && fixes.indexOf(f) > lastEnr);
    return { orig: String(o.origin.icao_code || '').toUpperCase(), dest: String(o.destination.icao_code || '').toUpperCase(), altn: String(safe(() => o.alternate.icao_code, '') || '').toUpperCase(),
      flt: String(safe(() => o.atc.callsign, '') || ((g.icao_airline || '') + (g.flight_number || ''))).toUpperCase(), crz: n(g.initial_altitude), ci: n(g.costindex), route: g.route || '',
      rwyDep: safe(() => o.origin.plan_rwy, '') || '', rwyArr: safe(() => o.destination.plan_rwy, '') || '', sid: g.sid_ident || safe(() => sidFix.via_airway, '') || '', star: g.star_ident || safe(() => starFix.via_airway, '') || '',
      zfw: kg(n(w.est_zfw)) != null ? kg(n(w.est_zfw)) / 1000 : null, fuel: kg(n(fu.plan_ramp)) != null ? kg(n(fu.plan_ramp)) / 1000 : null, res: kg(n(fu.reserve)) != null ? kg(n(fu.reserve)) / 1000 : null, tow: kg(n(w.est_tow)) != null ? kg(n(w.est_tow)) / 1000 : null,
      dist: n(g.route_distance), ete: n(safe(() => o.times.est_time_enroute, null)), ac: safe(() => o.aircraft.icaocode, ''), legs };
  }
  function apply(p) {
    const L = LO(); if (!L || !L.fmc) throw new Error('Lower Panel script not found');
    const F = L.fmc; F.orig = p.orig; F.dest = p.dest; F.altn = p.altn || F.altn; if (p.flt) F.flt = p.flt; if (p.crz) F.crz = p.crz; if (p.ci != null) F.ci = p.ci; if (p.zfw != null) F.zfw = Math.round(p.zfw * 10) / 10; if (p.fuel != null) F.fuel = Math.round(p.fuel * 10) / 10; if (p.res != null) F.res = Math.round(p.res * 10) / 10;
    if (p.rwyDep) F.rwy = p.rwyDep; F.rwyArr = p.rwyArr || ''; F.sidName = p.sid || ''; F.starName = p.star || ''; F.route = p.route; F.v1 = F.vr = F.v2 = null;
    F.legs = p.legs.map(l => ({ id: l.id, lat: l.lat, lon: l.lon, alt: l.alt, _p: l._p })); F.active = 0; F.lnav = false;
    safe(() => L.save()); safe(() => L.refresh());
    const N = safe(() => window.GeoFSNavATC, null); if (N) { N.loadAirport(p.orig).catch(() => 0); N.loadAirport(p.dest).catch(() => 0); }
    const A = safe(() => window.GeoFSATC, null); if (A && A.newFlight) safe(() => A.newFlight());
  }
  async function fetchPlan(user) {
    user = String(user || '').trim(); if (!user) throw new Error('Enter your SimBrief username or Pilot ID');
    const q = /^\d+$/.test(user) ? 'userid=' : 'username='; const r = await fetch('https://www.simbrief.com/api/xml.fetcher.php?' + q + encodeURIComponent(user) + '&json=1'); if (!r.ok) throw new Error('SimBrief returned HTTP ' + r.status + ' (check the username, and that you have generated a plan)'); return r.json();
  }
  async function load(src) { try { OFP = typeof src === 'string' ? JSON.parse(src) : src; PLAN = parse(OFP); apply(PLAN); MSG = 'Loaded ' + PLAN.orig + ' → ' + PLAN.dest + ' (' + PLAN.legs.length + ' waypoints).'; } catch (e) { MSG = 'Error: ' + e.message; PLAN = null; } draw(); }

  const CSS = '#gfs-root{position:fixed;z-index:99986;display:none;width:min(430px,96vw);font:600 11px system-ui,sans-serif;color:#dde4ea;background:#1d2125;border:2px solid #000;border-radius:10px;box-shadow:0 10px 36px #000c;max-height:calc(100dvh - 16px);flex-direction:column;overflow:hidden;touch-action:manipulation}#gfs-root.open{display:flex}#gfs-root .b{display:flex;align-items:center;gap:6px;padding:5px 8px;background:linear-gradient(#3a3f44,#2a2e32);cursor:grab;touch-action:none;letter-spacing:.12em;font-size:10px}#gfs-root .b b{flex:1}#gfs-root button{all:unset;cursor:pointer;padding:8px 11px;border-radius:5px;background:#3b4046;border:1px solid #0d0f11;font-size:11px;color:#dfe5e9}#gfs-root button.go{background:#1d4d2e;color:#bfffd2}#gfs-root .c{padding:10px;overflow:auto;-webkit-overflow-scrolling:touch}#gfs-root input,#gfs-root textarea{font:600 16px ui-monospace,monospace;background:#0f1215;color:#dfe;border:1px solid #444;border-radius:4px;padding:6px;width:100%;box-sizing:border-box;-webkit-user-select:text;user-select:text}#gfs-root .r{display:flex;gap:6px;margin:6px 0;flex-wrap:wrap;align-items:center}#gfs-root .k{background:#12161a;border:1px solid #2c333a;border-radius:6px;padding:7px 9px;margin:6px 0;line-height:1.5;font-weight:500}#gfs-tab{display:block}';
  let root = null;
  function draw() {
    if (!root) return; const c = $('.c', root); if (document.activeElement && root.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) { const m = $('#gfs-msg', root); if (m) m.textContent = MSG; return; }
    const p = PLAN, t = x => (x == null ? '-' : x.toFixed(1) + ' t');
    c.innerHTML = `<div class="r"><input id="gfs-u" placeholder="SimBrief username or Pilot ID" value="${esc(S.user)}" autocapitalize="off" autocorrect="off"><button class="go" data-a="fetch">FETCH LATEST PLAN</button></div><div id="gfs-msg" class="k">${esc(MSG || 'Generate a plan on SimBrief first, then fetch it here.')}</div>` + (p ? `<div class="k"><b>${esc(p.flt)}</b> ${esc(p.orig)} → ${esc(p.dest)}${p.altn ? ' (altn ' + esc(p.altn) + ')' : ''}<br>CRZ ${p.crz ? 'FL' + Math.round(p.crz / 100) : '-'} · CI ${p.ci == null ? '-' : p.ci} · ${p.dist ? Math.round(p.dist) + ' NM' : ''} ${p.ete ? Math.floor(p.ete / 3600) + 'h' + String(Math.round((p.ete % 3600) / 60)).padStart(2, '0') : ''}<br>ZFW ${t(p.zfw)} · FUEL ${t(p.fuel)} · RES ${t(p.res)}<br>RWY ${esc(p.rwyDep || '-')} / ${esc(p.rwyArr || '-')} · SID ${esc(p.sid || '-')} · STAR ${esc(p.star || '-')}<br><span style="color:#8da0ad">${esc(p.route)}</span></div><div class="k">${p.legs.map(l => esc(l.id)).join(' ')}</div>` : '') + `<div class="r"><button data-a="show">${S.paste ? 'HIDE' : 'SHOW'} PASTE BOX</button></div>` + (S.paste ? `<textarea id="gfs-p" rows="4" placeholder="Paste the SimBrief JSON here"></textarea><div class="r"><button class="go" data-a="paste">LOAD PASTED PLAN</button></div>` : '');
  }
  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'gfs-root'; root.innerHTML = '<div class="b"><b>SIMBRIEF</b><button data-a="close">✕</button></div><div class="c"></div>'; document.body.appendChild(root);
    const tb = document.createElement('div'); tb.id = 'gfs-tab'; tb.textContent = 'SBRF'; tb.addEventListener('click', () => toggle()); document.body.appendChild(tb);
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'wheel', 'keydown', 'keyup'].forEach(t => root.addEventListener(t, e => e.stopPropagation(), { passive: true }));
    const bar = $('.b', root); let dr = null; bar.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; dr = { dx: e.clientX - S.x, dy: e.clientY - S.y }; try { bar.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
    bar.addEventListener('pointermove', e => { if (!dr) return; S.x = Math.max(0, Math.min(e.clientX - dr.dx, innerWidth - 80)); S.y = Math.max(0, Math.min(e.clientY - dr.dy, innerHeight - 40)); place(); }); bar.addEventListener('pointerup', () => { dr = null; save(); });
    root.addEventListener('input', e => { if (e.target.id === 'gfs-u') { S.user = e.target.value.trim(); save(); } });
    root.addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return; const a = b.dataset.a;
      if (a === 'close') return toggle(false); if (a === 'show') { S.paste = !S.paste; return draw(); }
      if (a === 'paste') { const v = ($('#gfs-p', root) || {}).value || ''; return load(v); }
      if (a === 'fetch') { S.user = (($('#gfs-u', root) || {}).value || S.user).trim(); save(); MSG = 'Fetching…'; draw(); try { await load(await fetchPlan(S.user)); } catch (err) { MSG = err.message + (/Failed to fetch|NetworkError|Load failed/i.test(err.message) ? ' - the browser may have blocked the request; use the paste box instead.' : ''); S.paste = true; draw(); } } });
    place(); draw();
  }
  const place = () => { if (root) { root.style.left = S.x + 'px'; root.style.top = S.y + 'px'; } };
  const toggle = f => { S.open = typeof f === 'boolean' ? f : !S.open; root.classList.toggle('open', S.open); if (S.open) draw(); };
  document.addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyB' && root) { e.preventDefault(); toggle(); } });
  function boot() { if (!document.body || !document.head) return setTimeout(boot, 800); build(); window.GeoFSSimBrief = { version: '1.0.0', open: () => toggle(true), fetchPlan, parse, apply, load, plan: () => PLAN }; console.log('[GeoFS SimBrief] loaded. Alt+B'); }
  boot();
})();


/* ── Shared top-left tab dock (identical in every 777 script; the first to load defines it) ──
   One small ▤ handle (drag it anywhere). Tap it to fan the tabs out and tap it again to tuck them away. It always sits above every panel, so it can never be covered. */
(function () {
  if (window.GeoFSDock) return;
  const KEY = 'gfDock.v2'; let P = { x: 6, y: 6, open: false };
  try { Object.assign(P, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* ignore */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { /* ignore */ } };
  const css = document.createElement('style'); css.id = 'gf-dock-css';
  css.textContent = '#gf-dock-box{position:fixed;z-index:2147483000;display:flex;gap:4px;align-items:center;flex-wrap:wrap;max-width:min(96vw,920px);pointer-events:none}#gf-dock-box>*{pointer-events:auto}#gf-dock-h{order:-1;width:34px;height:28px;border-radius:14px;border:1px solid #000;background:#232a30;color:#cfe;font:700 14px/26px system-ui,sans-serif;text-align:center;cursor:grab;opacity:.8;touch-action:none;-webkit-user-select:none;user-select:none}#gf-dock-box.open #gf-dock-h{background:#1f3b57;opacity:1}.gf-dock{pointer-events:auto!important;position:static!important;left:auto!important;top:auto!important;right:auto!important;bottom:auto!important;margin:0!important;transform:none!important;writing-mode:horizontal-tb!important;width:auto!important;min-width:64px;height:28px!important;line-height:26px!important;padding:0 11px!important;border-radius:14px!important;border:1px solid #000!important;background:#232a30!important;color:#cfe!important;font:700 10px system-ui,sans-serif!important;letter-spacing:.1em!important;cursor:pointer;text-align:center!important;box-shadow:0 2px 6px #0008!important;opacity:.95;white-space:nowrap;display:none!important;touch-action:manipulation;-webkit-user-select:none;user-select:none}#gf-dock-box.open .gf-dock{display:block!important}@media (pointer:coarse),(hover:none){#gf-dock-h{width:42px;height:36px;line-height:34px}.gf-dock{height:36px!important;line-height:34px!important;font-size:11px!important;min-width:76px}}';
  (document.head || document.documentElement).appendChild(css);
  let box = null;
  const mk = () => {
    if (box || !document.body) return box;
    box = document.createElement('div'); box.id = 'gf-dock-box'; const h = document.createElement('div'); h.id = 'gf-dock-h'; h.textContent = '▤'; h.title = 'Tabs'; box.appendChild(h); document.body.appendChild(box);
    const place = () => { P.x = Math.max(0, Math.min(P.x, innerWidth - 44)); P.y = Math.max(0, Math.min(P.y, innerHeight - 40)); box.style.left = P.x + 'px'; box.style.top = P.y + 'px'; box.classList.toggle('open', !!P.open); };
    let d = null; h.addEventListener('pointerdown', e => { d = { dx: e.clientX - P.x, dy: e.clientY - P.y, sx: e.clientX, sy: e.clientY, m: false }; try { h.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } e.stopPropagation(); });
    h.addEventListener('pointermove', e => { if (!d) return; if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 8) d.m = true; if (d.m) { P.x = e.clientX - d.dx; P.y = e.clientY - d.dy; place(); } });
    h.addEventListener('pointerup', () => { if (d && !d.m) { P.open = !P.open; place(); } d = null; save(); });
    ['mousedown', 'touchstart', 'click'].forEach(t => h.addEventListener(t, e => e.stopPropagation(), { passive: true }));
    place(); return box;
  };
  window.GeoFSDock = { add(find, slot) { let n = 0; const iv = setInterval(() => { const el = typeof find === 'function' ? find() : document.querySelector(find); if (el || ++n > 80) { clearInterval(iv); if (!el || !mk()) return; box.appendChild(el); el.classList.add('gf-dock'); el.style.order = String(slot + 1); ['pointerdown', 'mousedown', 'touchstart'].forEach(t => el.addEventListener(t, e => e.stopPropagation(), { passive: true })); } }, 500); } };
})();
GeoFSDock.add('#gfs-tab', 9);
