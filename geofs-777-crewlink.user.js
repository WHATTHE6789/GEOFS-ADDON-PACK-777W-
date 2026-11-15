// ==UserScript==
// @name         GeoFS 777-300ER Crew Link (two-device shared cockpit)
// @namespace    https://github.com/geofs-overhead
// @version      1.0.0
// @description  Link two devices so both pilots share one cockpit: overhead switches, AFDS targets, CDU/FMC data and routes, radios/transponder/baro, and the real aircraft controls (gear, flaps, speedbrake, parking brake, engines, autopilot) all stay in step. Optional shared flight controls with an instant hand-over.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * INSTALL on BOTH devices (same script): Tampermonkey/Violentmonkey -> new script -> paste -> save -> reload GeoFS.
 *          Install it together with the Overhead (2.1.0+) and Lower Panel scripts from the same batch.
 * USE:     Tap the "LINK" pill (top-left) or press Alt+J.
 *            Device 1 (HOST = the aircraft that is really flown): choose HOST -> START -> read out the 8-character code.
 *            Device 2 (GUEST): choose GUEST -> type the code -> JOIN.
 *          If the automatic pairing is blocked on your network, use MANUAL PAIRING (copy/paste two codes).
 *
 * HOW IT WORKS (and what it can't do)
 *   * Two GeoFS clients cannot fly one aircraft - GeoFS has no such feature. Each device keeps its OWN GeoFS aircraft. This
 *     script links the COCKPIT: the host's panels, FMC and aircraft configuration are copied to the guest and every action the
 *     guest takes is sent to the host, which performs it. The guest's own aircraft just mirrors the host's configuration
 *     (gear, flaps, speedbrake, parking brake, optionally engines/AP) so the panels there show the same truth.
 *   * SAME AIRCRAFT (experimental): with "Guest copies the host aircraft" on, the host streams its aircraft's position, attitude and
 *     rigid-body motion ~20x/s and the guest writes them into its own aircraft, so the guest sees the same flight from its cockpit
 *     with working instruments. GeoFS has no official API for this, so the fields are discovered at run time; MIRROR PROBE reports
 *     what was found. Both devices must use the same aircraft. If it jitters or does nothing, switch it off - the panel sync still works.
 *   * Shared flight controls (throttle / yoke / rudder / trim / brakes) are OPTIONAL and EXPERIMENTAL: they rely on GeoFS control
 *     fields I could not verify, and add network latency (typically 50-150 ms). The host can take control back at any moment.
 *   * Transport: a direct peer-to-peer WebRTC data channel. Pairing signals go through the public relay ntfy.sh (a third party
 *     sees the random room code and your connection candidates - treat the code like a password and do not reuse it). No TURN
 *     server is included, so on very strict mobile/CGNAT networks the direct link can fail; MANUAL PAIRING helps only with the
 *     signalling, not with a blocked direct connection.
 *   STABILITY: heartbeat + automatic reconnect with back-off, full resync on every (re)connection and every 8 s, last-writer-wins
 *   conflict handling, input validation (nothing the other device sends can add or change anything outside the known state),
 *   control failsafe (guest control is dropped after 1.5 s of silence). Sim use only.
 */
(function () {
  'use strict';
  if (window.GeoFSLink) return;
  const VERSION = '1.0.0', STORE = 'geofsLink.v1';

  /* ───────────────────────── helpers ───────────────────────── */
  const safe = (f, d) => { try { const r = f(); return r === undefined ? d : r; } catch (e) { return d; } };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const OH = () => safe(() => window.GeoFSOverhead, null), LO = () => safe(() => window.GeoFSLower, null);
  const inst = () => safe(() => geofs.aircraft.instance, null);
  const rid = n => { const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; const c = window.crypto && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(n)) : Array.from({ length: n }, () => Math.floor(Math.random() * 256)); for (let i = 0; i < n; i++) s += a[c[i] % a.length]; return s; };
  const ID = (() => { try { let v = sessionStorage.getItem('geofsLink.id'); if (!v) { v = rid(8); sessionStorage.setItem('geofsLink.id', v); } return v; } catch (e) { return rid(8); } })();
  const now = () => Date.now();

  /* ───────────────────────── settings ───────────────────────── */
  const DEF = () => ({ open: false, x: 120, y: 52, role: 'host', code: '', pose: true, share: { cockpit: true, fmc: true, radios: true, controls: false }, mirror: { gear: true, flaps: true, air: true, park: true, eng: false, ap: false } });
  const S = DEF();
  try { const o = JSON.parse(localStorage.getItem(STORE) || 'null'); if (o) Object.keys(S).forEach(k => { if (o[k] !== undefined) S[k] = (S[k] && typeof S[k] === 'object') ? Object.assign(S[k], o[k]) : o[k]; }); } catch (e) { /* ignore */ }
  S.open = false;
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } };

  /* ───────────────────────── link state ───────────────────────── */
  const L = { st: 'IDLE', rtt: null, lastRx: 0, sent: 0, recv: 0, synced: false, pf: 'host', peer: null, pc: null, dc: null, sse: null, retry: 0, retryT: 0, fullT: 0, ctlRx: 0, ctlWarn: false, manual: false, lc: 0, active: false };
  const LOGS = []; const log = t => { LOGS.unshift({ t: now(), m: t }); if (LOGS.length > 30) LOGS.pop(); draw(); };
  const setState = s => { if (L.st !== s) { L.st = s; log('Link: ' + s); } draw(); };

  /* ───────────────────────── sync groups ───────────────────────── */
  const BAD = new Set(['__proto__', 'constructor', 'prototype']);
  const GROUPS = [
    { g: 'oh', root: () => safe(() => OH().state, null), keys: ['sw', 'ap', 'strict', 'mode'], skip: [], on: () => S.share.cockpit, after: () => safe(() => OH().refresh()) },
    { g: 'fm', root: () => safe(() => LO().fmc, null), keys: null, skip: ['exec', 'dt'], on: () => S.share.fmc, after: () => safe(() => LO().refresh()) },
    { g: 'rd', root: () => safe(() => LO().state, null), keys: ['vhf', 'hf', 'mic', 'vol', 'xp', 'baro', 'sbArm'], skip: ['xp.identUntil', 'xp.entry'], on: () => S.share.radios, after: () => safe(() => LO().refresh()) },
  ];
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  function flat(g, obj, prefix, out, skip) {
    Object.keys(obj).forEach(k => { const p = prefix ? prefix + '.' + k : k; if (skip.includes(p) || BAD.has(k)) return; const v = obj[k];
      if (isObj(v)) flat(g, v, p, out, skip); else if (Array.isArray(v)) out[g + ':' + p] = { a: v }; else if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) out[g + ':' + p] = v; });
  }
  function snapshot() {
    const out = {};
    GROUPS.forEach(G => { if (!G.on()) return; const r = G.root(); if (!r) return; const keys = G.keys || Object.keys(r); keys.forEach(k => { if (!(k in r) || BAD.has(k)) return; const v = r[k], p = k; if (G.skip.includes(p)) return; if (isObj(v)) flat(G.g, v, p, out, G.skip); else if (Array.isArray(v)) out[G.g + ':' + p] = { a: v }; else if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) out[G.g + ':' + p] = v; }); });
    return out;
  }
  const same = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object') ? JSON.stringify(a) === JSON.stringify(b) : a === b;
  const okPrim = v => v === null || ['number', 'string', 'boolean'].includes(typeof v);
  function okArray(a) { try { return Array.isArray(a) && a.length <= 400 && JSON.stringify(a).length < 40000 && a.every(x => okPrim(x) || (isObj(x) && Object.keys(x).length < 40 && Object.keys(x).every(k => !BAD.has(k) && (okPrim(x[k]) || isObj(x[k]) || Array.isArray(x[k]))))); } catch (e) { return false; } }
  let LAST = {}; const LW = {}; // LW: path -> [lamport, from]
  function applyOne(key, val) { // key "g:path"; returns group or null
    const i = key.indexOf(':'); if (i < 1) return null; const g = key.slice(0, i), path = key.slice(i + 1), G = GROUPS.find(x => x.g === g); if (!G || !G.on()) return null;
    const parts = path.split('.'); if (parts.some(p => !p || BAD.has(p))) return null; const root = G.root(); if (!root) return null; if (G.keys && !G.keys.includes(parts[0])) return null; if (G.skip.includes(path)) return null;
    let o = root; for (let k = 0; k < parts.length - 1; k++) { o = o[parts[k]]; if (!isObj(o)) return null; }
    const last = parts[parts.length - 1]; if (!Object.prototype.hasOwnProperty.call(o, last)) return null; const cur = o[last];
    if (isObj(val) && Array.isArray(val.a)) { if (!Array.isArray(cur) || !okArray(val.a)) return null; o[last] = JSON.parse(JSON.stringify(val.a)); }
    else { if (!okPrim(val) || isObj(cur) || Array.isArray(cur) || (val === null && g !== 'fm')) return null; if (cur !== null && val !== null && typeof cur !== typeof val) return null; if (typeof val === 'string' && val.length > 200) return null; if (typeof val === 'number' && !isFinite(val)) return null; o[last] = val; }
    return G;
  }
  function applyRemote(c, from, lcMax) {
    const touched = new Set(); L.lc = Math.max(L.lc, lcMax || 0);
    Object.keys(c).forEach(k => { const e = c[k]; if (!Array.isArray(e) || e.length < 2) return; const [v, lc, f] = e; const lw = LW[k]; if (lw && (lw[0] > lc || (lw[0] === lc && lw[1] > (f || from)))) return; if (same(LAST[k], v)) { LW[k] = [lc, f || from]; return; }
      const G = safe(() => applyOne(k, v), null); if (G) { touched.add(G); LAST[k] = v; LW[k] = [lc, f || from]; } });
    touched.forEach(G => safe(() => G.after()));
  }
  function localDeltas() { // changes made on THIS device since the last poll
    const cur = snapshot(), out = {}; let n = 0;
    Object.keys(cur).forEach(k => { if (!(k in LAST) || !same(LAST[k], cur[k])) { const lc = ++L.lc; out[k] = [cur[k], lc, ID]; LW[k] = [lc, ID]; n++; } });
    LAST = cur; return n ? out : null;
  }
  function fullState() { const cur = snapshot(), out = {}; Object.keys(cur).forEach(k => { const lw = LW[k]; out[k] = [cur[k], lw ? lw[0] : 0, lw ? lw[1] : ID]; }); LAST = cur; return out; }

  /* ───────────────────────── real aircraft state ───────────────────────── */
  const num = (o, k) => { const v = safe(() => o[k], undefined); return typeof v === 'number' ? v : undefined; };
  const gearPos = () => { const v = safe(() => geofs.animation.values.gearPosition, undefined); return typeof v === 'number' ? v : (num(controls.gear, 'position') || 0); };
  function readReal() {
    const t = num(controls.gear, 'target');
    return { gear: t !== undefined ? t > .5 : gearPos() > .5, flaps: num(controls.flaps, 'target'), air: (num(controls.airbrakes, 'target') || 0) > .5, park: !!safe(() => controls.parkingBrake, false), eng: !!safe(() => inst().engine.on, false), ap: !!safe(() => geofs.autopilot.on, false), thr: num(controls, 'throttle'), ax: [0, 1, 2].map(i => { const n = axName(i); return n ? controls[n] : null; }) };
  }
  const coolR = {}; const cool = (k, ms) => { const n = now(); if (coolR[k] && n - coolR[k] < ms) return false; coolR[k] = n; return true; };
  function mirrorReal(r) { // guest: make the local aircraft configuration follow the host
    const R = window.GeoFSReal, me = readReal(); if (!R || !r) return;
    if (S.mirror.gear && typeof r.gear === 'boolean' && me.gear !== r.gear) { const p = gearPos(); if (!(p > .03 && p < .97) && cool('g', 2500)) R.gear(r.gear, true); }
    if (S.mirror.flaps && typeof r.flaps === 'number' && r.flaps !== me.flaps && cool('f', 1200)) R.flaps(clamp(Math.round(r.flaps), 0, 10), true);
    if (S.mirror.air && typeof r.air === 'boolean' && me.air !== r.air && cool('a', 1500)) R.airbrake(r.air, true);
    if (S.mirror.park && typeof r.park === 'boolean' && me.park !== r.park && cool('p', 1500)) R.parking(r.park, true);
    if (S.mirror.eng && typeof r.eng === 'boolean' && me.eng !== r.eng && cool('e', 4000)) safe(() => OH().pressTo('eng', r.eng, true));
    if (S.mirror.ap && typeof r.ap === 'boolean' && me.ap !== r.ap && cool('ap', 3000)) safe(() => OH().pressTo('apm', r.ap, true));
    if (L.pf === 'host' && typeof r.thr === 'number' && (S.share.controls || S.pose)) safe(() => { controls.throttle = clamp(r.thr, 0, 1); });
    if (S.pose && L.pf === 'host' && Array.isArray(r.ax)) safe(() => r.ax.forEach((v, i) => { const n = axName(i); if (n && typeof v === 'number') controls[n] = clamp(v, -1, 1); }));
  }
  // guest -> host: forwarded real-control commands (the guest's own aircraft is NOT changed by them)
  function hostExec(a) {
    const R = window.GeoFSReal; if (!R || !a || typeof a.k !== 'string') return;
    if (a.k === 'gear' && typeof a.a === 'boolean') R.gear(a.a, true); else if (a.k === 'airbrake' && typeof a.a === 'boolean') R.airbrake(a.a, true); else if (a.k === 'parking' && typeof a.a === 'boolean') R.parking(a.a, true);
    else if (a.k === 'flaps' && typeof a.a === 'number' && isFinite(a.a)) R.flaps(clamp(Math.round(a.a), 0, 10), true);
    else if (a.k === 'press' && a.a && typeof a.a.id === 'string' && typeof a.a.want === 'boolean') safe(() => OH().pressTo(a.a.id, a.a.want, true));
  }
  function installRemoteHook(on) { const R = window.GeoFSReal; if (!R) return; R.remote = on ? (k, a) => { if (L.st === 'LIVE' && L.synced) { send({ t: 'c', c: { k, a } }); return Promise.resolve('sent to host'); } return Promise.resolve('FAILED (link not live)'); } : null; }

  /* ───────────────────────── SAME AIRCRAFT: pose / motion mirroring (experimental) ─────────────────────────
     Host streams the physical state of its aircraft (position, attitude and the rigid-body position/rotation/velocity fields) ~20x/s.
     The guest copies those values straight into ITS aircraft; its physics engine keeps integrating from the copied velocity between
     updates, so motion stays smooth. Which GeoFS fields exist is discovered at run time (see MIRROR PROBE). */
  const P = { n: 0, t0: now(), rate: 0, err: '', match: null, hostAc: '', last: 0, probe: null, warned: false };
  const numArr = (v, d = 0) => { if (v == null || typeof v !== 'object' || v.length === undefined || v.length > 16) return false; if (typeof v === 'string') return false; for (let i = 0; i < v.length; i++) { const x = v[i]; if (typeof x === 'number') continue; if (d < 1 && x && typeof x === 'object' && numArr(x, d + 1)) continue; return false; } return v.length > 0; };
  const cloneNum = v => Array.from(v, x => (typeof x === 'number' ? x : Array.from(x)));
  const RB_RE = /position|rotation|velocity|angular|quat|orient|euler|htr|lla|ecef/i;
  function capturePose() {
    const I = inst(); if (!I) return null; const o = { ac: safe(() => String(I.aircraftRecord.id || I.aircraftRecord.name || ''), ''), i: {}, rb: {} };
    Object.keys(I).forEach(k => { if (RB_RE.test(k) && k !== 'rigidBody' && numArr(I[k])) o.i[k] = cloneNum(I[k]); });
    const rb = I.rigidBody; if (rb && typeof rb === 'object') Object.keys(rb).forEach(k => { if (RB_RE.test(k) && numArr(rb[k])) o.rb[k] = cloneNum(rb[k]); });
    return o;
  }
  function copyInto(obj, k, src) { const dst = obj[k]; if (!numArr(dst) || dst.length !== src.length) return false; for (let i = 0; i < src.length; i++) { if (typeof src[i] === 'number') dst[i] = src[i]; else if (dst[i] && dst[i].length === src[i].length) for (let j = 0; j < src[i].length; j++) dst[i][j] = src[i][j]; else return false; } return true; }
  function applyPose(p) {
    const I = inst(); if (!I || !isObj(p)) return; let hit = 0, miss = 0;
    P.hostAc = String(p.ac || ''); const mine = safe(() => String(I.aircraftRecord.id || I.aircraftRecord.name || ''), ''); P.match = !P.hostAc || !mine || P.hostAc === mine;
    Object.keys(p.i || {}).forEach(k => { if (!BAD.has(k) && Object.prototype.hasOwnProperty.call(I, k) && numArr(p.i[k]) && copyInto(I, k, p.i[k])) hit++; else miss++; });
    Object.keys(p.rb || {}).forEach(k => { const rb = I.rigidBody; if (!rb || BAD.has(k) || !Object.prototype.hasOwnProperty.call(rb, k) || !numArr(p.rb[k]) || !copyInto(rb, k, p.rb[k])) miss++; else hit++; });
    P.n++; P.last = now(); if (!hit && !P.warned) { P.warned = true; P.err = 'No matching GeoFS fields found - run MIRROR PROBE and send me the result'; log(P.err); } else if (hit) P.err = P.match ? '' : 'Aircraft differs from the host (' + P.hostAc + ') - select the same aircraft';
  }
  function probePose() {
    const I = inst(); if (!I) return log('No aircraft instance');
    const desc = (o, label) => Object.keys(o || {}).filter(k => RB_RE.test(k)).map(k => { const v = o[k]; return label + k + ':' + (numArr(v) ? 'num[' + v.length + ']' : (v === null ? 'null' : typeof v + (v && v.constructor ? '/' + v.constructor.name : ''))); });
    const lines = desc(I, 'i.').concat(desc(I.rigidBody, 'rb.')); const cap = capturePose();
    log('PROBE copyable: ' + (cap ? Object.keys(cap.i).length + ' instance + ' + Object.keys(cap.rb).length + ' rigidBody fields' : 'none') + ' | ' + lines.join(', ').slice(0, 900)); console.log('[GeoFS Link] pose probe', lines, cap);
  }
  setInterval(() => { try { // host: stream pose while the guest asks for it
    if (S.role !== 'host' || L.st !== 'LIVE' || !L.poseReq) return; const p = capturePose(); if (p) { send({ t: 'm', p }); P.n++; }
  } catch (e) { /* ignore */ } }, 50);
  setInterval(() => { const t = now(); P.rate = Math.round(P.n / Math.max(1, (t - P.t0) / 1000) * 10) / 10; if (t - P.t0 > 3000) { P.t0 = t; P.n = 0; } }, 1000);

  /* ───────────────────────── shared flight controls (experimental) ───────────────────────── */
  const AX = ['rawPitch', 'rawRoll', 'rawYaw'], AXF = ['pitch', 'roll', 'yaw'];
  const axName = i => (typeof safe(() => controls[AX[i]], undefined) === 'number' ? AX[i] : (typeof safe(() => controls[AXF[i]], undefined) === 'number' ? AXF[i] : null));
  const readCtl = () => [num(controls, 'throttle'), ...[0, 1, 2].map(i => { const n = axName(i); return n ? controls[n] : null; }), num(controls, 'elevatorTrim'), num(controls, 'brakes')];
  let ctlLatest = null;
  function applyCtl() {
    if (L.pf !== 'guest' || !ctlLatest) return;
    if (now() - L.ctlRx > 1500) { L.pf = 'host'; ctlLatest = null; log('Guest control lost for 1.5 s - control returned to HOST'); send({ t: 'pf', who: 'host' }); return draw(); }
    const [thr, p, r, y, trim, brk] = ctlLatest;
    safe(() => { if (typeof thr === 'number') controls.throttle = clamp(thr, 0, 1); [p, r, y].forEach((v, i) => { const n = axName(i); if (n && typeof v === 'number') controls[n] = clamp(v, -1, 1); }); if (typeof trim === 'number') controls.elevatorTrim = clamp(trim, -1, 1); if (typeof brk === 'number') controls.brakes = clamp(brk, 0, 1); });
  }

  /* ───────────────────────── messaging ───────────────────────── */
  function send(o) { const d = L.dc; if (!d || d.readyState !== 'open') return false; try { const s = JSON.stringify(o); if (s.length > 60000) return false; d.send(s); L.sent++; return true; } catch (e) { return false; } }
  function onMsg(raw) {
    if (typeof raw !== 'string' || raw.length > 120000) return; let m; try { m = JSON.parse(raw); } catch (e) { return; } if (!isObj(m) || typeof m.t !== 'string') return;
    L.lastRx = now(); L.recv++;
    try {
      switch (m.t) {
        case 'p': send({ t: 'q', ts: m.ts }); break;
        case 'q': if (typeof m.ts === 'number') L.rtt = now() - m.ts; break;
        case 'hi': if (S.role === 'host') { send({ t: 'f', from: ID, lc: L.lc, c: fullState(), r: readReal(), pf: L.pf }); log('Guest connected - full state sent'); } break;
        case 'f': if (S.role === 'guest' && isObj(m.c)) { applyRemote(m.c, m.from || 'host', m.lc); LAST = snapshot(); L.synced = true; if (m.r) mirrorReal(m.r); if (m.pf) L.pf = m.pf === 'guest' ? 'guest' : 'host'; installRemoteHook(true); send({ t: 'mr', on: !!S.pose }); setState('LIVE'); } break;
        case 'd': if (isObj(m.c) && (S.role === 'host' || L.synced)) applyRemote(m.c, m.from || 'peer', m.lc); break;
        case 'r': if (S.role === 'guest' && L.synced) mirrorReal(m.r); break;
        case 'c': if (S.role === 'host' && isObj(m.c)) hostExec(m.c); break;
        case 'x': if (S.role === 'host' && S.share.controls && L.pf === 'guest' && Array.isArray(m.c) && m.c.length === 6) { ctlLatest = m.c.map(v => (typeof v === 'number' && isFinite(v) ? v : null)); L.ctlRx = now(); } break;
        case 'pf': if (m.who === 'guest' || m.who === 'host') { if (S.role === 'host') { if (m.who === 'guest' && !S.share.controls) { send({ t: 'pf', who: 'host' }); break; } L.pf = m.who; ctlLatest = null; send({ t: 'pf', who: L.pf }); log('Flight controls: ' + L.pf.toUpperCase()); } else { L.pf = m.who; log('Flight controls: ' + L.pf.toUpperCase()); } draw(); } break;
        case 'm': if (S.role === 'guest' && S.pose && L.synced && L.pf === 'host') applyPose(m.p); break;
        case 'mr': if (S.role === 'host') { L.poseReq = !!m.on; log('Guest ' + (m.on ? 'is mirroring' : 'stopped mirroring') + ' the aircraft'); } break;
        case 'bye': log('Peer left'); linkLost('peer left'); break;
      }
    } catch (e) { log('Message error: ' + e.message); }
  }

  /* ───────────────────────── connection ───────────────────────── */
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
  const NTFY = 'https://ntfy.sh/', topic = c => 'geofs777link-' + String(c).toLowerCase().replace(/[^a-z0-9]/g, '');
  function teardown() { try { if (L.dc) { L.dc.onopen = L.dc.onclose = L.dc.onmessage = null; L.dc.close(); } } catch (e) { /* ignore */ } try { if (L.pc) { L.pc.onconnectionstatechange = L.pc.ondatachannel = null; L.pc.close(); } } catch (e) { /* ignore */ } L.dc = null; L.pc = null; L.synced = false; L.poseReq = false; installRemoteHook(false); ctlLatest = null; if (L.pf === 'guest') L.pf = 'host'; }
  function linkLost(why) {
    if (!L.active) return; teardown(); setState('RECONNECTING'); log('Link lost (' + why + ') - reconnecting');
    L.retry++; clearTimeout(L.retryT); const wait = clamp(1000 * Math.pow(1.7, Math.min(L.retry, 7)), 1000, 15000);
    L.retryT = setTimeout(() => { if (S.role === 'guest') publish({ t: 'join', from: ID }); }, S.role === 'guest' ? wait : 0);
  }
  const gather = pc => new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); const done = () => { pc.removeEventListener('icegatheringstatechange', ch); res(); }; const ch = () => { if (pc.iceGatheringState === 'complete') done(); }; pc.addEventListener('icegatheringstatechange', ch); setTimeout(done, 4000); });
  function newPc() { const pc = new RTCPeerConnection({ iceServers: ICE }); pc.onconnectionstatechange = () => { const s = pc.connectionState; if (s === 'failed' || s === 'closed') linkLost('connection ' + s); else if (s === 'disconnected') setTimeout(() => { if (L.pc === pc && pc.connectionState === 'disconnected') linkLost('disconnected'); }, 4000); }; return pc; }
  function wireDc(dc) {
    L.dc = dc; dc.onopen = () => { L.retry = 0; L.lastRx = now(); setState(S.role === 'guest' ? 'SYNCING' : 'LIVE'); if (S.role === 'guest') send({ t: 'hi', id: ID, v: VERSION }); };
    dc.onclose = () => linkLost('channel closed'); dc.onmessage = e => onMsg(e.data);
  }
  async function hostOffer(guestId) { // initiator
    teardown(); const pc = newPc(); L.pc = pc; L.peer = guestId; wireDc(pc.createDataChannel('gf', { ordered: true })); await pc.setLocalDescription(await pc.createOffer()); await gather(pc);
    return { t: 'offer', from: ID, to: guestId, sdp: pc.localDescription.sdp };
  }
  async function guestAnswer(offerSdp, hostId) {
    teardown(); const pc = newPc(); L.pc = pc; L.peer = hostId; pc.ondatachannel = e => wireDc(e.channel); await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp }); await pc.setLocalDescription(await pc.createAnswer()); await gather(pc);
    return { t: 'answer', from: ID, to: hostId, sdp: pc.localDescription.sdp };
  }
  function publish(m) { if (!S.code) return; m.sdp && m.sdp.length > 3800 && log('Warning: signalling message is large (' + m.sdp.length + ' bytes)'); fetch(NTFY + topic(S.code), { method: 'POST', body: JSON.stringify(m) }).catch(e => log('Signalling publish failed: ' + e.message)); }
  function openSignalling() {
    closeSignalling(); let es; try { es = new EventSource(NTFY + topic(S.code) + '/sse?since=15s'); } catch (e) { log('Cannot open signalling (' + e.message + ') - use MANUAL PAIRING'); return; }
    L.sse = es; es.onerror = () => { if (L.st === 'IDLE') return; /* EventSource retries by itself */ };
    es.onmessage = async ev => {
      let m; try { const d = JSON.parse(ev.data); if (d.event && d.event !== 'message') return; m = JSON.parse(d.message); } catch (e) { return; } if (!isObj(m) || m.from === ID) return;
      try {
        if (S.role === 'host' && m.t === 'join' && typeof m.from === 'string' && m.from.length < 20) { if (L.dc && L.dc.readyState === 'open' && L.peer === m.from && now() - L.lastRx < 3000) return; log('Guest asking to join - sending offer'); setState('CONNECTING'); publish(await hostOffer(m.from)); }
        else if (S.role === 'host' && m.t === 'answer' && m.to === ID && L.pc && m.from === L.peer && L.pc.signalingState === 'have-local-offer' && typeof m.sdp === 'string') await L.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        else if (S.role === 'guest' && m.t === 'offer' && m.to === ID && typeof m.sdp === 'string') { if (L.pc && L.pc.signalingState !== 'stable') return; log('Offer received - answering'); setState('CONNECTING'); publish(await guestAnswer(m.sdp, m.from)); }
      } catch (e) { log('Signalling error: ' + e.message); linkLost('signalling error'); }
    };
  }
  const closeSignalling = () => { try { if (L.sse) L.sse.close(); } catch (e) { /* ignore */ } L.sse = null; };
  function start() {
    if (!window.RTCPeerConnection) return log('This browser has no WebRTC - cannot link');
    stop(true); L.active = true; L.retry = 0; L.manual = false;
    if (S.role === 'host') { S.code = rid(8); setState('WAITING FOR GUEST'); log('Room code ' + S.code + ' - enter it on the other device'); }
    else { S.code = String(S.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (S.code.length < 6) { L.active = false; return log('Enter the 8-character code from the host'); } setState('CONNECTING'); }
    save(); openSignalling(); if (S.role === 'guest') { setTimeout(() => publish({ t: 'join', from: ID }), 600); L.retryT = setTimeout(function again() { if (L.active && S.role === 'guest' && L.st !== 'LIVE') { publish({ t: 'join', from: ID }); L.retryT = setTimeout(again, clamp(4000 * (1 + L.retry++ * .5), 4000, 15000)); } }, 6000); }
    draw();
  }
  function stop(silent) { if (L.dc && L.dc.readyState === 'open') send({ t: 'bye' }); L.active = false; clearTimeout(L.retryT); closeSignalling(); teardown(); LAST = {}; Object.keys(LW).forEach(k => delete LW[k]); L.pf = 'host'; if (!silent) { setState('IDLE'); log('Link closed'); } else L.st = 'IDLE'; draw(); }

  // manual (no relay) pairing: copy/paste two codes
  const b64 = o => btoa(unescape(encodeURIComponent(JSON.stringify(o)))), unb64 = s => JSON.parse(decodeURIComponent(escape(atob(String(s).trim()))));
  async function manual(step, text) {
    try {
      if (step === 'offer') { stop(true); S.role = 'host'; L.active = true; L.manual = true; setState('MANUAL: SEND OFFER'); const o = await hostOffer('manual'); return b64({ t: 'offer', sdp: o.sdp }); }
      if (step === 'answer') { stop(true); S.role = 'guest'; L.active = true; L.manual = true; const o = unb64(text); if (o.t !== 'offer') throw new Error('not an offer code'); const a = await guestAnswer(o.sdp, 'manual'); setState('MANUAL: SEND ANSWER'); return b64({ t: 'answer', sdp: a.sdp }); }
      if (step === 'apply') { const a = unb64(text); if (a.t !== 'answer' || !L.pc) throw new Error('not an answer code (or no offer started)'); await L.pc.setRemoteDescription({ type: 'answer', sdp: a.sdp }); setState('CONNECTING'); return 'ok'; }
    } catch (e) { log('Manual pairing error: ' + e.message); return ''; }
  }

  /* ───────────────────────── main loops ───────────────────────── */
  let lastPing = 0, lastReal = '', lastRealT = 0, lastCtl = 0;
  function loop() { // 100 ms
    const t = now();
    if (L.st === 'LIVE' || L.st === 'SYNCING') {
      if (t - lastPing > 1000) { lastPing = t; send({ t: 'p', ts: t }); }
      if (L.lastRx && t - L.lastRx > 5500) return linkLost('no data for 5 s');
      if (S.role === 'host' && L.st === 'LIVE') {
        const d = localDeltas(); if (d) send({ t: 'd', from: ID, lc: L.lc, c: d });
        const r = readReal(), rs = JSON.stringify(r); if (rs !== lastReal || t - lastRealT > 1000) { lastReal = rs; lastRealT = t; send({ t: 'r', r }); }
        if (t - L.fullT > 8000) { L.fullT = t; send({ t: 'f', from: ID, lc: L.lc, c: fullState(), r, pf: L.pf }); }
      } else if (S.role === 'guest' && L.synced) {
        const d = localDeltas(); if (d) send({ t: 'd', from: ID, lc: L.lc, c: d });
        if (L.pf === 'guest' && S.share.controls && t - lastCtl > 50) { lastCtl = t; send({ t: 'x', c: readCtl() }); }
      }
    }
  }
  setInterval(() => { try { loop(); } catch (e) { /* never break GeoFS */ } }, 100);
  setInterval(() => { try { applyCtl(); } catch (e) { /* ignore */ } }, 40);
  setInterval(() => { try { if (S.open || L.active) draw(); } catch (e) { /* ignore */ } }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && L.active && L.lastRx && now() - L.lastRx > 4000) linkLost('device woke up'); });
  window.addEventListener('online', () => { if (L.active && L.st !== 'LIVE') linkLost('network back'); });
  window.addEventListener('beforeunload', () => { try { if (L.dc && L.dc.readyState === 'open') send({ t: 'bye' }); } catch (e) { /* ignore */ } });

  /* ───────────────────────── UI ───────────────────────── */
  const CSS = `
  #gfk2-root,#gfk2-root *{box-sizing:border-box}#gfk2-root{position:fixed;z-index:99983;display:none;width:min(430px,98vw);font:600 11px system-ui,sans-serif;color:#dde4ea;background:#1d2125;border:2px solid #000;border-radius:10px;box-shadow:0 10px 36px #000c;-webkit-user-select:none;user-select:none;touch-action:manipulation;max-height:calc(100dvh - 20px);overflow:auto}
  #gfk2-root.open{display:block}.k2b{display:flex;align-items:center;gap:6px;padding:5px 8px;background:linear-gradient(#3a3f44,#2a2e32);cursor:grab;touch-action:none;letter-spacing:.12em;font-size:10px}.k2b b{flex:1;color:#f1f4f6}
  #gfk2-root button{all:unset;cursor:pointer;padding:8px 11px;border-radius:5px;background:#3b4046;border:1px solid #0d0f11;font-size:10px;letter-spacing:.05em;color:#dfe5e9;text-align:center}#gfk2-root button.on{background:#1f3b57;color:#fff}#gfk2-root button.go{background:#1d4d2e;color:#bfffd2}#gfk2-root button.warn{background:#5a2420;color:#ffd0ca}
  .k2c{padding:10px}.k2r{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}.k2code{font:700 26px ui-monospace,monospace;letter-spacing:.2em;color:#9fffb8;background:#0b0e10;border-radius:6px;padding:6px 10px;text-align:center;-webkit-user-select:text;user-select:text}
  #gfk2-root input[type=text],#gfk2-root textarea{font:600 16px ui-monospace,monospace;background:#0f1215;color:#dfe;border:1px solid #444;border-radius:4px;padding:6px 8px;-webkit-user-select:text;user-select:text;text-transform:uppercase;width:150px}#gfk2-root textarea{width:100%;height:70px;font-size:11px;text-transform:none}
  .k2l{background:#0b0e10;padding:6px 8px;max-height:130px;overflow:auto;font:500 10.5px ui-monospace,monospace;line-height:1.45;border-top:1px solid #000}.k2n{color:#8da0ad;font-weight:500;line-height:1.4;margin:6px 0}.k2t{color:#9fb3c0;font-size:9.5px;letter-spacing:.1em;margin-top:8px}
  .k2st{display:inline-block;padding:3px 8px;border-radius:10px;font-size:10px;letter-spacing:.08em}.k2st.LIVE{background:#14532d;color:#bfffd2}.k2st.IDLE{background:#333;color:#aaa}.k2st.bad{background:#6b3a12;color:#ffd9a8}
  #gfk2-pill{position:fixed;left:8px;top:6px;z-index:99982;font:700 10px system-ui;letter-spacing:.1em;background:#1d2125;color:#cfe;border:1px solid #000;border-radius:14px;padding:6px 10px;cursor:pointer;touch-action:manipulation;opacity:.92}
  @media (pointer:coarse),(hover:none){#gfk2-root button{padding:11px 13px;font-size:12px;min-height:40px}#gfk2-pill{padding:9px 13px;font-size:11px}}`;
  let root = null, pill = null, built = false;
  const stClass = () => (L.st === 'LIVE' ? 'LIVE' : L.st === 'IDLE' ? 'IDLE' : 'bad');
  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'gfk2-root'; root.innerHTML = '<div class="k2b" id="gfk2-bar"><b>CREW LINK</b><button data-a="close">✕</button></div><div class="k2c" id="gfk2-body"></div><div class="k2l" id="gfk2-log"></div>'; document.body.appendChild(root);
    pill = document.createElement('div'); pill.id = 'gfk2-pill'; pill.addEventListener('click', () => toggle()); document.body.appendChild(pill);
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'wheel', 'keydown', 'keyup'].forEach(t => root.addEventListener(t, e => e.stopPropagation(), { passive: true }));
    root.addEventListener('click', onClick); root.addEventListener('change', onChange);
    const bar = $('#gfk2-bar', root); let dr = null; bar.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; dr = { dx: e.clientX - S.x, dy: e.clientY - S.y }; try { bar.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
    bar.addEventListener('pointermove', e => { if (!dr) return; S.x = clamp(e.clientX - dr.dx, 0, innerWidth - 80); S.y = clamp(e.clientY - dr.dy, 0, innerHeight - 40); place(); }); bar.addEventListener('pointerup', () => { dr = null; save(); });
    built = true; place(); draw();
  }
  const place = () => { if (root) { root.style.left = S.x + 'px'; root.style.top = S.y + 'px'; } };
  const toggle = f => { S.open = typeof f === 'boolean' ? f : !S.open; root && root.classList.toggle('open', S.open); draw(); };
  const chk = (path, label) => `<label><input type="checkbox" data-s="${path}"${path.split('.').reduce((a, k) => a[k], S) ? ' checked' : ''}> ${label}</label>`;
  function draw() {
    if (!built) return;
    pill.textContent = 'LINK ● ' + (L.st === 'LIVE' ? 'LIVE' + (L.rtt != null ? ' ' + L.rtt + 'ms' : '') : L.st === 'IDLE' ? 'OFF' : L.st); pill.style.color = L.st === 'LIVE' ? '#9fffb8' : L.st === 'IDLE' ? '#9aa' : '#ffcf8a';
    if (!S.open) return; const body = $('#gfk2-body'), lg = $('#gfk2-log'); if (!body) return; if (document.activeElement && document.activeElement.matches && document.activeElement.matches('input[type=text],textarea') && root.contains(document.activeElement)) { lg.innerHTML = LOGS.slice(0, 12).map(l => `<div>${new Date(l.t).toTimeString().slice(0, 8)} ${esc(l.m)}</div>`).join(''); return; }
    const hostOK = !!OH() && !!LO(), live = L.st === 'LIVE';
    let h = `<div class="k2r"><span class="k2st ${stClass()}">${esc(L.st)}</span> <span>${S.role.toUpperCase()}</span> <span>${L.rtt != null ? 'RTT ' + L.rtt + ' ms' : ''}</span> <span>↑${L.sent} ↓${L.recv}</span></div>`;
    if (!hostOK) h += '<div class="k2n" style="color:#ffb36a">Overhead and/or Lower Panel script not detected - only what is installed can be linked. Install both (v2.1+) on both devices.</div>';
    if (!L.active) {
      h += `<div class="k2r"><button data-a="role-host" class="${S.role === 'host' ? 'on' : ''}">HOST (flies the aircraft)</button><button data-a="role-guest" class="${S.role === 'guest' ? 'on' : ''}">GUEST</button></div>`;
      h += S.role === 'host' ? '<div class="k2r"><button class="go" data-a="start">START &amp; GET CODE</button></div>' : `<div class="k2r"><input type="text" id="gfk2-code" maxlength="10" placeholder="CODE" value="${esc(S.code)}" autocapitalize="characters" autocorrect="off" autocomplete="off"><button class="go" data-a="join">JOIN</button></div>`;
    } else {
      if (S.role === 'host' && L.st !== 'LIVE' || S.role === 'host') h += `<div class="k2t">ROOM CODE (give this to the guest)</div><div class="k2code">${esc(S.code)}</div>`;
      h += `<div class="k2r"><button class="warn" data-a="stop">DISCONNECT</button><button data-a="resync">FORCE RESYNC</button></div>`;
    }
    h += `<div class="k2t">SHARE</div><div class="k2r">${chk('share.cockpit', 'Overhead + AFDS')}${chk('share.fmc', 'FMC / route')}${chk('share.radios', 'Radios / XPDR / baro')}</div>`;
    h += `<div class="k2t">GUEST MIRRORS HOST AIRCRAFT</div><div class="k2r">${chk('mirror.gear', 'Gear')}${chk('mirror.flaps', 'Flaps')}${chk('mirror.air', 'Speedbrake')}${chk('mirror.park', 'Park brake')}${chk('mirror.eng', 'Engines')}${chk('mirror.ap', 'Autopilot')}</div>`;
    h += `<div class="k2t">SAME AIRCRAFT (experimental)</div><div class="k2r">${chk('pose', 'Guest copies the host aircraft\'s position, attitude and motion')}<button data-a="probe-pose">MIRROR PROBE</button></div><div class="k2n">${S.role === 'guest' ? (S.pose ? 'Updates: ' + P.rate + '/s · aircraft ' + (P.match === false ? '<b style="color:#ffb36a">DIFFERENT - select ' + esc(P.hostAc) + '</b>' : 'match') + (P.err ? '<br><span style="color:#ffb36a">' + esc(P.err) + '</span>' : '') : 'Off') : 'Host: streams to the guest when the guest enables this.'}</div>`;
    h += `<div class="k2t">FLIGHT CONTROLS (experimental)</div><div class="k2r">${chk('share.controls', 'Allow guest to fly (throttle / yoke / rudder / trim / brakes)')}</div><div class="k2r"><span>PILOT FLYING: <b>${L.pf.toUpperCase()}</b></span>`;
    h += S.role === 'guest' ? `<button data-a="pf-guest" class="${L.pf === 'guest' ? 'on' : ''}" ${live && S.share.controls ? '' : 'disabled'}>I HAVE CONTROL</button><button data-a="pf-host">HAND BACK</button>` : `<button data-a="pf-host" class="go">I HAVE CONTROL</button>`;
    h += '</div>';
    h += `<div class="k2t">MANUAL PAIRING (if the relay is blocked)</div><div class="k2r"><button data-a="m-offer">HOST: MAKE OFFER</button><button data-a="m-answer">GUEST: MAKE ANSWER</button><button data-a="m-apply">HOST: APPLY ANSWER</button></div><textarea id="gfk2-man" placeholder="Offer / answer code appears here. Paste the other device's code here, then tap the matching button." spellcheck="false"></textarea>`;
    h += '<div class="k2n">Each device keeps its own GeoFS aircraft; the guest mirrors the host\'s cockpit and sends its actions to the host. See the script header for limits.</div>';
    body.innerHTML = h; lg.innerHTML = LOGS.slice(0, 12).map(l => `<div>${new Date(l.t).toTimeString().slice(0, 8)} ${esc(l.m)}</div>`).join('') || '<div>Ready.</div>';
  }
  async function onClick(e) {
    const b = e.target.closest('button'); if (!b || b.disabled) return; const a = b.dataset.a;
    if (a === 'close') toggle(false);
    else if (a === 'role-host' || a === 'role-guest') { S.role = a.slice(5); save(); draw(); }
    else if (a === 'start') { S.role = 'host'; start(); }
    else if (a === 'join') { const i = $('#gfk2-code'); S.code = (i ? i.value : S.code); S.role = 'guest'; start(); }
    else if (a === 'stop') stop();
    else if (a === 'resync') { if (S.role === 'host') send({ t: 'f', from: ID, lc: L.lc, c: fullState(), r: readReal(), pf: L.pf }); else send({ t: 'hi', id: ID, v: VERSION }); log('Resync requested'); }
    else if (a === 'probe-pose') probePose();
    else if (a === 'pf-guest') { if (L.st === 'LIVE') send({ t: 'pf', who: 'guest' }); }
    else if (a === 'pf-host') { if (S.role === 'host') { L.pf = 'host'; ctlLatest = null; send({ t: 'pf', who: 'host' }); log('Flight controls: HOST'); draw(); } else send({ t: 'pf', who: 'host' }); }
    else if (a === 'm-offer') { const c = await manual('offer'); const t = $('#gfk2-man'); if (t) t.value = c; log('Offer ready - send it to the guest (copy the text box)'); }
    else if (a === 'm-answer') { const t = $('#gfk2-man'); const c = await manual('answer', t ? t.value : ''); if (t && c) t.value = c; if (c) log('Answer ready - send it back to the host'); }
    else if (a === 'm-apply') { const t = $('#gfk2-man'); await manual('apply', t ? t.value : ''); }
  }
  function onChange(e) { const el = e.target.closest('[data-s]'); if (!el) return; const p = el.dataset.s.split('.'), last = p.pop(); p.reduce((o, k) => o[k], S)[last] = el.checked; save(); if (el.dataset.s === 'pose') { send({ t: 'mr', on: !!S.pose }); log('Aircraft mirroring ' + (S.pose ? 'ON' : 'OFF')); } if (el.dataset.s === 'share.controls' && !el.checked && L.pf === 'guest') { L.pf = 'host'; send({ t: 'pf', who: 'host' }); } if (L.active && S.role === 'host' && L.st === 'LIVE') send({ t: 'f', from: ID, lc: L.lc, c: fullState(), r: readReal(), pf: L.pf }); draw(); }
  document.addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyJ') { e.preventDefault(); toggle(); } });

  /* ───────────────────────── boot ───────────────────────── */
  function boot() {
    if (!document.body || !document.head) return setTimeout(boot, 700);
    build();
    window.GeoFSLink = { version: VERSION, id: ID, open: () => toggle(true), close: () => toggle(false), state: L, settings: S, start, stop, manual, send,
      _test: { capturePose, applyPose, P, onMsg, snapshot, applyRemote, localDeltas, fullState, attach(fn, role) { L.dc = { readyState: 'open', send: fn }; S.role = role; L.active = true; L.st = 'LIVE'; L.lastRx = now(); if (role === 'host') { LAST = snapshot(); } }, loop, hostExec } };
    console.log('[GeoFS Link] loaded. Alt+J or tap the LINK pill. Install on both devices.');
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
GeoFSDock.add('#gfk2-pill', 0);
