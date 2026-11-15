// ==UserScript==
// @name         GeoFS 777-300ER Side EFB
// @namespace    https://github.com/geofs-overhead
// @version      1.0.0
// @description  Boeing 777 style Electronic Flight Bag for GeoFS: moving map, checklists (auto-checked from the Overhead/Lower panel scripts), performance, weather, OOOI flight log, weight & balance / fuel, calculator + converters, notes and links. Slides in from the side of the screen.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * INSTALL: Tampermonkey/Violentmonkey -> Create new script -> paste -> save -> reload GeoFS.
 * USE:     Alt+E or tap the "EFB" tab on the screen edge. Everything is touch friendly (iPad / Orion OK).
 *          DOCK button in the header moves it between the right (F/O EFB) and left (CAPT EFB) side.
 *
 * HONESTY NOTE
 *   REAL      -> map position/track/trail (from GeoFS), flight plan legs (GeoFS flight plan or the CDU's legs),
 *                OOOI times / touchdown rate / distance (measured from the sim), wind components, unit conversions,
 *                METAR/TAF (fetched live from aviationweather.gov if your browser allows the request).
 *   APPROX    -> performance numbers (V-speeds, runway lengths) and fuel planning are rough estimates for a
 *                777-300ER, NOT Boeing data. Sim use only.
 *   AIRPORT MAP -> runways, taxiways, aprons, terminals, gates and hold-short points come from OpenStreetMap (Overpass API),
 *                downloaded by your browser in small cells and cached on the device. Needs internet; coverage and accuracy
 *                depend on volunteer mapping (major airports are usually excellent, small fields may be sparse). Taxiway
 *                names/positions may differ from GeoFS scenery. Not a certified airport moving map; sim use only.
 *   NOT HERE  -> no Jeppesen charts or satellite imagery; the LINKS app opens public sites.
 *   Checklists are generic sim checklists, not Boeing FCOM/QRH. Items with a dot are auto-checked against the
 *   Overhead / Lower panel scripts when they are installed (green = matches, amber = doesn't). Others are manual.
 */
(function () {
  'use strict';
  if (window.GeoFSEFB) return;

  const VERSION = '1.0.0';
  const STORE = 'geofsEFB.v1';

  /* ───────────────────────── helpers ───────────────────────── */
  const safe = (f, d) => { try { const r = f(); return r === undefined ? d : r; } catch (e) { return d; } };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const V = () => safe(() => geofs.animation.values, {}) || {};
  const inst = () => safe(() => geofs.aircraft.instance, null);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const num = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };
  const gsKt = () => { const v = V(); return typeof v.groundSpeedKnt === 'number' ? v.groundSpeedKnt : (v.groundSpeed || 0) * 1.944; };
  const agl = v => (typeof v.haglFeet === 'number' ? v.haglFeet : Math.max(0, (v.altitude || 0) - (v.groundElevationFeet || 0)));
  const onGround = v => { const g = safe(() => inst().groundContact, undefined); return g !== undefined ? !!g : agl(v) < 8; };
  const gearPos = () => { const v = V().gearPosition; return typeof v === 'number' ? v : safe(() => controls.gear.position, 0); };
  const parkSet = () => !!safe(() => controls.parkingBrake, false);
  const engRun = () => { const on = safe(() => inst().engine.on, undefined); return on !== undefined ? !!on : (V().rpm || 0) > 300; };
  const flapN = () => { const d = safe(() => inst().definition.flapsSteps, null); const n = typeof d === 'number' ? d : Array.isArray(d) ? d.length : safe(() => controls.flaps.maxPosition, 0); return clamp(Math.round(n || 4), 1, 10); };
  const flapIdx = () => { const t = safe(() => controls.flaps.target, undefined); return clamp(Math.round(typeof t === 'number' ? t : (V().flapsValue || 0) * flapN()), 0, 10); };
  const apOn = () => !!safe(() => geofs.autopilot.on, false);
  const OV = () => safe(() => window.GeoFSOverhead, null), LO = () => safe(() => window.GeoFSLower, null);
  const sw = k => safe(() => OV().state.sw[k], undefined);
  const fmc = () => safe(() => LO().fmc, null);
  const utcTime = (t = Date.now()) => { const d = new Date(t); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + 'Z'; };
  const hm = ms => { if (ms == null || !isFinite(ms) || ms < 0) return '--:--'; const m = Math.round(ms / 60000); return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
  const RAD = Math.PI / 180;
  function pos() { const l = safe(() => geofs.aircraft.instance.llaLocation, null) || safe(() => geofs.camera.lla, null); return l && isFinite(l[0]) && isFinite(l[1]) ? { lat: l[0], lon: l[1] } : null; }
  function gcd(a, b) { const dl = (b.lat - a.lat) * RAD, dn = (b.lon - a.lon) * RAD, x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dn / 2) ** 2; return 2 * 3440.065 * Math.asin(Math.sqrt(x)); }
  function brg(a, b) { const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD), x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD); return (Math.atan2(y, x) / RAD + 360) % 360; }

  /* ───────────────────────── state ───────────────────────── */
  const LOG0 = () => ({ out: null, off: null, on: null, inn: null, maxAlt: 0, maxIas: 0, dist: 0, td: null, lastVs: 0 });
  const DEF = () => ({
    open: false, side: 'right', app: 'home', bright: 1, range: 40, north: false, mapApt: true, mapAuto: true, mapLbl: true,
    log: LOG0(), notes: '', chk: {}, list: 'PREFLIGHT',
    perf: { tow: 300, flaps: 15, oat: 15, elev: 0, wd: 0, ws: 0, rwy: 0, len: 3500, lw: 230, lflap: 30, lrwy: 3200 },
    wb: { oew: 167800, pay: 40000, fuel: 90000, dist: 3000 },
    links: [['SkyVector', 'https://skyvector.com'], ['Aviation Weather', 'https://aviationweather.gov'], ['Windy', 'https://www.windy.com']],
    wx: { icao: '' },
  });
  const S = DEF();
  try { const o = JSON.parse(localStorage.getItem(STORE) || 'null'); if (o) { Object.keys(S).forEach(k => { if (o[k] !== undefined) S[k] = (S[k] && typeof S[k] === 'object' && !Array.isArray(S[k])) ? Object.assign(S[k], o[k]) : o[k]; }); } } catch (e) { /* ignore */ }
  S.open = false;
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } }, 300); };
  const trail = [];

  /* ───────────────────────── flight log (always running) ───────────────────────── */
  let lastLog = performance.now(), wasAir = false, logN = 0;
  function logTick() {
    const now = performance.now(), dt = (now - lastLog) / 1000; lastLog = now;
    const v = V(), L = S.log, ground = onGround(v), gs = gsKt(), park = parkSet(), t = Date.now();
    if (!L.out && ground && !park && gs > 2 && !L.off) L.out = t;
    if (L.out && !L.off && !ground && agl(v) > 10) L.off = t;
    if (L.off && !L.on && ground && wasAir) { L.on = t; L.td = Math.round(L.lastVs); }
    if (L.on && !L.inn && ground && gs < 2 && park) L.inn = t;
    if (L.out && !L.inn) L.dist += gs * dt / 3600;
    if (!ground) L.lastVs = v.verticalSpeed || 0;
    L.maxAlt = Math.max(L.maxAlt, v.altitude || 0); L.maxIas = Math.max(L.maxIas, v.kias || 0);
    wasAir = !ground; logN++;
    const p = pos(); if (p && (!trail.length || now - (trail.t || 0) > 4000)) { trail.push(p); trail.t = now; if (trail.length > 400) trail.shift(); }
    if (logN % 10 === 0) save();
  }

  /* ───────────────────────── apps ───────────────────────── */
  const APPS = {};
  const field = (key, label, unit, obj, o = {}) => `<label class="f"><span>${label}</span><input data-f="${obj}.${key}" inputmode="decimal" ${o.ro ? 'readonly' : ''}><em>${unit || ''}</em></label>`;
  function bindFields(el, onChange) {
    $$('[data-f]', el).forEach(inp => {
      const [o, k] = inp.dataset.f.split('.');
      if (S[o][k] != null) inp.value = S[o][k];
      inp.addEventListener('input', () => { const x = num(inp.value); if (x != null) { S[o][k] = x; save(); onChange && onChange(); } });
    });
  }
  const setIn = (el, sel, v) => { const i = $(sel, el); if (i && document.activeElement !== i) i.value = v; };

  /* ---- HOME ---- */
  APPS.home = {
    name: 'HOME', icon: '⌂',
    render(el) {
      const f = fmc() || {};
      el.innerHTML = `<div class="home"><div class="hd"><b>${esc(f.flt || 'NO FLT NO')}</b><span>${esc(safe(() => geofs.aircraft.instance.aircraftRecord.name, '777-300ER'))}</span><span>${esc(f.orig || '----')} → ${esc(f.dest || '----')}</span></div>
      <div class="grid">${Object.entries(APPS).filter(([k]) => k !== 'home').map(([k, a]) => `<button class="tile" data-app="${k}"><i>${a.icon}</i><span>${a.name}</span></button>`).join('')}</div>
      <div class="note">Sim EFB · performance and fuel values are approximate · see script header for what is real</div></div>`;
    },
  };

  /* ---- MAP (moving map + OpenStreetMap airport layer) ---- */
  const RANGES = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 40, 80, 160, 320, 640];
  const planLegs = () => {
    const f = fmc(); if (f && f.legs && f.legs.length) return { legs: f.legs, active: f.active || 0 };
    const arr = safe(() => geofs.flightPlan.waypointArray, null);
    if (arr && arr.length) return { legs: arr.map((w, i) => ({ id: String(w.ident || w.id || w.name || 'WPT' + (i + 1)).toUpperCase().slice(0, 5), lat: w.lat != null ? w.lat : safe(() => w.lla[0]), lon: w.lon != null ? w.lon : safe(() => w.lla[1]) })).filter(l => isFinite(l.lat) && isFinite(l.lon)), active: 0 };
    return { legs: [], active: 0 };
  };

  // Airport geometry: runways, taxiways, aprons, terminals, gates and hold-short points from OpenStreetMap (Overpass API),
  // downloaded in 0.05-degree cells around you and cached on the device (IndexedDB). Needs internet from your browser.
  const AM = { ref: null, cells: new Map(), queue: [], busy: false, status: 'AIRPORT DATA: waiting', all: [], ver: 0, builtVer: -1, idb: null, retry: {}, pan: { x: 0, y: 0 }, sel: null, selT: 0, on: null, onT: 0, wasG: null, label: [] };
  const CELL = 0.05, OVP = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const idbOpen = () => new Promise(res => { try { const r = indexedDB.open('geofsEfbMap', 1); r.onupgradeneeded = () => r.result.createObjectStore('cells'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (e) { res(null); } });
  const idbGet = k => new Promise(res => { if (!AM.idb) return res(null); try { const q = AM.idb.transaction('cells').objectStore('cells').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch (e) { res(null); } });
  const idbPut = (k, v) => { try { if (AM.idb) AM.idb.transaction('cells', 'readwrite').objectStore('cells').put(v, k); } catch (e) { /* ignore */ } };
  idbOpen().then(d => { AM.idb = d; });
  const KEEP = new Set(['runway', 'taxiway', 'taxilane', 'apron', 'terminal', 'hangar', 'helipad', 'parking_position', 'gate', 'holding_position', 'stopway', 'launchpad']);
  function parseOsm(j) {
    const out = [];
    (j.elements || []).forEach(e => {
      const t = e.tags || {}, a = t.aeroway; if (!KEEP.has(a)) return;
      let p = null; if (e.type === 'way' && e.geometry) p = e.geometry.map(g => [g.lat, g.lon]); else if (e.type === 'node' && e.lat != null) p = [[e.lat, e.lon]]; if (!p || !p.length) return;
      out.push({ id: e.type[0] + e.id, t: a, ref: t.ref || '', name: t.name || '', w: parseFloat(t.width) || 0, p, closed: p.length > 3 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1] });
    });
    return out;
  }
  async function fetchCell(i, j) {
    const s = i * CELL, w = j * CELL, n = s + CELL, e = w + CELL, m = .004, bb = `${(s - m).toFixed(5)},${(w - m).toFixed(5)},${(n + m).toFixed(5)},${(e + m).toFixed(5)}`;
    const q = `[out:json][timeout:30];(way["aeroway"~"^(runway|taxiway|taxilane|apron|terminal|hangar|helipad|parking_position|gate|holding_position|stopway)$"](${bb});node["aeroway"~"^(gate|parking_position|holding_position|helipad)$"](${bb}););out geom tags;`;
    let last = null;
    for (const u of OVP) { try { const r = await fetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return parseOsm(await r.json()); } catch (err) { last = err; } }
    throw last || new Error('failed');
  }
  async function pump() {
    if (AM.busy) return; const k = AM.queue.shift(); if (!k) return; AM.busy = true;
    try {
      const [i, j] = k.split(',').map(Number); let f = await idbGet(k);
      if (!f) { AM.status = 'AIRPORT DATA: downloading cell ' + k + '…'; f = await fetchCell(i, j); idbPut(k, f); }
      AM.cells.set(k, f); AM.ver++; AM.status = 'AIRPORT DATA: ' + AM.cells.size + ' cell(s) loaded';
    } catch (e) { AM.retry[k] = Date.now() + 60000; AM.status = 'AIRPORT DATA: unavailable (' + (e && e.message ? e.message : 'offline') + ') - retrying'; }
    AM.busy = false; if (AM.queue.length) pump();
  }
  function need(p, rangeNm) {
    const dn = Math.max(rangeNm * 1.25, .6) / 60, dl = dn / Math.max(.2, Math.cos(p.lat * RAD)), i0 = Math.floor((p.lat - dn) / CELL), i1 = Math.floor((p.lat + dn) / CELL), j0 = Math.floor((p.lon - dl) / CELL), j1 = Math.floor((p.lon + dl) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i + ',' + j; if (AM.cells.has(k) || AM.queue.includes(k) || (AM.retry[k] && AM.retry[k] > Date.now()) || AM.cells.size + AM.queue.length > 40) continue; AM.queue.push(k); }
    pump();
  }
  const M_LAT = 110947, mLon = lat => 111320 * Math.cos(lat * RAD);
  function rebuild(p) {
    if (!AM.ref || gcd(AM.ref, p) > 25) { AM.ref = { lat: p.lat, lon: p.lon }; AM.builtVer = -1; }
    if (AM.builtVer === AM.ver) return; const seen = new Set(), all = [], ml = mLon(AM.ref.lat);
    AM.cells.forEach(arr => arr.forEach(f => { if (seen.has(f.id)) return; seen.add(f.id);
      const xy = f.p.map(q => [(q[1] - AM.ref.lon) * ml, (q[0] - AM.ref.lat) * M_LAT]); let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12; xy.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
      all.push(Object.assign({}, f, { xy, bb: [x0, y0, x1, y1], cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, ext: Math.hypot(x1 - x0, y1 - y0) / 2 })); }));
    AM.all = all; AM.builtVer = AM.ver;
  }
  const toXY = p => ({ x: (p.lon - AM.ref.lon) * mLon(AM.ref.lat), y: (p.lat - AM.ref.lat) * M_LAT });
  const segD = (px, py, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0; t = clamp(t, 0, 1); return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)); };
  const lineD = (px, py, xy) => { let d = 1e9; for (let i = 0; i < xy.length - 1; i++) d = Math.min(d, segD(px, py, xy[i], xy[i + 1])); return xy.length === 1 ? Math.hypot(px - xy[0][0], py - xy[0][1]) : d; };
  const inPoly = (px, py, xy) => { let c = false; for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) { const a = xy[i], b = xy[j]; if ((a[1] > py) !== (b[1] > py) && px < (b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  function whereAmI(o) { // what are we on?
    const res = { rwy: null, twy: null, apron: false, stand: null, hold: null }; let best = 1e9;
    AM.all.forEach(f => {
      if (Math.hypot(f.cx - o.x, f.cy - o.y) > f.ext + 80) return;
      if (f.t === 'runway' || f.t === 'stopway') { if (lineD(o.x, o.y, f.xy) <= (f.w || 45) / 2 + 3) res.rwy = f.ref || 'RWY'; }
      else if (f.t === 'taxiway' || f.t === 'taxilane') { const d = lineD(o.x, o.y, f.xy); if (d <= (f.w || (f.t === 'taxiway' ? 23 : 15)) / 2 + 5 && d < best) { best = d; res.twy = f.ref || (f.t === 'taxilane' ? 'TAXILANE' : 'TWY'); } }
      else if (f.t === 'apron' && f.closed && inPoly(o.x, o.y, f.xy)) res.apron = true;
      else if ((f.t === 'parking_position' || f.t === 'gate') && lineD(o.x, o.y, f.xy) < 30) res.stand = f.ref || f.name || 'STAND';
      else if (f.t === 'holding_position' && lineD(o.x, o.y, f.xy) < 45) res.hold = f.ref || 'HOLD';
    });
    return res;
  }
  // Boeing 777-300ER silhouette in metres (x right, y forward), 73.9 m x 64.8 m
  const B777 = { fus: [[0, 37], [1.8, 36], [2.9, 31], [3.1, 22], [3.1, -22], [2.4, -31], [1, -37], [-1, -37], [-2.4, -31], [-3.1, -22], [-3.1, 22], [-2.9, 31], [-1.8, 36]], wing: [[3, 9], [32.4, -11.5], [32.4, -14.2], [3, -7]], tail: [[2.2, -29], [12.6, -36], [12.6, -38.6], [1.4, -34]], eng: [[12.5, 3], [12.5, -4.5]], eng2: [[22.5, -3], [22.5, -10]] };
  function drawB777(g, ppm, hdgRad) {
    g.save(); g.rotate(hdgRad); g.scale(ppm, -ppm); g.fillStyle = '#e9eef2'; g.strokeStyle = '#06090c'; g.lineWidth = 1 / ppm;
    const poly = a => { g.beginPath(); a.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); g.stroke(); };
    [1, -1].forEach(s => { poly(B777.wing.map(([x, y]) => [x * s, y])); poly(B777.tail.map(([x, y]) => [x * s, y])); [B777.eng, B777.eng2].forEach(([a, b]) => { g.save(); g.fillStyle = '#9fb0bd'; g.lineWidth = 3.4; g.lineCap = 'round'; g.strokeStyle = '#9fb0bd'; g.beginPath(); g.moveTo(a[0] * s, a[1]); g.lineTo(b[0] * s, b[1]); g.stroke(); g.restore(); }); });
    poly(B777.fus); g.restore();
  }
  function placeLabel(g, txt, x, y, o = {}) { // simple collision avoidance
    for (const q of AM.label) if (Math.abs(q[0] - x) < (o.w || 24) && Math.abs(q[1] - y) < 14) return false; AM.label.push([x, y]);
    g.font = '700 ' + (o.fs || 11) + 'px system-ui,sans-serif'; const w = g.measureText(txt).width + 8;
    g.fillStyle = o.bg || '#f2c200'; g.beginPath(); g.rect(x - w / 2, y - 8, w, 16); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke(); g.fillStyle = o.fg || '#000'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, x, y + .5); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; return true;
  }
  function drawAirport(g, W, H, cx, cy, ppm, rot, o, hdg) {
    const cr = Math.cos(rot), sr = Math.sin(rot), P = (x, y) => { const dx = x - o.x, dy = y - o.y; return [cx + (dx * cr - dy * sr) * ppm, cy - (dx * sr + dy * cr) * ppm]; };
    const vis = f => { const [x, y] = P(f.cx, f.cy), r = f.ext * ppm + 40; return x > -r && x < W + r && y > -r && y < H + r; };
    const path = (f, close) => { g.beginPath(); f.xy.forEach(([x, y], i) => { const [sx, sy] = P(x, y); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); }); if (close) g.closePath(); };
    const L = AM.all.filter(vis); AM.label = []; g.lineJoin = 'round'; const detail = ppm > .08;
    const cduRwy = safe(() => (fmc() || {}).rwy, '') || '';
    // aprons, buildings
    L.forEach(f => { if (f.t === 'apron' && f.closed) { path(f, true); g.fillStyle = '#242a31'; g.fill(); g.strokeStyle = '#38424c'; g.lineWidth = 1; g.stroke(); } });
    L.forEach(f => { if ((f.t === 'terminal' || f.t === 'hangar') && f.closed) { path(f, true); g.fillStyle = f.t === 'terminal' ? '#4d4036' : '#3a3f45'; g.fill(); g.strokeStyle = '#7b6a5a'; g.stroke(); if (detail && f.name && ppm > .2) { const [x, y] = P(f.cx, f.cy); g.fillStyle = '#d9c8b5'; g.font = '600 10px system-ui'; g.textAlign = 'center'; g.fillText(f.name.slice(0, 22), x, y); g.textAlign = 'left'; } } });
    // extended centrelines
    L.forEach(f => { if (f.t !== 'runway' || f.xy.length < 2 || ppm * 1852 > 600) return; const a = f.xy[0], b = f.xy[f.xy.length - 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, hi = cduRwy && f.ref.split('/').some(r => r.trim() === cduRwy);
      g.strokeStyle = hi ? '#27c6d9' : '#2c4358'; g.lineWidth = hi ? 1.6 : 1; g.setLineDash([8, 8]);
      [[a, -1], [b, 1]].forEach(([e, s]) => { const [x0, y0] = P(e[0], e[1]), [x1, y1] = P(e[0] + ux * s * 9260, e[1] + uy * s * 9260); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); for (let n = 1; n <= 5; n++) { const [tx, ty] = P(e[0] + ux * s * 1852 * n, e[1] + uy * s * 1852 * n); g.beginPath(); g.arc(tx, ty, 2, 0, 6.3); g.stroke(); } }); g.setLineDash([]); });
    // taxiways / taxilanes
    L.forEach(f => { if ((f.t === 'taxiway' || f.t === 'taxilane') && ppm > .004) { const w = f.w || (f.t === 'taxiway' ? 23 : 14); path(f, false); g.lineCap = 'round'; g.strokeStyle = '#4b555f'; g.lineWidth = Math.max(2, w * ppm); g.stroke(); } });
    L.forEach(f => { if ((f.t === 'taxiway' || f.t === 'taxilane') && ppm > .16) { path(f, false); g.strokeStyle = '#d6b320'; g.lineWidth = Math.max(1, .25 * ppm); g.stroke(); } });
    // runways
    L.forEach(f => { if ((f.t === 'runway' || f.t === 'stopway') && f.xy.length > 1) {
      const w = f.w || (f.t === 'runway' ? 45 : 30), hi = cduRwy && f.ref.split('/').some(r => r.trim() === cduRwy); g.lineCap = 'butt';
      path(f, false); g.strokeStyle = hi ? '#27c6d9' : '#a8b4be'; g.lineWidth = Math.max(3, w * ppm + 3); g.stroke(); path(f, false); g.strokeStyle = f.t === 'stopway' ? '#3a4249' : '#1b2025'; g.lineWidth = Math.max(2, w * ppm); g.stroke();
      if (f.t === 'runway' && w * ppm > 5) { path(f, false); g.strokeStyle = '#e8eef2'; g.lineWidth = Math.max(1, .9 * ppm); g.setLineDash([30 * ppm, 20 * ppm]); g.stroke(); g.setLineDash([]); }
      if (f.t === 'runway') { const a = f.xy[0], b = f.xy[f.xy.length - 1], dxm = b[0] - a[0], dym = b[1] - a[1], len = Math.hypot(dxm, dym) || 1, bear = (Math.atan2(dxm, dym) / RAD + 360) % 360, parts = (f.ref || '').split('/').map(s => s.trim()).filter(Boolean);
        if (parts.length === 2) { const n0 = parseInt(parts[0], 10) * 10, d0 = Math.abs(((n0 - bear + 540) % 360) - 180), d1 = Math.abs(((parseInt(parts[1], 10) * 10 - bear + 540) % 360) - 180), s = d0 <= d1 ? [parts[0], parts[1]] : [parts[1], parts[0]];
          if (len * ppm > 60) { [[a, s[0], 1], [b, s[1], -1]].forEach(([e, t, dir]) => { const [x, y] = P(e[0] + dxm / len * dir * Math.max(40, 30), e[1] + dym / len * dir * Math.max(40, 30)); placeLabel(g, t, x, y, { bg: hi ? '#27c6d9' : '#e8eef2', fg: '#000', fs: 12, w: 30 }); }); }
          else { const [x, y] = P(f.cx, f.cy); placeLabel(g, parts.join('/'), x, y, { bg: '#e8eef2', w: 50 }); } } } } });
    // taxiway labels
    if (S.mapLbl && ppm > .03) L.forEach(f => { if ((f.t === 'taxiway') && f.ref && f.xy.length > 1) { const m = f.xy[Math.floor(f.xy.length / 2)], [x, y] = P(m[0], m[1]); if (x > 0 && x < W && y > 0 && y < H) placeLabel(g, f.ref, x, y); } });
    // gates, stands, hold-short
    L.forEach(f => { if (f.t === 'holding_position' && ppm > .05) { const [x, y] = P(f.xy[0][0], f.xy[0][1]); g.fillStyle = '#e03a2e'; g.beginPath(); g.arc(x, y, Math.max(3, 4 * ppm), 0, 6.3); g.fill(); if (S.mapLbl && ppm > .3 && f.ref) placeLabel(g, f.ref, x, y - 14, { bg: '#e03a2e', fg: '#fff', fs: 10, w: 28 }); } });
    L.forEach(f => { if ((f.t === 'parking_position' || f.t === 'gate') && ppm > .12) { const [x, y] = P(f.cx, f.cy); g.fillStyle = f.t === 'gate' ? '#3da0ff' : '#58606a'; g.strokeStyle = '#000'; const r = Math.max(2.5, 3.2 * ppm); g.beginPath(); g.rect(x - r, y - r, r * 2, r * 2); g.fill(); g.stroke(); if (S.mapLbl && ppm > .5 && (f.ref || f.name)) placeLabel(g, (f.ref || f.name).slice(0, 8), x, y + r + 9, { bg: '#1b3a57', fg: '#cde8ff', fs: 9, w: 26 }); } });
    L.forEach(f => { if (f.t === 'helipad' && ppm > .1) { const [x, y] = P(f.cx, f.cy); g.strokeStyle = '#e0b020'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, Math.max(5, 9 * ppm), 0, 6.3); g.stroke(); g.fillStyle = '#e0b020'; g.font = '700 10px system-ui'; g.fillText('H', x - 3, y + 4); } });
  }
  APPS.map = {
    name: 'MAP', icon: '🗺',
    render(el) {
      el.innerHTML = `<div class="map"><canvas id="gfe-cv"></canvas><div class="mbar"><button data-m="out">RANGE +</button><button data-m="in">RANGE −</button><button data-m="north">NORTH UP</button><button data-m="ctr">CENTRE</button><button data-m="apt">AIRPORT</button><button data-m="auto">AUTO ZOOM</button><button data-m="lbl">LABELS</button><button data-m="clr">CLR TRAIL</button></div><div class="mtxt" id="gfe-mtxt"></div></div>`;
      const cv = $('#gfe-cv', el), ptr = new Map(); let g0 = null;
      el.onclick = e => {
        const b = e.target.closest('[data-m]'); if (!b) return; const m = b.dataset.m, i = RANGES.findIndex(r => r >= S.range - 1e-6);
        if (m === 'out') S.range = RANGES[clamp((i < 0 ? RANGES.length - 1 : i) + 1, 0, RANGES.length - 1)];
        if (m === 'in') S.range = RANGES[clamp((i < 0 ? RANGES.length - 1 : i) - 1, 0, RANGES.length - 1)];
        if (m === 'north') S.north = !S.north; if (m === 'clr') trail.length = 0; if (m === 'ctr') { AM.pan.x = 0; AM.pan.y = 0; }
        if (m === 'apt') S.mapApt = !S.mapApt; if (m === 'auto') S.mapAuto = !S.mapAuto; if (m === 'lbl') S.mapLbl = !S.mapLbl;
        save(); this.tick(el);
      };
      // drag to pan, pinch to zoom, tap to identify
      cv.addEventListener('pointerdown', e => { try { cv.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } ptr.set(e.pointerId, [e.clientX, e.clientY]); g0 = { t: Date.now(), x: e.clientX, y: e.clientY, moved: 0, d: null }; if (ptr.size === 2) { const [a, b] = [...ptr.values()]; g0.d = Math.hypot(a[0] - b[0], a[1] - b[1]); g0.r = S.range; } });
      cv.addEventListener('pointermove', e => { if (!ptr.has(e.pointerId)) return; const pr = ptr.get(e.pointerId); const dx = e.clientX - pr[0], dy = e.clientY - pr[1]; ptr.set(e.pointerId, [e.clientX, e.clientY]);
        if (ptr.size === 2 && g0 && g0.d) { const [a, b] = [...ptr.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); S.range = clamp(g0.r * g0.d / Math.max(20, d), .05, 640); g0.moved = 99; }
        else if (ptr.size === 1 && g0) { AM.pan.x += dx; AM.pan.y += dy; g0.moved += Math.abs(dx) + Math.abs(dy); } });
      const up = e => { const had = ptr.delete(e.pointerId); if (had && g0 && ptr.size === 0 && g0.moved < 8 && Date.now() - g0.t < 400) { const r = cv.getBoundingClientRect(); AM.tap = [e.clientX - r.left, e.clientY - r.top]; } if (ptr.size === 0) { save(); g0 = null; } };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      cv.addEventListener('wheel', e => { e.preventDefault(); S.range = clamp(S.range * (e.deltaY > 0 ? 1.15 : 1 / 1.15), .05, 640); }, { passive: false });
      this.tick(el);
    },
    tick(el) {
      const cv = $('#gfe-cv', el); if (!cv) return;
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      g.fillStyle = '#05080b'; g.fillRect(0, 0, W, H);
      const p = pos(), v = V(), hdg = ((v.heading360 != null ? v.heading360 : v.heading) || 0) % 360, ground = onGround(v);
      const bt = $$('[data-m]', el); bt.forEach(b => { const m = b.dataset.m; b.classList.toggle('on', (m === 'apt' && S.mapApt) || (m === 'auto' && S.mapAuto) || (m === 'lbl' && S.mapLbl) || (m === 'north' && S.north)); });
      if (AM.wasG !== null && AM.wasG !== ground && S.mapAuto) { if (ground && S.range > 1) S.range = .5; if (!ground && S.range < 5) S.range = 10; AM.pan.x = AM.pan.y = 0; } AM.wasG = ground;
      const cx0 = W / 2, cy0 = H * .56, R = Math.min(W / 2, cy0) * .92, sc = R / S.range, rot = S.north ? 0 : hdg * RAD;
      const cx = cx0 + AM.pan.x, cy = cy0 + AM.pan.y;
      const proj = q => { const dx = (q.lon - p.lon) * Math.cos(p.lat * RAD) * 60, dy = (q.lat - p.lat) * 60; return [cx + (dx * Math.cos(rot) - dy * Math.sin(rot)) * sc, cy - (dx * Math.sin(rot) + dy * Math.cos(rot)) * sc]; };
      if (!p) { g.fillStyle = '#ffbf47'; g.font = '14px system-ui'; g.fillText('NO POSITION DATA', W / 2 - 60, H / 2); return; }
      // airport layer
      let airportOn = false, me = null, here = null;
      if (S.mapApt && S.range <= 10) { need(p, S.range); rebuild(p); me = toXY(p); airportOn = AM.all.length > 0; if (airportOn) { drawAirport(g, W, H, cx, cy, sc / 1852, rot, me, hdg); if (Date.now() - AM.onT > 400) { AM.on = whereAmI(me); AM.onT = Date.now(); } here = AM.on; } }
      // range rings + compass (only when no pan, to keep the airport clean)
      g.strokeStyle = '#2c3a46'; g.lineWidth = 1; g.fillStyle = '#6c8294'; g.font = '11px system-ui,sans-serif';
      [.5, 1].forEach(f => { g.beginPath(); g.arc(cx0, cy0, R * f, 0, Math.PI * 2); g.stroke(); g.fillText((+(S.range * f).toFixed(2)) + ' NM', cx0 + 4, cy0 - R * f + 12); });
      for (let a = 0; a < 360; a += 30) { const r2 = (a * RAD) - rot; g.beginPath(); g.moveTo(cx0 + Math.sin(r2) * R, cy0 - Math.cos(r2) * R); g.lineTo(cx0 + Math.sin(r2) * (R + 7), cy0 - Math.cos(r2) * (R + 7)); g.stroke(); g.fillText(a === 0 ? 'N' : String(a / 10), cx0 + Math.sin(r2) * (R + 16) - 6, cy0 - Math.cos(r2) * (R + 16) + 4); }
      // trail
      g.strokeStyle = '#3a86c8'; g.lineWidth = 1.5; g.beginPath(); trail.forEach((q, i) => { const [x, y] = proj(q); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
      // flight plan
      const { legs, active } = planLegs();
      if (legs.length) {
        g.lineWidth = 2; g.strokeStyle = '#ff5cf0'; g.fillStyle = '#ff5cf0'; g.font = '11px system-ui';
        g.beginPath(); legs.forEach((w, i) => { if (i < active) return; const [x, y] = proj(w); (i === active) ? (g.moveTo(cx, cy), g.lineTo(x, y)) : g.lineTo(x, y); }); g.stroke();
        legs.forEach((w, i) => { const [x, y] = proj(w); if (x < -20 || y < -20 || x > W + 20 || y > H + 20) return; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); g.fillStyle = i === active ? '#ff5cf0' : '#b8a0b5'; g.fill(); g.fillStyle = '#ff9af6'; g.fillText(w.id, x + 7, y - 6); });
      }
      // ownship: to-scale 777 when big enough, chevron otherwise
      g.save(); g.translate(cx, cy); const ppm = sc / 1852;
      if (ppm * 74 > 26) drawB777(g, ppm, S.north ? hdg * RAD : 0);
      else { g.rotate(S.north ? hdg * RAD : 0); g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, -12); g.lineTo(8, 10); g.lineTo(0, 5); g.lineTo(-8, 10); g.closePath(); g.fill(); g.stroke(); }
      g.restore();
      if (ppm * 74 <= 26 || !airportOn) { g.strokeStyle = '#fff3'; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(S.north ? hdg * RAD : 0) * R, cy - Math.cos(S.north ? hdg * RAD : 0) * R); g.stroke(); }
      // tap to identify
      if (AM.tap && airportOn) { const [tx, ty] = AM.tap; AM.tap = null; const cr = Math.cos(rot), sr = Math.sin(rot); let bf = null, bd = 28;
        AM.all.forEach(f => { if (!(f.ref || f.name)) return; const pts = f.xy.length > 1 && f.t !== 'apron' ? f.xy : [[f.cx, f.cy]]; pts.forEach(([x, y]) => { const dx = x - me.x, dy = y - me.y, sx = cx + (dx * cr - dy * sr) * ppm, sy = cy - (dx * sr + dy * cr) * ppm, d = Math.hypot(sx - tx, sy - ty); if (d < bd) { bd = d; bf = f; } }); });
        AM.sel = bf ? `${bf.t.replace('_', ' ').toUpperCase()} ${bf.ref || bf.name}${bf.w ? ' · ' + bf.w + ' m' : ''}` : null; AM.selT = Date.now(); }
      if (AM.sel && Date.now() - AM.selT > 6000) AM.sel = null;
      const w = legs[active], tx2 = $('#gfe-mtxt', el);
      const onTxt = here ? [here.rwy ? `<b class="m">ON RWY ${esc(here.rwy)}</b>` : '', here.twy && !here.rwy ? `<b class="m">ON TWY ${esc(here.twy)}</b>` : '', here.stand ? `<b class="m">STAND ${esc(here.stand)}</b>` : '', here.hold && ground ? `<b class="m">HOLD ${esc(here.hold)} NEARBY</b>` : '', here.apron && !here.twy && !here.rwy && !here.stand ? 'APRON' : ''].filter(Boolean).join(' · ') : '';
      if (tx2) tx2.innerHTML = `<b>${S.north ? 'N UP' : 'HDG UP'}</b> ${+S.range.toFixed(2)} NM · HDG ${pad(Math.round(hdg), 3)}° · GS ${Math.round(gsKt())} · ALT ${Math.round(v.altitude || 0)}${w ? ` · TO <b class="m">${esc(w.id)}</b> ${Math.round(gcd(p, w))} NM ${pad(Math.round(brg(p, w)), 3)}°` : ''}${onTxt ? '<br>' + onTxt : ''}${AM.sel ? '<br>SELECTED: <b>' + esc(AM.sel) + '</b>' : ''}<br><span class="dim">${S.mapApt ? (S.range > 10 ? 'Zoom in to ≤10 NM for airport layout' : AM.status) : 'Airport layer off'} · drag = pan · pinch = zoom · tap = identify · © OpenStreetMap contributors</span>`;
    },
  };

  /* ---- CHECKLISTS ---- */
  const eq = (a, b) => (a === undefined ? undefined : a === b);
  const allOn = ks => { const v = ks.map(sw); return v.some(x => x === undefined) ? undefined : v.every(x => x); };
  const LX = () => safe(() => LO().state, null);
  const CHK = {
    'PREFLIGHT': [['Battery', 'ON', () => eq(sw('batt'), 1)], ['Standby power', 'AUTO', () => eq(sw('stby'), 1)], ['Electrical power', 'AVAILABLE', () => safe(() => OV().sim.bus, undefined)], ['Fuel pumps', 'ON', () => allOn(['fLF', 'fLA', 'fRF', 'fRA', 'fCL', 'fCR'])], ['Hydraulic demand pumps', 'AUTO', () => safe(() => sw('hydC1') >= 1 && sw('hydC2') >= 1, undefined)], ['Fire panel', 'NORMAL', () => safe(() => !sw('fireL') && !sw('fireR') && !sw('fireA'), undefined)], ['Parking brake', 'SET', () => parkSet()], ['FMC route / performance', 'PROGRAMMED', () => safe(() => !!fmc().rteActive, undefined)], ['Altimeters / baro', 'SET', null]],
    'BEFORE START': [['Seat belt sign', 'ON', () => eq(sw('belts'), 2)], ['Beacon', 'ON', () => eq(sw('beacon'), 1)], ['Fuel pumps', 'ON', () => allOn(['fLF', 'fLA', 'fRF', 'fRA', 'fCL', 'fCR'])], ['Takeoff speeds', 'SET', null], ['Parking brake', 'SET', () => parkSet()], ['Doors / ground equipment', 'CLOSED / CLEAR', null], ['Pushback / start clearance', 'OBTAINED', null]],
    'AFTER START': [['Engines', 'RUNNING', () => engRun()], ['Generators', 'ON', () => allOn(['genL', 'genR'])], ['Hydraulics', 'NORMAL', null], ['Packs / bleeds', 'ON', () => allOn(['packL', 'packR', 'bleedL', 'bleedR'])], ['Anti-ice', 'AS REQUIRED', null], ['Flight controls', 'CHECKED', null], ['Ground equipment', 'CLEAR', null]],
    'BEFORE TAXI': [['Flaps', 'SET FOR TAKEOFF', () => flapIdx() > 0], ['Taxi light', 'ON', () => eq(sw('taxi'), 1)], ['Autobrake', 'RTO', () => eq(sw('abrk'), 0)], ['Parking brake', 'RELEASED', () => !parkSet()], ['Taxi clearance', 'OBTAINED', null]],
    'BEFORE TAKEOFF': [['Flaps', 'SET', () => flapIdx() > 0], ['Autobrake', 'RTO', () => eq(sw('abrk'), 0)], ['Transponder', 'TA/RA', () => safe(() => LX().xp.mode === 4, undefined)], ['Landing / strobe lights', 'ON', () => allOn(['ldgL', 'ldgR', 'nose'])], ['Speedbrake', 'ARMED', () => safe(() => !!LX().sbArm, undefined)], ['Parking brake', 'RELEASED', () => !parkSet()], ['Takeoff briefing / clearance', 'DONE', null]],
    'AFTER TAKEOFF': [['Landing gear', 'UP', () => gearPos() < .03], ['Flaps', 'UP', () => flapIdx() === 0], ['Autopilot', 'AS REQUIRED', null], ['Altimeters', 'STD ABOVE TRANSITION', () => safe(() => !!LX().baro.std, undefined)], ['Taxi light', 'OFF', () => eq(sw('taxi'), 0)]],
    'DESCENT': [['Altimeters', 'QNH SET', () => safe(() => !LX().baro.std, undefined)], ['Landing data / VREF', 'SET', null], ['Autobrake', 'SET', () => safe(() => sw('abrk') >= 2, undefined)], ['Seat belt sign', 'ON', () => eq(sw('belts'), 2)], ['Approach briefing', 'DONE', null]],
    'LANDING': [['Landing gear', 'DOWN', () => gearPos() > .97], ['Flaps', 'SET', () => flapIdx() > 0], ['Speedbrake', 'ARMED', () => safe(() => !!LX().sbArm || V().airbrakesPosition > .5, undefined)], ['Landing lights', 'ON', () => allOn(['ldgL', 'ldgR', 'nose'])], ['Autobrake', 'SET', () => safe(() => sw('abrk') >= 2, undefined)], ['Cleared to land', 'CONFIRMED', null]],
    'SHUTDOWN': [['Parking brake', 'SET', () => parkSet()], ['Engines', 'SHUT DOWN', () => !engRun()], ['Fuel control', 'CUTOFF', () => (sw('fctlL') === 0 && sw('fctlR') === 0)], ['Seat belt sign', 'OFF', () => eq(sw('belts'), 0)], ['Beacon', 'OFF', () => eq(sw('beacon'), 0)], ['Exterior lights', 'OFF', () => safe(() => !sw('ldgL') && !sw('nose') && !sw('taxi'), undefined)], ['Packs', 'OFF', () => safe(() => !sw('packL') && !sw('packR'), undefined)]],
    'SECURE': [['APU / external power', 'OFF', () => safe(() => !sw('apu'), undefined)], ['Fuel pumps', 'OFF', () => safe(() => !PU_ANY(), undefined)], ['Battery', 'OFF', () => eq(sw('batt'), 0)], ['Flight deck', 'SECURE', null]],
  };
  const PU_ANY = () => ['fLF', 'fLA', 'fRF', 'fRA', 'fCL', 'fCR'].some(k => sw(k));
  const autoOf = it => { // undefined = manual / can't tell (needed script not installed)
    if (!it[2]) return undefined; const src = it[2].toString();
    if ((/sw\(|allOn\(|OV\(\)/.test(src)) && !OV()) return undefined;
    if (/LX\(\)/.test(src) && !LO()) return undefined;
    return safe(it[2], undefined);
  };
  const chkState = l => (S.chk[l] = S.chk[l] || {});
  APPS.chk = {
    name: 'CHECKLISTS', icon: '☑',
    render(el) {
      const names = Object.keys(CHK);
      el.innerHTML = `<div class="chk"><div class="tabs">${names.map(n => `<button data-l="${n}">${n}</button>`).join('')}</div><div id="gfe-cl"></div>
        <div class="row"><button data-c="auto">AUTO-TICK MATCHING</button><button data-c="reset">RESET LIST</button><button data-c="next">NEXT LIST ▶</button></div>
        <div class="note">Generic sim checklists (not Boeing FCOM). ● green = matches panel · ● amber = doesn't · no dot = manual</div></div>`;
      el.onclick = e => {
        const b = e.target.closest('button,li'); if (!b) return;
        const st = chkState(S.list);
        if (b.dataset.l) S.list = b.dataset.l;
        else if (b.dataset.c === 'reset') S.chk[S.list] = {};
        else if (b.dataset.c === 'next') S.list = names[(names.indexOf(S.list) + 1) % names.length];
        else if (b.dataset.c === 'auto') CHK[S.list].forEach((it, i) => { if (autoOf(it) === true) st[i] = true; });
        else if (b.dataset.i != null) st[b.dataset.i] = !st[b.dataset.i];
        save(); this.tick(el);
      };
      this.tick(el);
    },
    tick(el) {
      const box = $('#gfe-cl', el); if (!box) return; const st = chkState(S.list), items = CHK[S.list];
      $$('.tabs button', el).forEach(b => b.classList.toggle('on', b.dataset.l === S.list));
      const done = items.filter((_, i) => st[i]).length;
      box.innerHTML = `<h3>${esc(S.list)} <small>${done}/${items.length}${done === items.length ? ' · COMPLETE' : ''}</small></h3><ul>${items.map((it, i) => {
        const a = autoOf(it);
        return `<li data-i="${i}" class="${st[i] ? 'ok' : ''}"><span class="bx">${st[i] ? '✓' : ''}</span><span class="t">${esc(it[0])}</span><span class="d"></span><span class="a">${esc(it[1])}</span><span class="dot ${a === true ? 'g' : a === false ? 'a' : ''}"></span></li>`;
      }).join('')}</ul>`;
    },
  };

  /* ---- PERFORMANCE (approximate) ---- */
  const perfCalc = P => {
    const vr = Math.round(140 + (P.tow - 250) * .25 + (P.flaps === 5 ? 8 : P.flaps === 20 ? -4 : 0));
    const vref30 = Math.round(134 + (P.lw - 200) * .32), vref = P.lflap === 25 ? vref30 + 5 : vref30;
    const dRad = (P.wd - P.rwy) * RAD, hw = P.ws * Math.cos(dRad), xw = P.ws * Math.sin(dRad);
    const isa = 15 - 1.98 * P.elev / 1000, dev = P.oat - isa;
    const fl = P.flaps === 5 ? 1.08 : P.flaps === 20 ? .95 : 1;
    const wind = clamp(1 - .01 * hw, .75, 1.35);
    const tod = 2900 * Math.pow(Math.max(P.tow, 100) / 300, 1.8) * (1 + .012 * Math.max(dev, -15)) * (1 + .045 * P.elev / 1000) * fl * wind;
    const lfl = 1700 * Math.pow(Math.max(P.lw, 100) / 230, 1.6) * (1 + .025 * P.elev / 1000) * clamp(1 - .012 * hw, .8, 1.4);
    return { v1: vr - 6, vr, v2: vr + 7, vref, vapp: vref + 5, hw, xw, tod, lfl, dev };
  };
  APPS.perf = {
    name: 'PERFORMANCE', icon: '✈',
    render(el) {
      el.innerHTML = `<div class="pf"><h3>TAKEOFF</h3><div class="fg">${field('tow', 'TOW', 't', 'perf')}${field('flaps', 'FLAPS', '5/15/20', 'perf')}${field('oat', 'OAT', '°C', 'perf')}${field('elev', 'ELEV', 'ft', 'perf')}${field('wd', 'WIND DIR', '°', 'perf')}${field('ws', 'WIND SPD', 'kt', 'perf')}${field('rwy', 'RWY HDG', '°', 'perf')}${field('len', 'RWY LEN', 'm', 'perf')}</div>
        <div class="out" id="gfe-pt"></div><h3>LANDING</h3><div class="fg">${field('lw', 'LDG WT', 't', 'perf')}${field('lflap', 'FLAPS', '25/30', 'perf')}${field('lrwy', 'RWY LEN', 'm', 'perf')}</div><div class="out" id="gfe-pl"></div>
        <div class="row"><button data-c="live">USE CURRENT POSITION / WIND DATA</button><button data-c="cdu">SEND V-SPEED INPUTS TO CDU</button></div>
        <div class="note">APPROXIMATE estimates for a 777-300ER. Wind components are exact; speeds and distances are not Boeing data.</div></div>`;
      bindFields(el, () => this.tick(el));
      el.onclick = e => {
        const b = e.target.closest('[data-c]'); if (!b) return;
        if (b.dataset.c === 'live') { const v = V(); S.perf.elev = Math.round(v.groundElevationFeet || v.altitude || 0); S.perf.rwy = Math.round(((v.heading360 != null ? v.heading360 : v.heading) || 0) % 360); save(); bindFields(el, () => this.tick(el)); }
        if (b.dataset.c === 'cdu') { const f = fmc(); if (!f) { alert('Install the Lower Panel script to use this.'); return; } f.fuel = Math.max(0, S.perf.tow - f.zfw); f.flaps = [5, 15, 20].includes(S.perf.flaps) ? S.perf.flaps : 15; f.v1 = f.vr = f.v2 = null; }
        this.tick(el);
      };
      this.tick(el);
    },
    tick(el) {
      const P = S.perf, r = perfCalc(P), col = x => (x ? 'ok' : 'bad');
      $('#gfe-pt', el).innerHTML = `<div><b>V1</b> ${r.v1} <b>VR</b> ${r.vr} <b>V2</b> ${r.v2}</div><div>HEADWIND <b>${r.hw.toFixed(0)}</b> kt · X-WIND <b class="${Math.abs(r.xw) > 38 ? 'bad' : ''}">${Math.abs(r.xw).toFixed(0)}</b> kt ${r.xw >= 0 ? 'from right' : 'from left'} · ISA ${r.dev >= 0 ? '+' : ''}${r.dev.toFixed(0)}</div>
        <div>EST. TAKEOFF RUN <b class="${col(r.tod * 1.15 <= P.len)}">${Math.round(r.tod)} m</b> vs ${P.len} m <span class="dim">(15% margin ${r.tod * 1.15 <= P.len ? 'OK' : 'NOT MET'})</span></div>`;
      $('#gfe-pl', el).innerHTML = `<div><b>VREF</b> ${r.vref} · <b>VAPP</b> ${r.vapp} <span class="dim">(+5 kt)</span></div><div>EST. LANDING DISTANCE <b class="${col(r.lfl * 1.67 <= P.lrwy)}">${Math.round(r.lfl)} m</b> dry · factored ×1.67 = ${Math.round(r.lfl * 1.67)} m vs ${P.lrwy} m</div>`;
    },
  };

  /* ---- WEATHER ---- */
  const parseMetar = t => {
    const w = /\b(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(t), q = /\bQ(\d{4})\b/.exec(t), a = /\bA(\d{4})\b/.exec(t);
    return { wind: w ? { dir: w[1] === 'VRB' ? null : +w[1], spd: +w[2], gust: w[3] ? +w[3] : null } : null, qnh: q ? +q[1] : a ? Math.round(+a[1] / 100 * 33.8639) : null };
  };
  APPS.wx = {
    name: 'WEATHER', icon: '☁',
    render(el) {
      const f = fmc() || {};
      el.innerHTML = `<div class="wx"><div class="row"><input id="gfe-icao" maxlength="4" placeholder="ICAO" autocapitalize="characters" inputmode="text" aria-label="Airport ICAO"><button data-w="metar">METAR</button><button data-w="taf">TAF</button></div>
        <div class="row">${f.orig ? `<button data-i="${esc(f.orig)}">ORIG ${esc(f.orig)}</button>` : ''}${f.dest ? `<button data-i="${esc(f.dest)}">DEST ${esc(f.dest)}</button>` : ''}${f.altn ? `<button data-i="${esc(f.altn)}">ALTN ${esc(f.altn)}</button>` : ''}</div>
        <pre id="gfe-wxo">Enter an ICAO code and tap METAR or TAF.\nData: aviationweather.gov (real-world weather; GeoFS weather is separate).</pre><div class="row" id="gfe-wxa"></div></div>`;
      const inp = $('#gfe-icao', el); inp.value = S.wx.icao || '';
      inp.addEventListener('keydown', e => e.stopPropagation()); inp.addEventListener('keyup', e => e.stopPropagation());
      el.onclick = async e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.i) { inp.value = b.dataset.i; S.wx.icao = b.dataset.i; save(); return; }
        const id = inp.value.trim().toUpperCase(); if (!/^[A-Z0-9]{3,4}$/.test(id)) { $('#gfe-wxo', el).textContent = 'Enter a valid ICAO identifier.'; return; }
        S.wx.icao = id; save();
        if (b.dataset.q) { const st = LX(); if (st) { st.baro.qnh = +b.dataset.q; st.baro.std = false; $('#gfe-wxo', el).textContent += '\n\nQNH ' + b.dataset.q + ' sent to the Lower Panel altimeter setting.'; } return; }
        if (!b.dataset.w) return;
        const url = `https://aviationweather.gov/api/data/${b.dataset.w}?ids=${id}&format=raw`, out = $('#gfe-wxo', el), act = $('#gfe-wxa', el);
        out.textContent = 'Fetching ' + b.dataset.w.toUpperCase() + ' for ' + id + '…'; act.innerHTML = '';
        try {
          const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
          const t = (await r.text()).trim(); out.textContent = t || 'No ' + b.dataset.w.toUpperCase() + ' available for ' + id + '.';
          if (t && b.dataset.w === 'metar') { const m = parseMetar(t); let h = ''; if (m.qnh) h += `<button data-q="${m.qnh}">SET QNH ${m.qnh} hPa</button>`; if (m.wind && m.wind.dir != null) h += `<button data-wind="${m.wind.dir},${m.wind.spd}">USE WIND ${pad(m.wind.dir, 3)}/${m.wind.spd} IN PERF</button>`; act.innerHTML = h; }
        } catch (err) { out.innerHTML = `Couldn't fetch (${esc(err.message)}) — the request may be blocked by the browser or you're offline.<br><a href="${esc(url)}" target="_blank" rel="noopener">Open in a new tab</a>`; }
      };
      el.addEventListener('click', e => { const b = e.target.closest('[data-wind]'); if (b) { const [d, s] = b.dataset.wind.split(',').map(Number); S.perf.wd = d; S.perf.ws = s; save(); b.textContent = 'WIND SENT TO PERFORMANCE'; } });
    },
  };

  /* ---- FLIGHT LOG ---- */
  APPS.log = {
    name: 'FLIGHT LOG', icon: '⏱',
    render(el) {
      el.innerHTML = `<div class="lg"><div id="gfe-lg"></div><div class="row"><button data-c="reset">NEW LEG (RESET)</button></div><div class="note">OOOI is detected automatically: OUT = brake released and moving, OFF = airborne, ON = touchdown, IN = stopped with brake set. Works while the EFB is closed.</div></div>`;
      el.onclick = e => { if (e.target.closest('[data-c=reset]')) { S.log = LOG0(); wasAir = false; save(); this.tick(el); } };
      this.tick(el);
    },
    tick(el) {
      const L = S.log, box = $('#gfe-lg', el); if (!box) return;
      const td = L.td, rate = td == null ? '' : Math.abs(td) < 150 ? 'SMOOTH' : Math.abs(td) < 300 ? 'NORMAL' : Math.abs(td) < 500 ? 'FIRM' : 'HARD';
      box.innerHTML = `<div class="oooi">${[['OUT', L.out], ['OFF', L.off], ['ON', L.on], ['IN', L.inn]].map(([k, t]) => `<div><span>${k}</span><b>${t ? utcTime(t).slice(0, 5) + 'Z' : '--:--'}</b></div>`).join('')}</div>
        <table><tr><td>BLOCK TIME</td><td>${L.out ? hm((L.inn || Date.now()) - L.out) : '--:--'}</td></tr><tr><td>AIR TIME</td><td>${L.off ? hm((L.on || Date.now()) - L.off) : '--:--'}</td></tr>
        <tr><td>DISTANCE</td><td>${Math.round(L.dist)} NM</td></tr><tr><td>MAX ALT / IAS</td><td>${Math.round(L.maxAlt)} ft / ${Math.round(L.maxIas)} kt</td></tr>
        <tr><td>TOUCHDOWN V/S</td><td>${td == null ? '---' : Math.abs(td) + ' fpm ' + rate}</td></tr></table>`;
    },
  };

  /* ---- WEIGHT & FUEL ---- */
  const LIM = { mtow: 351534, mlw: 251290, mzfw: 237680, fuelCap: 137000 };
  APPS.wb = {
    name: 'WEIGHT / FUEL', icon: '⛽',
    render(el) {
      el.innerHTML = `<div class="wb"><div class="fg">${field('oew', 'OEW', 'kg', 'wb')}${field('pay', 'PAYLOAD', 'kg', 'wb')}${field('fuel', 'BLOCK FUEL', 'kg', 'wb')}${field('dist', 'TRIP DIST', 'NM', 'wb')}</div><div class="out" id="gfe-wb"></div>
        <div class="row"><button data-c="cdu">SEND ZFW / FUEL TO CDU</button></div><div class="note">Limits: MTOW 351,534 · MLW 251,290 · MZFW 237,680 kg. Fuel planning is a rough estimate (≈7,000 kg/h, 480 kt GS) — not Boeing data. OEW varies by airframe; edit it.</div></div>`;
      bindFields(el, () => this.tick(el));
      el.onclick = e => { if (e.target.closest('[data-c=cdu]')) { const f = fmc(), w = S.wb; if (!f) { alert('Install the Lower Panel script to use this.'); return; } f.zfw = +((w.oew + w.pay) / 1000).toFixed(1); f.fuel = +(w.fuel / 1000).toFixed(1); f.v1 = f.vr = f.v2 = null; } };
      this.tick(el);
    },
    tick(el) {
      const w = S.wb, zfw = w.oew + w.pay, tow = zfw + w.fuel, hrs = w.dist / 480, trip = hrs * 7000, res = 3 * 7000 * .75 + trip * .05, req = trip + res, lw = tow - trip;
      const row = (l, v, lim) => `<tr><td>${l}</td><td class="${lim && v > lim ? 'bad' : lim ? 'ok' : ''}">${Math.round(v).toLocaleString()} kg</td><td class="dim">${lim ? 'max ' + lim.toLocaleString() : ''}</td></tr>`;
      $('#gfe-wb', el).innerHTML = `<table>${row('ZFW', zfw, LIM.mzfw)}${row('TOW', tow, LIM.mtow)}${row('EST. LDG WT', lw, LIM.mlw)}${row('BLOCK FUEL', w.fuel, LIM.fuelCap)}</table>
        <div>EST. TRIP ${hm(hrs * 3600e3)} · TRIP FUEL <b>${Math.round(trip).toLocaleString()}</b> kg · +RES/CONT <b>${Math.round(res).toLocaleString()}</b> → REQUIRED <b class="${w.fuel >= req ? 'ok' : 'bad'}">${Math.round(req).toLocaleString()}</b> kg ${w.fuel >= req ? '' : '— INSUFFICIENT'}</div>`;
    },
  };

  /* ---- CALCULATOR + CONVERTERS ---- */
  const CONV = [['kg', 'lb', x => x * 2.20462, x => x / 2.20462], ['ft', 'm', x => x * .3048, x => x / .3048], ['NM', 'km', x => x * 1.852, x => x / 1.852], ['kt', 'km/h', x => x * 1.852, x => x / 1.852], ['hPa', 'inHg', x => x / 33.8639, x => x * 33.8639], ['°C', '°F', x => x * 9 / 5 + 32, x => (x - 32) * 5 / 9], ['L Jet-A', 'kg', x => x * .8, x => x / .8], ['kt', 'm/s', x => x * .5144, x => x / .5144]];
  APPS.calc = {
    name: 'CALCULATOR', icon: '🧮',
    render(el) {
      const keys = ['7', '8', '9', '÷', 'C', '4', '5', '6', '×', '⌫', '1', '2', '3', '−', '(', '0', '.', '%', '+', ')'];
      el.innerHTML = `<div class="calc"><div class="disp"><small id="gfe-ex"></small><b id="gfe-res">0</b></div><div class="keys">${keys.map(k => `<button data-k="${k}">${k}</button>`).join('')}<button class="eq" data-k="=">=</button></div>
        <h3>CONVERTERS</h3>${CONV.map((c, i) => `<div class="cv"><input data-cv="${i},0" inputmode="decimal" aria-label="${c[0]}"><span>${c[0]}</span><b>⇄</b><input data-cv="${i},1" inputmode="decimal" aria-label="${c[1]}"><span>${c[1]}</span></div>`).join('')}</div>`;
      let ex = ''; const res = $('#gfe-res', el), exl = $('#gfe-ex', el);
      const ev = s => { // small recursive-descent parser (no eval, so it works under strict CSP)
        const t = s.replace(/÷/g, '/').replace(/×/g, '*').replace(/−/g, '-').replace(/(\d+(?:\.\d+)?)%/g, '($1/100)').replace(/\s+/g, ''); let i = 0;
        const peek = () => t[i], expr = () => { let v = term(); while (peek() === '+' || peek() === '-') v = t[i++] === '+' ? v + term() : v - term(); return v; },
          term = () => { let v = unary(); while (peek() === '*' || peek() === '/') v = t[i++] === '*' ? v * unary() : v / unary(); return v; },
          unary = () => (peek() === '-' ? (i++, -unary()) : peek() === '+' ? (i++, unary()) : atom()),
          atom = () => { if (peek() === '(') { i++; const v = expr(); if (peek() !== ')') return NaN; i++; return v; } const m = /^\d*\.?\d+|^\d+\.?/.exec(t.slice(i)); if (!m) return NaN; i += m[0].length; return parseFloat(m[0]); };
        const r = expr(); return i === t.length ? r : NaN; };
      el.onclick = e => {
        const b = e.target.closest('[data-k]'); if (!b) return; const k = b.dataset.k;
        if (k === 'C') ex = ''; else if (k === '⌫') ex = ex.slice(0, -1);
        else if (k === '=') { const r = ev(ex); exl.textContent = ex + ' ='; ex = isFinite(r) ? String(+r.toPrecision(12)) : ''; res.textContent = isFinite(r) ? ex : 'ERROR'; return; }
        else ex += k;
        exl.textContent = ''; res.textContent = ex || '0';
      };
      $$('[data-cv]', el).forEach(inp => {
        inp.addEventListener('keydown', e => e.stopPropagation()); inp.addEventListener('keyup', e => e.stopPropagation());
        inp.addEventListener('input', () => { const [i, s] = inp.dataset.cv.split(',').map(Number), x = num(inp.value), o = $(`[data-cv="${i},${1 - s}"]`, el); if (x == null) { o.value = ''; return; } const r = s === 0 ? CONV[i][2](x) : CONV[i][3](x); o.value = +r.toFixed(3); });
      });
    },
  };

  /* ---- NOTES ---- */
  APPS.notes = {
    name: 'NOTES', icon: '📝',
    render(el) {
      el.innerHTML = `<div class="nt"><textarea id="gfe-nt" placeholder="Clearances, frequencies, squawk, ATIS…" aria-label="Notes"></textarea><div class="row"><button data-c="time">INSERT UTC TIME</button><button data-c="clr">CLEAR</button></div></div>`;
      const ta = $('#gfe-nt', el); ta.value = S.notes;
      ta.addEventListener('keydown', e => e.stopPropagation()); ta.addEventListener('keyup', e => e.stopPropagation());
      ta.addEventListener('input', () => { S.notes = ta.value; save(); });
      el.onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; if (b.dataset.c === 'time') { ta.value += (ta.value && !ta.value.endsWith('\n') ? '\n' : '') + utcTime() + ' '; } else if (confirm('Clear all notes?')) ta.value = ''; S.notes = ta.value; save(); };
    },
  };

  /* ---- LINKS ---- */
  APPS.links = {
    name: 'LINKS', icon: '🔗',
    render(el) {
      const draw = () => { el.innerHTML = `<div class="ln"><p class="note">No Jeppesen/charts data is available in GeoFS. These open public sites in a new tab.</p><ul>${S.links.map(([n, u], i) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(n)}<small>${esc(u)}</small></a><button data-d="${i}" aria-label="Remove ${esc(n)}">✕</button></li>`).join('')}</ul>
        <div class="row"><input id="gfe-ln" placeholder="Name" aria-label="Link name"><input id="gfe-lu" placeholder="https://…" inputmode="url" aria-label="Link URL"><button data-c="add">ADD</button></div></div>`;
        $$('input', el).forEach(i => { i.addEventListener('keydown', e => e.stopPropagation()); i.addEventListener('keyup', e => e.stopPropagation()); }); };
      draw();
      el.onclick = e => {
        const d = e.target.closest('[data-d]'); if (d) { S.links.splice(+d.dataset.d, 1); save(); return draw(); }
        if (e.target.closest('[data-c=add]')) { const n = $('#gfe-ln', el).value.trim(), u = $('#gfe-lu', el).value.trim(); if (n && /^https?:\/\//i.test(u)) { S.links.push([n, u]); save(); draw(); } }
      };
    },
  };

  /* ───────────────────────── shell UI ───────────────────────── */
  const CSS = `
  #gfe-root,#gfe-root *{box-sizing:border-box}
  #gfe-root{position:fixed;top:0;bottom:0;z-index:99991;width:min(560px,100vw);transition:transform .38s cubic-bezier(.2,.8,.2,1);font:500 13px/1.3 system-ui,"Segoe UI",sans-serif;color:#dde4ea;
    -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;filter:brightness(var(--gfe-b,1))}
  #gfe-root.r{right:0;transform:translateX(100%)}#gfe-root.l{left:0;transform:translateX(-100%)}#gfe-root.open{transform:none}
  #gfe-tab{all:unset;position:absolute;top:50%;width:30px;height:110px;margin-top:-55px;cursor:pointer;background:linear-gradient(#3a3f44,#2a2e32);border:1px solid #0d0f11;color:#cfd6db;font:700 11px system-ui;letter-spacing:.18em;
    writing-mode:vertical-rl;text-align:center;line-height:30px;box-shadow:0 0 8px #0008}
  #gfe-root.r #gfe-tab{right:100%;border-radius:9px 0 0 9px;border-right:none;transform:rotate(180deg)}#gfe-root.l #gfe-tab{left:100%;border-radius:0 9px 9px 0;border-left:none}
  #gfe-tab:focus-visible,.gfe-b:focus-visible,#gfe-root button:focus-visible{outline:2px solid #7cc4ff;outline-offset:1px}
  .gfe-dev{height:100%;padding:calc(8px + env(safe-area-inset-top,0px)) 8px calc(8px + env(safe-area-inset-bottom,0px));}
  .gfe-bz{height:100%;background:#0a0c0f;border:9px solid #1d2125;border-radius:24px;box-shadow:0 0 0 2px #000,0 10px 40px #000c;display:flex;flex-direction:column;overflow:hidden}
  .gfe-st{display:flex;align-items:center;gap:10px;padding:7px 12px;background:#12161a;border-bottom:1px solid #000;font-size:12px}.gfe-st b{letter-spacing:.1em;color:#fff}.gfe-st .sp{flex:1}.gfe-st .tm{font:700 13px Consolas,monospace;color:#6dff9b}
  .gfe-st button{all:unset;cursor:pointer;padding:4px 9px;border-radius:5px;background:#252b31;font-size:10px;letter-spacing:.08em;color:#cfd6db}
  #gfe-view{flex:1;overflow:auto;padding:12px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:#0d1014}
  .gfe-nav{display:flex;gap:2px;padding:6px;background:#12161a;border-top:1px solid #000;overflow-x:auto}
  .gfe-nav button{all:unset;cursor:pointer;flex:0 0 auto;min-width:44px;height:40px;padding:0 10px;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;font-size:16px;color:#9fb0bd}
  .gfe-nav button small{font-size:8px;letter-spacing:.06em;margin-top:1px}.gfe-nav button.on{background:#1f3b57;color:#fff}
  #gfe-view button,#gfe-view input,#gfe-view textarea{font:inherit}
  #gfe-view button{all:unset;cursor:pointer;padding:9px 12px;border-radius:7px;background:#232a31;border:1px solid #05070a;color:#e6ecf0;font-size:11px;letter-spacing:.05em;text-align:center}
  #gfe-view button:active{transform:translateY(1px);background:#2b343c}#gfe-view button.on{background:#1f3b57;color:#fff}
  #gfe-view input,#gfe-view textarea{all:unset;box-sizing:border-box;-webkit-user-select:text;user-select:text;background:#080b0e;border:1px solid #2a333b;border-radius:6px;padding:8px 10px;color:#ffd470;font:600 14px Consolas,monospace;min-width:0}
  #gfe-view input:focus,#gfe-view textarea:focus{outline:2px solid #7cc4ff}
  #gfe-view h3{margin:14px 0 6px;font-size:11px;letter-spacing:.14em;color:#8fb4d4}#gfe-view h3 small{color:#6dff9b;letter-spacing:.06em;margin-left:6px}
  .row{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;align-items:center}.row input{flex:1 1 90px}.note{margin-top:10px;font-size:10.5px;color:#7d8c98}.dim{color:#7d8c98}.ok{color:#6dff9b}.bad{color:#ff6b5e}.m{color:#ff5cf0}
  .home .hd{display:flex;gap:14px;flex-wrap:wrap;padding:8px 10px;background:#12181e;border-radius:8px;margin-bottom:12px}.home .hd b{color:#fff;font-size:15px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
  #gfe-view .tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:96px;background:linear-gradient(#222a32,#181e24);border-radius:14px}
  .tile i{font-style:normal;font-size:30px}.tile span{font-size:10px;letter-spacing:.1em}
  .map{display:flex;flex-direction:column;height:100%;min-height:420px}.map canvas{flex:1;width:100%;min-height:340px;border-radius:10px;border:1px solid #1f2a33;touch-action:none}
  .mbar{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.mtxt{margin-top:8px;font-size:11px;color:#b8c6d0}.mtxt b{color:#fff}
  .tabs{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}
  .chk ul{list-style:none;margin:0;padding:0}.chk li{display:flex;align-items:center;gap:8px;padding:12px 8px;border-bottom:1px solid #1b232a;cursor:pointer;min-height:46px}
  .chk li .bx{width:22px;height:22px;border:2px solid #52626f;border-radius:5px;display:flex;align-items:center;justify-content:center;color:#6dff9b;font-weight:900;flex:0 0 22px}
  .chk li .t{color:#e6ecf0}.chk li .d{flex:1;border-bottom:1px dotted #2c3943;margin:0 4px;height:1px}.chk li .a{color:#6dff9b;font-weight:700;font-size:12px;text-align:right}
  .chk li.ok .t{color:#7d8c98;text-decoration:line-through}.dot{width:10px;height:10px;border-radius:50%;background:transparent;flex:0 0 10px}.dot.g{background:#3dff7a;box-shadow:0 0 6px #3dff7a}.dot.a{background:#ffbf47;box-shadow:0 0 6px #ffbf47}
  .fg{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px}.f{display:flex;flex-direction:column;gap:3px;position:relative}.f span{font-size:9px;letter-spacing:.1em;color:#8fb4d4}.f input{width:100%;padding-right:34px}.f em{position:absolute;right:8px;bottom:9px;font-style:normal;font-size:9px;color:#6a7a86;pointer-events:none}
  .out{margin:10px 0;padding:10px 12px;background:#12181e;border-radius:8px;display:flex;flex-direction:column;gap:5px;font-size:13px}.out b{color:#fff}.out b.ok{color:#6dff9b}.out b.bad{color:#ff6b5e}
  table{width:100%;border-collapse:collapse;margin:6px 0}td{padding:7px 4px;border-bottom:1px solid #1b232a;font-size:13px}td:nth-child(2){text-align:right;font:700 13px Consolas,monospace}td:nth-child(3){text-align:right}
  pre{white-space:pre-wrap;word-break:break-word;background:#080b0e;border:1px solid #1f2a33;border-radius:8px;padding:10px;font:600 13px Consolas,monospace;color:#6dff9b;min-height:90px;-webkit-user-select:text;user-select:text}
  pre a,.ln a{color:#7cc4ff}
  .oooi{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.oooi div{background:#12181e;border-radius:8px;padding:8px;text-align:center}.oooi span{display:block;font-size:10px;letter-spacing:.14em;color:#8fb4d4}.oooi b{font:700 18px Consolas,monospace;color:#6dff9b}
  .calc .disp{background:#080b0e;border:1px solid #2a333b;border-radius:8px;padding:8px 12px;text-align:right;min-height:64px}.calc .disp small{display:block;min-height:16px;color:#7d8c98;font:12px Consolas,monospace}.calc .disp b{font:700 26px Consolas,monospace;color:#fff;word-break:break-all}
  .keys{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:8px}#gfe-view .keys button{padding:14px 0;font-size:15px}#gfe-view .keys .eq{grid-column:span 5;background:#1f3b57}
  .cv{display:flex;align-items:center;gap:6px;margin:6px 0}.cv input{flex:1 1 80px}.cv span{font-size:10px;color:#8fb4d4;width:46px}.cv b{color:#52626f}
  .nt textarea{display:block;width:100%;height:55vh;min-height:260px;resize:none;white-space:pre-wrap}
  .ln ul{list-style:none;padding:0;margin:0}.ln li{display:flex;gap:8px;align-items:center;margin:6px 0}.ln li a{flex:1;display:block;padding:12px;background:#151c22;border-radius:8px;text-decoration:none;color:#fff}.ln li a small{display:block;color:#7d8c98;font-size:10px}
  @media (pointer:coarse),(hover:none){#gfe-view button{padding:13px 14px;font-size:12px}#gfe-view input,#gfe-view textarea{font-size:16px;padding:10px 12px}.gfe-st button{padding:9px 12px}#gfe-tab{width:40px;height:130px;margin-top:-65px;line-height:40px;font-size:13px}.gfe-nav button{height:48px;min-width:52px}.gfe-bz{border-width:7px}}
  @media (max-width:600px){#gfe-root{width:100vw}}
  @media (prefers-reduced-motion:reduce){#gfe-root{transition:none}}
  `;
  let root = null;
  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'gfe-root';
    root.innerHTML = `<div class="gfe-dev"><div class="gfe-bz">
      <div class="gfe-st"><b id="gfe-ttl">HOME</b><span class="sp"></span><span id="gfe-who" class="dim"></span><span class="tm" id="gfe-tm">--:--:--Z</span><button data-s="dock">DOCK ⇄</button><button data-s="close">CLOSE</button></div>
      <div id="gfe-view"></div>
      <nav class="gfe-nav" aria-label="EFB apps">${Object.entries(APPS).map(([k, a]) => `<button data-app="${k}" aria-label="${a.name}">${a.icon}<small>${a.name.length > 9 ? a.name.slice(0, 8) + '…' : a.name}</small></button>`).join('')}</nav></div></div>
    <button id="gfe-tab" aria-label="Toggle EFB (Alt+E)">EFB</button>`;
    document.body.appendChild(root);
    ['pointerdown', 'mousedown', 'touchstart', 'touchmove'].forEach(ev => root.addEventListener(ev, e => e.stopPropagation(), { passive: true })); // keep taps off GeoFS's touch controls
    root.addEventListener('keydown', e => { if (e.target.matches('input,textarea')) e.stopPropagation(); }, true);
    root.addEventListener('click', e => {
      const a = e.target.closest('[data-app]'); if (a && (a.closest('.gfe-nav') || a.closest('.grid'))) return open(a.dataset.app);
      const s = e.target.closest('[data-s]'); if (!s) return;
      if (s.dataset.s === 'close') toggle(false);
      if (s.dataset.s === 'dock') { S.side = S.side === 'right' ? 'left' : 'right'; applySide(); save(); }
    });
    $('#gfe-tab').addEventListener('click', () => toggle());
    root.style.setProperty('--gfe-b', S.bright);
    applySide(); open(S.app || 'home'); applyOpen();
  }
  function applySide() { root.classList.toggle('r', S.side === 'right'); root.classList.toggle('l', S.side === 'left'); $('#gfe-who').textContent = S.side === 'right' ? 'F/O EFB' : 'CAPT EFB'; }
  function open(app) {
    if (!APPS[app]) app = 'home'; S.app = app; const el = $('#gfe-view'); el.onclick = null; el.scrollTop = 0;
    APPS[app].render(el); $('#gfe-ttl').textContent = APPS[app].name;
    $$('.gfe-nav button').forEach(b => b.classList.toggle('on', b.dataset.app === app)); save();
  }
  function applyOpen() { root.classList.toggle('open', S.open); if (S.open) { open(S.app); } }
  function toggle(force) { S.open = typeof force === 'boolean' ? force : !S.open; applyOpen(); save(); }

  document.addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyE') { e.preventDefault(); toggle(); } }, true);

  function boot() {
    if (!document.body) return setTimeout(boot, 200);
    build();
    setInterval(logTick, 500);
    setInterval(() => {
      if (!S.open) return;
      $('#gfe-tm').textContent = utcTime();
      const a = APPS[S.app]; if (a && a.tick) { const act = document.activeElement; if (!(act && act.matches && act.matches('input,textarea') && root.contains(act) && S.app !== 'map')) a.tick($('#gfe-view')); }
    }, 1000);
    setInterval(() => { if (S.open && S.app === 'map') APPS.map.tick($('#gfe-view')); }, 120);
    window.GeoFSEFB = { version: VERSION, open: () => toggle(true), close: () => toggle(false), toggle, state: S, log: () => S.log };
    console.log('[GeoFS EFB] loaded. Alt+E toggles the EFB.');
  }
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
GeoFSDock.add('#gfe-tab', 3);
