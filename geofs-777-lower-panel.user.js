// ==UserScript==
// @name         GeoFS 777-300ER Lower Panel (CDU / Radios / Pedestal)
// @namespace    https://github.com/geofs-overhead
// @version      1.0.0
// @description  Boeing 777-300ER style lower panel for GeoFS: 3 CDUs with FMC pages (route, legs, perf, takeoff/approach ref, progress, nav rad), VHF/HF radio panels, transponder, thrust/speedbrake/flap/gear/park-brake/trim pedestal and standby instruments. Companion to the Overhead Panel script.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * INSTALL: Tampermonkey/Violentmonkey -> Create new script -> paste -> save -> reload GeoFS.
 * USE:     Alt+P or click the tab at the bottom of the screen.
 *          iPad/Orion: no Alt key, so use the tab at the bottom of the screen. All controls are buttons (no wheel/right-click needed).
 *          CDU: click the keys, or click the CDU screen and type on your keyboard
 *               (Backspace = CLR, Delete = DEL, Esc = stop typing). LSKs are the buttons beside the screen.
 *          Radios: type a frequency in STBY + Enter, or use the MHz/kHz buttons / mouse wheel. XFER swaps.
 *          Console: GeoFSLower.toggle() / .state / .fmc
 *
 * HONESTY NOTE
 *   GeoFS has no avionics, radio, FMC or navigation-database API. So:
 *     REAL      -> thrust lever (controls.throttle), flap lever, gear, speedbrake (+ auto-extend on touchdown if ARMED),
 *                  parking brake, stab trim (if the aircraft exposes it), standby instrument readouts,
 *                  CDU LNAV (steers the autopilot HEADING toward the active leg -- pure pursuit, no wind correction),
 *                  CDU "SEND TO MCP" (writes ALT/SPD into the Overhead script's AFDS fields).
 *     LOCAL     -> radio frequencies, transponder code/mode, NAV RAD entries. They are stored and displayed but GeoFS
 *                  doesn't receive them (GeoFS has no radio tuning).
 *     APPROX    -> V1/VR/V2 and VREF are rough linear estimates for a 777-300ER, NOT Boeing/AFM data. Don't use them
 *                  for anything but this sim. Every value can be overridden on the page.
 *   Waypoints come from GeoFS's own flight plan (geofs.flightPlan.waypointArray) via RTE > LOAD GEOFS PLAN.
 *   Airports are not looked up (no database): ORIGIN/DEST are just text.
 *   If the Overhead script is installed and STRICT ELEC is on, CDUs/radios go dark with no bus power.
 */
(function () {
  'use strict';
  if (window.GeoFSLower) return;

  const VERSION = '1.0.0';
  const STORE = 'geofsLower.v1';
  const KEYS = {
    gear:    { key: 'g', code: 'KeyG', keyCode: 71 },
    flapsUp: { key: 'v', code: 'KeyV', keyCode: 86 },
    flapsDn: { key: 'f', code: 'KeyF', keyCode: 70 },
    airbrk:  { key: 'b', code: 'KeyB', keyCode: 66 },
    parking: { key: '.', code: 'Period', keyCode: 190 },
  };

  /* ───────────────────────── helpers ───────────────────────── */
  const safe = (f, d) => { try { const r = f(); return r === undefined ? d : r; } catch (e) { return d; } };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const V = () => safe(() => geofs.animation.values, {}) || {};
  const inst = () => safe(() => geofs.aircraft.instance, null);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = (n, w) => String(n).padStart(w, '0');
  const utc = () => { const d = new Date(); return pad(d.getUTCHours(), 2) + pad(d.getUTCMinutes(), 2) + 'Z'; };
  const gsKt = () => { const v = V(); return typeof v.groundSpeedKnt === 'number' ? v.groundSpeedKnt : (v.groundSpeed || 0) * 1.944; };
  const agl = v => (typeof v.haglFeet === 'number' ? v.haglFeet : Math.max(0, (v.altitude || 0) - (v.groundElevationFeet || 0)));
  const onGround = v => { const g = safe(() => inst().groundContact, undefined); return g !== undefined ? !!g : agl(v) < 8; };
  const powered = () => !safe(() => window.GeoFSOverhead && GeoFSOverhead.state.strict && !GeoFSOverhead.sim.bus, false);

  /* geo */
  function pos() { const l = safe(() => geofs.aircraft.instance.llaLocation, null) || safe(() => geofs.camera.lla, null); return l && isFinite(l[0]) && isFinite(l[1]) ? { lat: l[0], lon: l[1] } : null; }
  const RAD = Math.PI / 180;
  function gcd(a, b) { const dl = (b.lat - a.lat) * RAD, dn = (b.lon - a.lon) * RAD, x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dn / 2) ** 2; return 2 * 3440.065 * Math.asin(Math.sqrt(x)); }
  function brg(a, b) { const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD), x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD); return (Math.atan2(y, x) / RAD + 360) % 360; }
  function fmtPos(p) {
    if (!p) return '---';
    const f = (v, pos, neg, w) => { const h = v >= 0 ? pos : neg, a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return h + pad(d, w) + '°' + m.toFixed(1).padStart(4, '0'); };
    return f(p.lat, 'N', 'S', 2) + ' ' + f(p.lon, 'E', 'W', 3);
  }
  const fmtHM = h => { if (!isFinite(h) || h < 0) return '--:--'; const m = Math.round(h * 60); return pad(Math.floor(m / 60), 2) + ':' + pad(m % 60, 2); };

  /* ───────────────────────── state ───────────────────────── */
  const FMC0 = () => ({
    orig: '', dest: '', rwy: '', flt: '', co: '', altn: '', crz: 35000, ci: 80, zfw: 200.0, fuel: 80.0, res: 4.0, flaps: 15, thr: 'TO', redAlt: 1500,
    v1: null, vr: null, v2: null, lwo: null, lflap: 30, spd: 280, selT: '', nr: { vorL: '', vorR: '', adfL: '', adfR: '', ils: '', crs: '' },
    legs: [], active: 0, lnav: false, exec: null, dt: null, rteActive: false,
  });
  const DEF = () => ({
    open: false, bright: 1, sound: true, kbd: false, cur: 0,
    vhf: [{ act: 121500, stby: 118000, on: 1 }, { act: 121500, stby: 118000, on: 1 }, { act: 121500, stby: 118000, on: 1 }],
    hf: [{ act: 5680, stby: 8870, on: 1 }, { act: 5680, stby: 8870, on: 1 }],
    mic: 'vhf0', vol: 60, xp: { code: '2000', mode: 0, identUntil: 0 }, baro: { std: true, qnh: 1013, inhg: false },
    sbArm: false, trimLocal: 0.5,
  });
  const S = DEF(), F = FMC0();
  try {
    const o = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (o) { Object.assign(S, o.S || {}); Object.assign(F, o.F || {}); F.nr = Object.assign(FMC0().nr, F.nr || {}); S.xp = Object.assign(DEF().xp, S.xp || {}); S.baro = Object.assign(DEF().baro, S.baro || {}); }
  } catch (e) { /* ignore */ }
  S.kbd = false; F.exec = null;
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify({ S, F })); } catch (e) { /* ignore */ } }, 300); };
  const cdus = [0, 1, 2].map(() => ({ page: 'MENU', pg: 0, sp: '', msg: '' }));
  const sim = { tx: null, wasAir: false, lnavAt: 0, msgUntil: 0, drag: false };

  /* ───────────────────────── audio ───────────────────────── */
  let ac = null;
  function tone(f, t0, d, type = 'sine', v = .05) {
    if (!S.sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume();
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + t0, vol = v * (0.3 + S.vol / 100);
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + d);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + d + .05);
    } catch (e) { /* ignore */ }
  }
  const sfx = { click: () => tone(1700, 0, .03, 'square', .02), key: () => tone(1300, 0, .025, 'square', .02), roger: () => tone(1250, 0, .09, 'sine', .06),
    selcal: () => { [0, .25, .5, .75].forEach((t, i) => tone([1200, 1500, 1050, 1350][i], t, .2, 'sine', .07)); }, err: () => tone(300, 0, .15, 'square', .04) };

  /* ───────── Hardened GeoFS control bridge (shared: whichever 777 script loads first defines window.GeoFSReal) ─────────
     Every command is VERIFIED by reading GeoFS state back, and falls through several methods until one works:
     1) a controls.setters.* function found by name pattern  2) writing the control value directly  3) a synthetic key press. */
  if (!window.GeoFSReal) (function () {
    const sf = (f, d) => { try { const r = f(); return r === undefined ? d : r; } catch (e) { return d; } };
    const KEYC = { lights: { key: 'l', code: 'KeyL', keyCode: 76 }, gear: { key: 'g', code: 'KeyG', keyCode: 71 }, flapsUp: { key: 'v', code: 'KeyV', keyCode: 86 }, flapsDn: { key: 'f', code: 'KeyF', keyCode: 70 }, airbrk: { key: 'b', code: 'KeyB', keyCode: 66 }, parking: { key: '.', code: 'Period', keyCode: 190 } };
    function key(k) {
      ['keydown', 'keyup'].forEach(type => {
        const ev = new KeyboardEvent(type, { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, bubbles: true, cancelable: true, view: window });
        // WebKit/Blink often ignore keyCode/which in the init dict; GeoFS reads them, so force them.
        try { Object.defineProperty(ev, 'keyCode', { get: () => k.keyCode }); Object.defineProperty(ev, 'which', { get: () => k.keyCode }); } catch (e) { /* ignore */ }
        (document.body || document).dispatchEvent(ev);
      });
    }
    const setterFor = re => { const s = sf(() => controls.setters, {}) || {}; for (const n of Object.keys(s)) if (re.test(n) && sf(() => typeof s[n].set === 'function', false)) return s[n]; return null; };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // drive(read, want, [[name, fn], ...]): try each method until read() === want. Resolves to the method name or 'FAILED'.
    async function drive(read, want, methods, wait = 120) {
      let cur = read(); if (cur !== undefined && cur === want) return 'already';
      for (const [name, fn] of methods) {
        try { fn(); } catch (e) { continue; }
        if (read() === undefined) return name + ' (unverified)';
        await sleep(wait); if (read() === want) return name;
      }
      return 'FAILED';
    }
    const num = (o, k) => { const v = sf(() => o[k], undefined); return typeof v === 'number' ? v : undefined; };
    const R = { KEYC, key, setterFor, last: {} };
    const rec = (k, m) => { R.last[k] = m; return m; };
    R.gear = async (down, loc) => { if (R.remote && !loc) return R.remote('gear', !!down); const read = () => { const t = num(controls.gear, 'target'); return t === undefined ? undefined : (t > .5); };
      const sx = setterFor(/gear/i); return rec('gear', await drive(read, !!down, [['setter', () => sx.set()], ['direct', () => { controls.gear.target = down ? 1 : 0; }], ['key', () => key(KEYC.gear)]])); };
    R.airbrake = async (out, loc) => { if (R.remote && !loc) return R.remote('airbrake', !!out); const read = () => { const t = num(controls.airbrakes, 'target'); if (t !== undefined) return t > .5; const p = num(controls.airbrakes, 'position'); return p === undefined ? undefined : p > .5; };
      const sx = setterFor(/air.?brake|spoiler|speed.?brake/i); return rec('airbrake', await drive(read, !!out, [['setter', () => sx.set()], ['direct', () => { controls.airbrakes.target = out ? 1 : 0; }], ['key', () => key(KEYC.airbrk)]])); };
    R.parking = async (on, loc) => { if (R.remote && !loc) return R.remote('parking', !!on); const read = () => { const v = sf(() => controls.parkingBrake, undefined); return v === undefined ? undefined : !!v; };
      const sx = setterFor(/park/i); return rec('parking', await drive(read, !!on, [['setter', () => sx.set()], ['direct', () => { controls.parkingBrake = on ? 1 : 0; }], ['key', () => key(KEYC.parking)]])); };
    R.flaps = async (i, loc) => { if (R.remote && !loc) return R.remote('flaps', i); const read = () => num(controls.flaps, 'target'); const cur = read();
      return rec('flaps', await drive(read, i, [['direct', () => { controls.flaps.target = i; }], ['key', () => { const d = i - (cur || 0); for (let k = 0; k < Math.abs(d); k++) key(d > 0 ? KEYC.flapsDn : KEYC.flapsUp); }]])); };
    R.lightsState = () => { for (const f of [() => geofs.aircraft.instance.lights.on, () => geofs.aircraft.instance.lightsOn, () => controls.lights, () => geofs.animation.values.lights]) { const r = sf(f, undefined); if (typeof r === 'boolean' || typeof r === 'number') return !!r; } return undefined; };
    R.lights = async on => { const sx = setterFor(/light/i); const tog = () => (sx ? sx.set() : key(KEYC.lights)); const cur = R.lightsState();
      if (cur === undefined) { tog(); return rec('lights', (sx ? 'setter' : 'key') + ' (unverified toggle)'); }
      return rec('lights', await drive(R.lightsState, !!on, [['setter', () => sx && sx.set()], ['key', () => key(KEYC.lights)]])); };
    // Safe-on-ground self test. Returns [{ctl, ok, how}]. Restores everything it touches.
    R.selfTest = async () => {
      const v = sf(() => geofs.animation.values, {}) || {}, ground = !!sf(() => geofs.aircraft.instance.groundContact, true), out = [];
      const add = (ctl, how, extra) => out.push({ ctl, ok: !/FAILED/.test(how), how: how + (extra || '') });
      const found = { gear: !!setterFor(/gear/i), airbrake: !!setterFor(/air.?brake|spoiler|speed.?brake/i), parking: !!setterFor(/park/i), lights: !!setterFor(/light/i) };
      out.push({ ctl: 'API', ok: !!sf(() => controls, null), how: 'setters found: ' + Object.keys(found).filter(k => found[k]).join(', ') + ' | all setters: ' + Object.keys(sf(() => controls.setters, {}) || {}).join(',') });
      if (!ground) { out.push({ ctl: 'TESTS', ok: true, how: 'Aircraft is airborne - active tests skipped (run on the ground)' }); return out; }
      const p0 = !!sf(() => controls.parkingBrake, false); add('PARK BRK on', await R.parking(!p0)); add('PARK BRK restore', await R.parking(p0));
      const a0 = (num(controls.airbrakes, 'target') || 0) > .5; add('SPEEDBRAKE out', await R.airbrake(!a0)); add('SPEEDBRAKE restore', await R.airbrake(a0));
      const f0 = num(controls.flaps, 'target'); if (f0 !== undefined) { add('FLAPS +1', await R.flaps(f0 + 1)); add('FLAPS restore', await R.flaps(f0)); } else out.push({ ctl: 'FLAPS', ok: false, how: 'controls.flaps.target not found' });
      const l0 = R.lightsState(); add('LIGHTS toggle', await R.lights(l0 === undefined ? true : !l0)); await sleep(150); add('LIGHTS restore', await R.lights(l0 === undefined ? false : l0));
      out.push({ ctl: 'GEAR', ok: found.gear || num(controls.gear, 'target') !== undefined, how: found.gear ? 'setter found' : (num(controls.gear, 'target') !== undefined ? 'direct write available' : 'only key press available'), note: 'not exercised on ground' });
      return out;
    };
    window.GeoFSReal = R;
  })();

  /* ───────────────────────── GeoFS bridges ───────────────────────── */
  function pressKey(k) {
    const opt = { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, bubbles: true, cancelable: true };
    ['keydown', 'keyup'].forEach(t => document.body.dispatchEvent(new KeyboardEvent(t, opt)));
  }
  const setterOf = name => safe(() => (typeof controls.setters[name].set === 'function' ? controls.setters[name] : null), null);
  function viaSetterOrKey(name, key) { const s = setterOf(name); if (s) safe(() => s.set()); else pressKey(key); }
  const gearPos = () => { const v = V().gearPosition; return typeof v === 'number' ? v : safe(() => controls.gear.position, 0); };
  const sbPos = () => { const v = V().airbrakesPosition; return typeof v === 'number' ? v : safe(() => controls.airbrakes.position, 0); };
  const parkSet = () => !!safe(() => controls.parkingBrake, false);
  const flapN = () => { const d = safe(() => inst().definition.flapsSteps, null); let n = typeof d === 'number' ? d : Array.isArray(d) ? d.length : safe(() => controls.flaps.maxPosition, 0); return clamp(Math.round(n || 4), 1, 10); };
  const flapIdx = () => { const t = safe(() => controls.flaps.target, undefined); return clamp(Math.round(typeof t === 'number' ? t : (V().flapsValue || 0) * flapN()), 0, 10); };
  function setFlapsIdx(i) {
    const n = flapN(); i = clamp(i, 0, n);
    GeoFSReal.flaps(i).then(m => { if (/FAILED/.test(m)) flash('FLAPS: NO RESPONSE FROM GEOFS'); });
  }
  const FLAP_LABELS = ['UP', '1', '5', '15', '20', '25', '30'];
  const leverToIdx = l => Math.round(l / 6 * flapN());
  const idxToLever = i => Math.round(i / flapN() * 6);
  function ensureAirbrake(out) { if ((sbPos() > .5) !== out) GeoFSReal.airbrake(out); }
  function ensureGear(down) { const p = gearPos(); if (p > .03 && p < .97) return false; if ((p >= .97) !== down) GeoFSReal.gear(down).then(m => { if (/FAILED/.test(m)) flash('GEAR: NO RESPONSE FROM GEOFS'); }); return true; }
  const thr = () => safe(() => controls.throttle, undefined);
  const hasTrim = () => typeof safe(() => controls.elevatorTrim, null) === 'number';
  function pushHdg(b) {
    if (window.GeoFSOverhead && GeoFSOverhead.setAP) GeoFSOverhead.setAP('hdg', b);
    else safe(() => { if (typeof geofs.autopilot.setHeading === 'function') geofs.autopilot.setHeading(b); else geofs.autopilot.values.heading = b; });
  }
  function sendMCP(k, v) {
    if (window.GeoFSOverhead && GeoFSOverhead.setAP) GeoFSOverhead.setAP(k, v);
    else safe(() => { const a = geofs.autopilot, fn = { alt: 'setAltitude', spd: 'setSpeed' }[k]; if (typeof a[fn] === 'function') a[fn](v); });
  }

  /* ───────────────────────── FMC data ───────────────────────── */
  const vSpeeds = () => { const gw = F.zfw + F.fuel, vr = Math.round(140 + (gw - 250) * .25 + (F.flaps === 5 ? 8 : F.flaps === 20 ? -4 : 0)); return { v1: vr - 6, vr, v2: vr + 7 }; };
  const landWt = () => (F.lwo != null ? F.lwo : F.zfw + F.res);
  const vRef = () => { const v30 = Math.round(134 + (landWt() - 200) * .32); return { 25: v30 + 5, 30: v30 }; };
  function loadPlan() {
    const arr = safe(() => geofs.flightPlan.waypointArray, null);
    if (!arr || !arr.length) return 0;
    F.legs = arr.map((w, i) => ({
      id: String(w.ident || w.id || w.name || 'WPT' + (i + 1)).toUpperCase().slice(0, 5),
      lat: w.lat != null ? w.lat : safe(() => w.lla[0]), lon: w.lon != null ? w.lon : safe(() => w.lla[1]), alt: w.alt || null,
    })).filter(l => isFinite(l.lat) && isFinite(l.lon));
    F.active = 0; save(); return F.legs.length;
  }
  function legsDist() { // NM remaining along route from present position
    const p = pos(); if (!p || !F.legs[F.active]) return null;
    let d = gcd(p, F.legs[F.active]); for (let i = F.active; i < F.legs.length - 1; i++) d += gcd(F.legs[i], F.legs[i + 1]); return d;
  }
  function lnavTick() {
    if (!F.lnav || !F.legs.length) return;
    const p = pos(); if (!p) return; let w = F.legs[F.active];
    if (!w) { F.lnav = false; return; }
    if (gcd(p, w) < Math.max(1.2, gsKt() / 90)) {
      F.active++; w = F.legs[F.active];
      if (!w) { F.lnav = false; cdus.forEach(c => { c.msg = 'ROUTE COMPLETE'; }); sim.msgUntil = performance.now() + 6000; return; }
    }
    pushHdg(Math.round(brg(p, w)) % 360);
  }

  /* ───────────────────────── CDU pages ───────────────────────── */
  const BOX = '□□□□';
  const cell = (lab, t, o) => Object.assign({ lab: lab || '', t: t == null ? '' : String(t) }, o);
  const fld = (lab, get, set, o = {}) => { const g = () => { const v = get(); return v == null ? '' : String(v); }; const v = g(); return cell(lab, v || o.empty || BOX, { get: g, set, c: v ? o.c : '' }); };
  const lk = (t, page) => cell('', t, { go: page });
  const act = (lab, t, fn, c) => cell(lab, t, { act: fn, c });
  const info = (lab, t, c) => cell(lab, t, { c });
  const rows6 = r => Array.from({ length: 6 }, (_, i) => r[i] || [null, null]);
  const num = (s, lo, hi) => { const x = parseFloat(s); return isFinite(x) && x >= lo && x <= hi ? x : null; };
  const t1 = v => (v == null ? '' : v.toFixed(1));
  const icao = k => s => { if (s === '') { F[k] = ''; return null; } if (!/^[A-Z]{4}$/.test(s)) return 'INVALID ENTRY'; F[k] = s; F.rteActive = false; return null; };
  const numSet = (k, lo, hi, int) => s => { if (s === '') { F[k] = null; return null; } const x = num(s, lo, hi); if (x == null) return 'INVALID ENTRY'; F[k] = int ? Math.round(x) : x; return null; };
  const parseAlt = s => { const m = /^(?:FL)?(\d{2,5})$/.exec(s); if (!m) return null; let n = +m[1]; if (n < 1000) n *= 100; return n >= 1000 && n <= 43100 ? n : null; };
  const altStr = a => (a >= 18000 ? 'FL' + Math.round(a / 100) : String(a));
  const needPlan = () => { if (!F.legs.length) return true; return false; };
  const toggleLnav = () => { F.lnav = !F.lnav; return F.lnav ? 'LNAV ARMED' : 'LNAV OFF'; };

  const PAGES = {
    MENU: () => ({ title: 'MENU', rows: rows6([[lk('<FMC', 'INITREF'), null], [lk('<ACARS', 'COMM'), null]]) }),
    INITREF: () => ({
      title: 'INIT/REF INDEX', rows: rows6([[lk('<IDENT', 'IDENT'), lk('NAV RAD>', 'NAVRAD')], [lk('<POS', 'POSINIT'), null], [lk('<PERF', 'PERF'), null], [lk('<TAKEOFF', 'TAKEOFF'), null], [lk('<APPROACH', 'APPR'), null]]),
    }),
    IDENT: () => ({
      title: 'IDENT', rows: rows6([
        [info('MODEL', '777-300ER'), info('ENGINES', 'GE90-115B')],
        [info('NAV DATA', 'GEOFS FLT PLAN'), info('ACTIVE', utc(), 'g')],
        [info('GEOFS AIRCRAFT', safe(() => geofs.aircraft.instance.aircraftRecord.name, 'N/A')), null],
        [info('NOTE', 'V-SPEEDS APPROX', 'a'), info('', 'NOT AFM DATA', 'a')],
        null, [lk('<INDEX', 'INITREF'), lk('POS>', 'POSINIT')]]),
    }),
    POSINIT: () => {
      const p = pos();
      return { title: 'POS INIT', rows: rows6([[info('LAST POS', fmtPos(p), 'g'), info('GMT', utc())], [fld('REF AIRPORT', () => F.orig, icao('orig')), info('GS', Math.round(gsKt()) + ' KT')],
        [info('GPS POS', fmtPos(p), 'g'), null], null, null, [lk('<INDEX', 'INITREF'), lk('ROUTE>', 'RTE')]]) };
    },
    RTE: () => ({
      title: F.rteActive ? 'ACT RTE 1' : 'RTE 1',
      rows: rows6([
        [fld('ORIGIN', () => F.orig, icao('orig')), fld('DEST', () => F.dest, icao('dest'))],
        [fld('RUNWAY', () => F.rwy, s => { if (s && !/^\d{2}[LRC]?$/.test(s)) return 'INVALID ENTRY'; F.rwy = s; return null; }), fld('FLT NO', () => F.flt, s => { if (s.length > 8) return 'INVALID ENTRY'; F.flt = s; return null; })],
        [fld('CO ROUTE', () => F.co, s => { if (s.length > 10) return 'INVALID ENTRY'; F.co = s; return null; }), info('LEGS', F.legs.length ? F.legs.length + ' LOADED' : 'NONE', F.legs.length ? 'g' : '')],
        [act('', '<LOAD GEOFS PLAN', () => { const n = loadPlan(); return n ? 'LOADED ' + n + ' WAYPOINTS' : 'NO GEOFS FLIGHT PLAN (SET ONE IN GEOFS)'; }), null],
        null,
        [lk('<INDEX', 'INITREF'), act('', F.rteActive ? 'ACTIVE>' : 'ACTIVATE>', () => { if (!F.orig || !F.dest) return 'ENTER ORIGIN AND DEST'; F.exec = 'RTE'; return null; }, F.exec === 'RTE' ? 'm' : '')]]),
    }),
    PERF: () => ({
      title: 'PERF INIT', rows: rows6([
        [info('GR WT', t1(F.zfw + F.fuel)), fld('CRZ ALT', () => (F.crz ? altStr(F.crz) : ''), s => { if (s === '') return 'INVALID ENTRY'; const a = parseAlt(s); if (!a) return 'INVALID ENTRY'; F.crz = a; return null; })],
        [fld('FUEL', () => t1(F.fuel), s => { const x = num(s, 0, 171); if (x == null) return 'INVALID ENTRY'; F.fuel = x; F.v1 = F.vr = F.v2 = null; return null; }), fld('COST INDEX', () => F.ci, numSet('ci', 0, 999, true))],
        [fld('ZFW', () => t1(F.zfw), s => { const x = num(s, 120, 237.7); if (x == null) return s ? 'INVALID ENTRY (MAX ZFW 237.7)' : 'INVALID ENTRY'; F.zfw = x; F.v1 = F.vr = F.v2 = null; return null; }), info('MAX TOGW', '351.5')],
        [fld('RESERVES', () => t1(F.res), s => { const x = num(s, 0, 40); if (x == null) return 'INVALID ENTRY'; F.res = x; return null; }), null],
        [info('', '(x1000 KG)'), null],
        [lk('<INDEX', 'INITREF'), lk('TAKEOFF>', 'TAKEOFF')]]),
    }),
    TAKEOFF: () => {
      const v = vSpeeds(), gw = F.zfw + F.fuel;
      return {
        title: 'TAKEOFF REF', rows: rows6([
          [fld('FLAPS', () => F.flaps, s => { if (!['5', '15', '20'].includes(s)) return 'INVALID ENTRY'; F.flaps = +s; F.v1 = F.vr = F.v2 = null; return null; }), fld('THRUST', () => F.thr, s => { if (!['TO', 'TO-1', 'TO-2'].includes(s)) return 'INVALID ENTRY'; F.thr = s; return null; })],
          [fld('V1', () => (F.v1 != null ? F.v1 : v.v1), numSet('v1', 80, 200, true), { c: F.v1 != null ? 'm' : 'g' }), info('GW', t1(gw) + (gw > 351.5 ? ' OVER MTOW' : ''), gw > 351.5 ? 'a' : '')],
          [fld('VR', () => (F.vr != null ? F.vr : v.vr), numSet('vr', 80, 200, true), { c: F.vr != null ? 'm' : 'g' }), fld('SEL TEMP', () => F.selT, s => { if (s.length > 4) return 'INVALID ENTRY'; F.selT = s; return null; })],
          [fld('V2', () => (F.v2 != null ? F.v2 : v.v2), numSet('v2', 80, 220, true), { c: F.v2 != null ? 'm' : 'g' }), fld('THR REDUCTION', () => F.redAlt + 'FT', s => { const x = num(s, 400, 5000); if (x == null) return 'INVALID ENTRY'; F.redAlt = Math.round(x); return null; })],
          [fld('RUNWAY', () => F.rwy, s => { F.rwy = s; return null; }), info('SPEEDS', 'APPROX ONLY', 'a')],
          [lk('<INDEX', 'INITREF'), lk('PERF>', 'PERF')]]),
      };
    },
    APPR: () => {
      const vr = vRef(), sel = vr[F.lflap];
      return {
        title: 'APPROACH REF', rows: rows6([
          [fld('GROSS WT', () => t1(landWt()), s => { if (s === '') { F.lwo = null; return null; } const x = num(s, 120, 251.3); if (x == null) return 'INVALID ENTRY (MAX LDG 251.3)'; F.lwo = x; return null; }, { c: F.lwo != null ? 'm' : '' }), info('VREF', sel + ' KT', 'g')],
          [act('FLAPS', '<25  ' + vr[25], () => { F.lflap = 25; return null; }, F.lflap === 25 ? 'g' : ''), null],
          [act('FLAPS', '<30  ' + vr[30], () => { F.lflap = 30; return null; }, F.lflap === 30 ? 'g' : ''), null],
          [fld('DEST', () => F.dest, icao('dest')), info('VAPP', (sel + 5) + ' KT', 'c')],
          [info('LDG WT', 'ZFW+RESERVES UNLESS SET'), null],
          [lk('<INDEX', 'INITREF'), lk('PROG>', 'PROG')]]),
      };
    },
    CRZ: () => ({
      title: 'CRZ', rows: rows6([
        [fld('CRZ ALT', () => (F.crz ? altStr(F.crz) : ''), s => { const a = parseAlt(s); if (!a) return 'INVALID ENTRY'; F.crz = a; return null; }), fld('CRZ SPD', () => F.spd, numSet('spd', 150, 400, true))],
        [fld('COST INDEX', () => F.ci, numSet('ci', 0, 999, true)), null],
        [act('', '<SEND ALT TO MCP', () => { sendMCP('alt', F.crz); return 'MCP ALT ' + F.crz; }, 'c'), act('', 'SEND SPD>', () => { sendMCP('spd', F.spd); return 'MCP SPD ' + F.spd; }, 'c')],
        null, null, [lk('<INDEX', 'INITREF'), lk('LEGS>', 'LEGS')]]),
    }),
    LEGS: c => {
      const n = F.legs.length, count = Math.max(1, Math.ceil(n / 5)), p = pos(), r = [];
      if (!n) r.push([info('NO LEGS', 'LOAD IN RTE', 'a'), null]);
      for (let k = 0; k < 5 && c.pg * 5 + k < n; k++) {
        const i = c.pg * 5 + k, w = F.legs[i], a = i === F.active;
        const lab = p ? Math.round(brg(p, w)) % 360 + '° ' + gcd(p, w).toFixed(0) + 'NM' : '---';
        r.push([cell(lab, w.id, {
          c: a ? 'm' : '', get: () => w.id,
          act: () => { if (c.sp === 'DELETE') { F.legs.splice(i, 1); if (F.active > i) F.active--; c.sp = ''; return 'LEG DELETED'; } F.dt = i; F.exec = 'DIR'; return null; },
        }), info('', w.alt ? altStr(Math.round(w.alt)) : '')]);
      }
      while (r.length < 5) r.push([null, null]);
      r.push([act('', '<LNAV ' + (F.lnav ? 'ON' : 'OFF'), toggleLnav, F.lnav ? 'g' : ''), lk('PROG>', 'PROG')]);
      return { title: F.exec === 'DIR' ? 'MOD RTE 1 LEGS' : 'ACT RTE 1 LEGS', count, rows: r };
    },
    PROG: () => {
      const w = F.legs[F.active], p = pos(), gs = Math.max(gsKt(), 100), d = legsDist(), v = V();
      const dw = w && p ? gcd(p, w) : null;
      const eta = h => { if (!isFinite(h)) return '----Z'; const t = new Date(Date.now() + h * 3600e3); return pad(t.getUTCHours(), 2) + pad(t.getUTCMinutes(), 2) + 'Z'; };
      return {
        title: 'PROGRESS', rows: rows6([
          [info('TO', w ? w.id : '-----', 'm'), info('DTG / ETE', dw != null ? dw.toFixed(0) + 'NM ' + fmtHM(dw / gs) : '---')],
          [info('NEXT', F.legs[F.active + 1] ? F.legs[F.active + 1].id : '-----'), info('ROUTE DTG', d != null ? d.toFixed(0) + 'NM' : '---')],
          [info('DEST', F.dest || '----'), info('ETA', d != null ? eta(d / gs) : '----Z')],
          [info('GS', Math.round(gsKt()) + ' KT'), info('ALT', Math.round(v.altitude || 0) + ' FT')],
          [info('GR WT', t1(F.zfw + F.fuel)), info('FUEL (ENTRY)', t1(F.fuel))],
          [lk('<INDEX', 'INITREF'), lk('LEGS>', 'LEGS')]]),
      };
    },
    NAVRAD: () => {
      const f = (k, lo, hi) => s => { if (s === '') { F.nr[k] = ''; return null; } const x = num(s, lo, hi); if (x == null) return 'INVALID ENTRY'; F.nr[k] = s; return null; };
      return {
        title: 'NAV RADIO', rows: rows6([
          [fld('VOR L', () => F.nr.vorL, f('vorL', 108, 117.95)), fld('VOR R', () => F.nr.vorR, f('vorR', 108, 117.95))],
          [fld('ADF L', () => F.nr.adfL, f('adfL', 190, 1750)), fld('ADF R', () => F.nr.adfR, f('adfR', 190, 1750))],
          [fld('ILS-MLS', () => F.nr.ils, f('ils', 108.1, 111.95)), fld('CRS', () => F.nr.crs, f('crs', 0, 360))],
          [info('', 'LOCAL ONLY - GEOFS HAS', 'a'), null], [info('', 'NO RADIO TUNING', 'a'), null],
          [lk('<INDEX', 'INITREF'), null]]),
      };
    },
    COMM: () => ({
      title: 'FMC COMM', rows: rows6([[info('DATALINK', 'NO COMM', 'a'), info('UTC', utc())], [info('', 'ACARS NOT AVAILABLE IN GEOFS'), null], null, null, null, [lk('<MENU', 'MENU'), null]]),
    }),
  };
  PAGES.DEPARR = () => ({ title: 'DEP/ARR INDEX', rows: rows6([[info('NAV DATA', 'NOT INSTALLED', 'a'), null], [info('', 'INSTALL NAV DATA + ATC'), null], [info('', 'SCRIPT (ALT+N)'), null], null, null, [lk('<INDEX', 'INITREF'), lk('LEGS>', 'LEGS')]]) });
  PAGES.ATCIDX = () => ({ title: 'ATC INDEX', rows: rows6([[info('ATC DATALINK', 'NOT INSTALLED', 'a'), null], [info('', 'INSTALL ATC CONTROLLER'), null], [info('', 'SCRIPT (ALT+T)'), null], null, null, [lk('<INDEX', 'INITREF'), null]]) });
  PAGES.PERFIDX = () => ({ title: 'TRIP / PERF', rows: rows6([[info('TRIP PERF', 'NOT INSTALLED', 'a'), null], [info('', 'INSTALL PERFORMANCE'), null], [info('', 'SCRIPT'), null], null, null, [lk('<INDEX', 'INITREF'), null]]) });
  const KEYPAGE = { perf: 'PERFIDX', atc: 'ATCIDX', deparr: 'DEPARR', initref: 'INITREF', rte: 'RTE', vnav: 'CRZ', legs: 'LEGS', prog: 'PROG', navrad: 'NAVRAD', comm: 'COMM', menu: 'MENU' };

  function cduHtml(c) {
    if (!powered()) return '<div class="gfl-scr off"></div>';
    const pg = (PAGES[c.page] || PAGES.MENU)(c), cnt = pg.count || 1; c.pg = clamp(c.pg, 0, cnt - 1);
    let h = `<div class="ln t"><span></span><span>${esc(pg.title)}</span><span class="pn">${cnt > 1 ? (c.pg + 1) + '/' + cnt : ''}</span></div>`;
    pg.rows.forEach(([L, R]) => {
      L = L || cell('', ''); R = R || cell('', '');
      h += `<div class="ln lb"><span>${esc(L.lab)}</span><span>${esc(R.lab)}</span></div>`;
      h += `<div class="ln dt"><span class="c-${L.c || 'w'}">${esc(L.t)}</span><span class="c-${R.c || 'w'}">${esc(R.t)}</span></div>`;
    });
    h += `<div class="ln sp${c.msg ? ' msg' : ''}">${c.msg ? esc(c.msg) : esc(c.sp) + '<i></i>'}</div>`;
    return `<div class="gfl-scr">${h}</div>`;
  }

  function lsk(side, row) {
    const c = cdus[S.cur]; if (!powered()) return;
    const pg = (PAGES[c.page] || PAGES.MENU)(c), cl = (pg.rows[row] || [])[side]; if (!cl) return;
    sfx.key(); c.msg = '';
    if (cl.go) { c.page = cl.go; c.pg = 0; }
    else if (cl.act) { const m = cl.act(); if (m) c.msg = m; }
    else if (cl.set) {
      if (c.sp) { const err = cl.set(c.sp === 'DELETE' ? '' : c.sp); if (err) { c.msg = err; sfx.err(); } else c.sp = ''; }
      else if (cl.get && cl.get()) c.sp = cl.get();
    }
    save(); renderCdu();
  }
  function cduKey(k, shift) {
    const c = cdus[S.cur]; if (!powered()) return; sfx.key();
    const wasMsg = !!c.msg; c.msg = '';
    if (/^[A-Z0-9.\/]$/.test(k)) { if (c.sp === 'DELETE') c.sp = ''; if (c.sp.length < 22) c.sp += k; }
    else if (k === 'sp') c.sp += ' ';
    else if (k === '+/-') c.sp = c.sp.endsWith('+') ? c.sp.slice(0, -1) + '-' : c.sp.endsWith('-') ? c.sp.slice(0, -1) + '+' : c.sp + '-';
    else if (k === 'del') c.sp = 'DELETE';
    else if (k === 'clr') { if (!wasMsg) c.sp = shift || c.sp === 'DELETE' ? '' : c.sp.slice(0, -1); }
    else if (KEYPAGE[k]) { c.page = KEYPAGE[k]; c.pg = 0; }
    else if (k === 'prev') c.pg = Math.max(0, c.pg - 1);
    else if (k === 'next') c.pg++;
    else if (k === 'exec') execute(c);
    else c.msg = 'KEY NOT ACTIVE';
    renderCdu();
  }
  function execute(c) {
    if (!F.exec) { c.msg = 'NO MODS TO EXECUTE'; return; }
    if (F.exec === 'RTE') { F.rteActive = true; c.msg = 'ROUTE ACTIVATED'; }
    else if (F.exec === 'DIR' && F.dt != null && F.legs[F.dt]) { F.active = F.dt; F.lnav = true; c.msg = 'DIRECT TO ' + F.legs[F.dt].id + ' - LNAV ARMED'; }
    F.exec = null; F.dt = null; save();
  }

  /* ───────────────────────── radios / xpdr ───────────────────────── */
  const RNG = { vhf: { lo: 118000, hi: 136975, fine: 25 }, hf: { lo: 2000, hi: 29999, fine: 1 } };
  const fmtF = k => (k / 1000).toFixed(3);
  function stepRadio(kind, i, which, dir) {
    const r = S[kind][i], g = RNG[kind], span = g.hi - g.lo + g.fine;
    r.stby = ((r.stby + (which === 'f' ? g.fine : 1000) * dir - g.lo) % span + span) % span + g.lo; sfx.click(); save(); renderRadios();
  }
  function setStby(kind, i, str) {
    const g = RNG[kind], k = Math.round(parseFloat(String(str).replace(',', '.')) * 1000);
    if (!isFinite(k) || k < g.lo || k > g.hi || k % (kind === 'vhf' ? 5 : 1)) { sfx.err(); flash('INVALID FREQUENCY ' + str); return false; }
    S[kind][i].stby = k; sfx.click(); save(); return true;
  }
  function flash(m) { const el = $('#gfl-msg'); if (!el) return; el.textContent = m; sim.msgUntil = performance.now() + 3500; }

  /* ───────────────────────── UI ───────────────────────── */
  const CSS = `
  #gfl-root,#gfl-root *{box-sizing:border-box}
  #gfl-root{position:fixed;left:50%;bottom:0;z-index:99990;width:min(1320px,99vw);transform:translate(-50%,100%);transition:transform .38s cubic-bezier(.2,.8,.2,1);
    font:600 11px/1.2 "Segoe UI",system-ui,sans-serif;color:#d9dfe3;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;filter:brightness(var(--gfl-b,1))}
  #gfl-root.open{transform:translate(-50%,0)}
  #gfl-tab{all:unset;position:absolute;left:50%;bottom:100%;margin-left:-60px;width:120px;height:20px;text-align:center;line-height:20px;cursor:pointer;
    background:linear-gradient(#3a3f44,#2a2e32);border:1px solid #0d0f11;border-bottom:none;border-radius:9px 9px 0 0;font-size:10px;letter-spacing:.14em;color:#cfd6db;box-shadow:0 -3px 8px #0008}
  #gfl-tab:hover{color:#fff}
  .gfl-body{background:linear-gradient(#383d42,#272b2f);border:2px solid #121416;border-bottom:none;border-radius:16px 16px 0 0;box-shadow:0 -14px 44px #000b,inset 0 1px 0 #ffffff22;padding:8px 10px calc(10px + env(safe-area-inset-bottom,0px));max-height:72vh;max-height:72dvh;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
  .gfl-head{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #00000055;box-shadow:0 1px 0 #ffffff12}
  .gfl-title{font-size:13px;letter-spacing:.16em;color:#f1f4f6}.gfl-title small{font-size:9px;color:#8e99a1;letter-spacing:.05em;margin-left:4px}
  .gfl-msg{flex:1 1 180px;min-width:150px;background:#07140c;border:1px solid #000;border-radius:3px;padding:5px 8px;font:700 11px Consolas,monospace;color:#6dff9b;box-shadow:inset 0 1px 4px #000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gfl-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.gfl-tools label{display:flex;gap:5px;align-items:center;font-size:9px;letter-spacing:.1em;color:#9aa5ad}.gfl-tools input[type=range]{width:70px;accent-color:#e6b84a}
  .gfl-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:4px 8px;border-radius:3px;background:linear-gradient(#4b5157,#353a3f);border:1px solid #0d0f11;font-size:9.5px;letter-spacing:.06em;color:#dfe5e9;box-shadow:0 1px 0 #0007,inset 0 1px 0 #ffffff22;text-align:center;white-space:nowrap}
  .gfl-btn:active{transform:translateY(1px)}.gfl-btn.on{color:#6dff9b;box-shadow:0 0 6px #2cff8a55,inset 0 1px 0 #ffffff22}.gfl-btn.amb{color:#ffd470;box-shadow:0 0 8px #ffa31a77}.gfl-btn.red{color:#ffb1a8;box-shadow:0 0 8px #ff463a88}
  .gfl-btn:focus-visible,#gfl-tab:focus-visible{outline:2px solid #7cc4ff;outline-offset:1px}
  .gfl-grid{display:flex;flex-wrap:wrap;gap:14px 10px;align-items:flex-start}
  .gfl-grp{position:relative;flex:1 1 auto;border:1px solid #0b0d0f;border-radius:6px;padding:15px 9px 9px;background:#0000001c;box-shadow:inset 0 0 0 1px #ffffff0e}
  .gfl-grp>h4{position:absolute;margin:0;top:-1px;left:10px;transform:translateY(-50%);background:#30353a;padding:0 6px;font-size:9.5px;letter-spacing:.14em;color:#eef2f4;font-weight:700}
  /* CDU */
  .gfl-cdu{display:flex;gap:4px;justify-content:center}.gfl-lsks{display:flex;flex-direction:column;padding-top:21px}
  .gfl-lsk{all:unset;cursor:pointer;width:22px;height:30px;display:flex;align-items:center;justify-content:center;color:#9aa5ad;font-size:9px}.gfl-lsk::before{content:"";width:14px;height:10px;border-radius:2px;background:linear-gradient(#5a6168,#3a3f44);border:1px solid #0b0d0f;box-shadow:0 1px 0 #000a}
  .gfl-lsk:active::before{transform:translateY(1px)}.gfl-lsk:focus-visible{outline:2px solid #7cc4ff}
  .gfl-scr{width:25ch;font:700 14px/1 Consolas,"Courier New",monospace;background:#050a07;border:2px solid #000;border-radius:4px;padding:0 4px;box-shadow:inset 0 0 14px #000;color:#e9eef0;cursor:text}
  .gfl-scr.off{height:243px}
  .gfl-scr.kbd,.gfl-scr:focus{outline:2px solid #7cc4ff}
  .gfl-scr .ln{display:flex;justify-content:space-between;white-space:pre;overflow:hidden}
  .gfl-scr .t{height:21px;align-items:center;display:grid;grid-template-columns:1fr auto 1fr}.gfl-scr .t span:first-child{}.gfl-scr .t .pn{text-align:right;font-size:12px;color:#cfd6db}
  .gfl-scr .lb{height:12px;font-size:9.5px;color:#cfd6db;align-items:flex-end}.gfl-scr .dt{height:18px;align-items:center}
  .gfl-scr .sp{height:22px;align-items:center;border-top:1px solid #1b2a22;color:#fff}.gfl-scr .sp.msg{color:#ffbf47}.gfl-scr .sp i{display:inline-block;width:7px;height:2px;background:#e9eef0;margin-left:1px;animation:gfl-bl 1s steps(2) infinite}
  .c-w{color:#e9eef0}.c-g{color:#3dff7a}.c-m{color:#ff5cf0}.c-c{color:#4fe3ff}.c-a{color:#ffbf47}
  @keyframes gfl-bl{50%{opacity:0}}
  .gfl-fk{display:grid;grid-template-columns:repeat(5,1fr);gap:3px;margin-top:6px}
  .gfl-k{all:unset;box-sizing:border-box;cursor:pointer;height:22px;text-align:center;line-height:20px;border-radius:3px;border:1px solid #0b0d0f;background:linear-gradient(#4b5157,#353a3f);font-size:8.5px;letter-spacing:.02em;color:#e6ebee;box-shadow:0 1px 0 #000a,inset 0 1px 0 #ffffff22;overflow:hidden}
  .gfl-k:active{transform:translateY(1px)}.gfl-k.fn{background:linear-gradient(#3b4046,#2a2e32);color:#cfd6db}.gfl-k.exec.lit{background:#0f4a2e;color:#7dffb4;box-shadow:0 0 9px #27e58b99}
  .gfl-k:focus-visible{outline:2px solid #7cc4ff}
  .gfl-sel{display:flex;gap:4px;margin-bottom:6px;justify-content:center}
  /* radios */
  .gfl-rad{display:grid;grid-template-columns:repeat(auto-fill,minmax(224px,1fr));gap:8px}
  .gfl-rtp{border:1px solid #0b0d0f;border-radius:5px;padding:6px;background:#00000026;box-shadow:inset 0 0 0 1px #ffffff0c}
  .gfl-rtp .hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;font-size:10px;letter-spacing:.1em;color:#eef2f4}
  .gfl-rtp .fr{display:flex;gap:6px}.gfl-rtp .fr label{flex:1;display:flex;flex-direction:column;gap:2px;font-size:8px;letter-spacing:.1em;color:#9aa5ad}
  .gfl-lcd,.gfl-rtp output{display:block;background:#07140c;border:1px solid #000;border-radius:3px;padding:3px 5px;color:#6dff9b;font:700 15px Consolas,monospace;text-align:right;box-shadow:inset 0 1px 4px #000;height:26px;line-height:18px}
  .gfl-rtp input{all:unset;box-sizing:border-box;width:100%;background:#07140c;border:1px solid #000;border-radius:3px;padding:3px 5px;color:#ffd470;font:700 15px Consolas,monospace;text-align:right;box-shadow:inset 0 1px 4px #000;height:26px;user-select:text;-webkit-user-select:text}
  .gfl-rtp input:focus{outline:2px solid #7cc4ff}.gfl-rtp.dim output,.gfl-rtp.dim input{color:#1c3a28}.gfl-rtp.tx{box-shadow:0 0 0 1px #ff5a4a,0 0 10px #ff3b2e88}
  .gfl-rtp .bt{display:flex;flex-wrap:wrap;gap:3px;margin-top:5px}
  .gfl-xp{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;margin-top:10px}.gfl-xp .code{font:700 22px Consolas,monospace;letter-spacing:.2em;width:100px}
  .gfl-keys{display:grid;grid-template-columns:repeat(5,28px);gap:3px}.gfl-sub{font-size:8.5px;letter-spacing:.1em;color:#9aa5ad;margin:8px 0 3px}
  /* pedestal */
  .gfl-ped{display:flex;flex-wrap:wrap;gap:10px 16px}
  .gfl-blk{display:flex;flex-direction:column;gap:4px;min-width:150px}.gfl-blk>span{font-size:8.5px;letter-spacing:.12em;color:#9aa5ad}
  .gfl-row{display:flex;gap:3px;flex-wrap:wrap}.gfl-blk input[type=range]{width:100%;accent-color:#e6b84a}
  .gfl-sby{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:10px}.gfl-sby div{background:#07140c;border:1px solid #000;border-radius:3px;padding:3px 6px;box-shadow:inset 0 1px 4px #000}
  .gfl-sby span{display:block;font-size:8px;color:#4a8d63;letter-spacing:.1em}.gfl-sby b{font:700 14px Consolas,monospace;color:#6dff9b}
  .gfl-in{all:unset;box-sizing:border-box;width:64px;padding:3px 5px;border-radius:3px;background:#07140c;border:1px solid #000;color:#ffd470;font:700 13px Consolas,monospace;text-align:right;user-select:text;-webkit-user-select:text}.gfl-in:focus{outline:2px solid #7cc4ff}
  /* touch / iPad (Orion, Safari): bigger targets, 16px inputs so iOS doesn't zoom on focus */
  @media (pointer:coarse),(hover:none){
    .gfl-btn{padding:11px 12px;font-size:11px}.gfl-k{height:38px;line-height:36px;font-size:10.5px}.gfl-keys{grid-template-columns:repeat(5,44px)}
    .gfl-lsks{padding-top:24px}.gfl-lsk{width:40px;height:36px}.gfl-lsk::before{width:22px;height:14px}
    .gfl-scr .t{height:24px}.gfl-scr .lb{height:14px}.gfl-scr .dt{height:22px}.gfl-scr .sp{height:26px}.gfl-scr.off{height:290px}
    .gfl-rtp input,.gfl-in{font-size:16px;height:36px}.gfl-in{width:84px}.gfl-rtp output{height:36px;line-height:26px}.gfl-xp .code{height:40px;line-height:30px}
    .gfl-blk input[type=range]{height:34px}.gfl-sby b{font-size:15px}
    #gfl-tab{width:150px;margin-left:-75px;height:34px;line-height:34px;font-size:12px}
    .gfl-tools input[type=range]{width:110px;height:28px}.gfl-grid{gap:18px 10px}
  }
  @media (prefers-reduced-motion:reduce){#gfl-root{transition:none}.gfl-scr .sp i{animation:none}}
  `;

  const KR = [['INIT REF', 'initref'], ['RTE', 'rte'], ['DEP ARR', 'deparr'], ['ALTN', 'altn'], ['VNAV', 'vnav'], ['FIX', 'fix'], ['LEGS', 'legs'], ['HOLD', 'hold'], ['FMC COMM', 'comm'], ['PROG', 'prog'],
    ['PERF', 'perf'], ['ATC', 'atc'], ['MENU', 'menu'], ['NAV RAD', 'navrad'], ['PREV', 'prev'], ['NEXT', 'next'], ['EXEC', 'exec']];
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(['sp', 'del', '/', 'clr']);
  const DIG = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '+/-'];
  const RAD_DEF = [['vhf', 0, 'VHF L'], ['vhf', 1, 'VHF C'], ['vhf', 2, 'VHF R'], ['hf', 0, 'HF L'], ['hf', 1, 'HF R']];
  let root = null;

  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'gfl-root';
    root.innerHTML = `
    <div class="gfl-body">
      <div class="gfl-head">
        <div class="gfl-title">777-300ER LOWER PANEL <small>v${VERSION}</small></div>
        <div class="gfl-msg" id="gfl-msg" role="status">READY</div>
        <div class="gfl-tools"><label>BRT <input type="range" min="40" max="130" id="gfl-brt" aria-label="Panel brightness"></label>
          <label>VOL <input type="range" min="0" max="100" id="gfl-vol" aria-label="Audio volume"></label>
          <button class="gfl-btn" data-a="sound">SOUND</button><button class="gfl-btn" data-a="close">CLOSE</button></div>
      </div>
      <div class="gfl-grid">
        <section class="gfl-grp" data-g="cdu" style="flex:0 0 auto"><h4>CDU</h4>
          <div class="gfl-sel">${['L', 'C', 'R'].map((n, i) => `<button class="gfl-btn" data-cdu="${i}">${n} CDU</button>`).join('')}</div>
          <div class="gfl-cdu"><div class="gfl-lsks">${[0, 1, 2, 3, 4, 5].map(i => `<button class="gfl-lsk" data-lsk="0,${i}" aria-label="${i + 1}L"></button>`).join('')}</div>
            <div id="gfl-scr" tabindex="0" aria-label="CDU screen"></div>
            <div class="gfl-lsks">${[0, 1, 2, 3, 4, 5].map(i => `<button class="gfl-lsk" data-lsk="1,${i}" aria-label="${i + 1}R"></button>`).join('')}</div></div>
          <div class="gfl-fk">${KR.map(([l, k]) => `<button class="gfl-k fn${k === 'exec' ? ' exec' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
          <div class="gfl-fk">${DIG.map(k => `<button class="gfl-k" data-k="${k}">${k === 'sp' ? 'SP' : k}</button>`).join('')}</div>
          <div class="gfl-fk">${ALPHA.map(k => `<button class="gfl-k" data-k="${k}">${k === 'sp' ? 'SP' : k === 'del' ? 'DEL' : k === 'clr' ? 'CLR' : k}</button>`).join('')}</div>
        </section>
        <section class="gfl-grp" data-g="radio" style="flex:1 1 470px"><h4>RADIO / TRANSPONDER</h4>
          <div class="gfl-rad">${RAD_DEF.map(([k, i, n]) => `<div class="gfl-rtp" data-k="${k}" data-i="${i}"><div class="hd"><b>${n}</b><span><button class="gfl-btn" data-r="mic">MIC</button> <button class="gfl-btn" data-r="pwr">ON</button></span></div>
            <div class="fr"><label>ACTIVE<output data-o="act"></output></label><label>STANDBY<input data-o="stby" inputmode="decimal" aria-label="${n} standby frequency"></label></div>
            <div class="bt"><button class="gfl-btn" data-r="xfer">⇄ XFER</button><button class="gfl-btn" data-r="dnm" title="-1 MHz">MHz −</button><button class="gfl-btn" data-r="upm">MHz +</button><button class="gfl-btn" data-r="dnf">kHz −</button><button class="gfl-btn" data-r="upf">kHz +</button>${k === 'vhf' ? '<button class="gfl-btn" data-r="emer">121.5</button>' : ''}</div></div>`).join('')}</div>
          <div class="gfl-xp">
            <div><div class="gfl-sub">TRANSPONDER</div><output class="gfl-lcd code" id="gfl-xcode"></output>
              <div class="gfl-row" style="margin-top:4px"><button class="gfl-btn" data-x="ident">IDENT</button><button class="gfl-btn" data-x="clr">CLR</button></div></div>
            <div><div class="gfl-sub">CODE ENTRY (0-7)</div><div class="gfl-keys">${[0, 1, 2, 3, 4, 5, 6, 7].map(n => `<button class="gfl-k" data-x="${n}">${n}</button>`).join('')}</div></div>
            <div><div class="gfl-sub">MODE</div><div class="gfl-row" style="max-width:250px">${['STBY', 'ALT OFF', 'XPNDR', 'TA ONLY', 'TA/RA'].map((m, i) => `<button class="gfl-btn" data-xm="${i}">${m}</button>`).join('')}</div></div>
            <div><div class="gfl-sub">ACP</div><div class="gfl-row"><button class="gfl-btn red" data-a="ptt" id="gfl-ptt" title="Hold to transmit on the selected MIC (local only)">PTT</button><button class="gfl-btn" data-a="selcal">SELCAL</button></div></div>
          </div>
        </section>
        <section class="gfl-grp" data-g="ped" style="flex:1 1 380px"><h4>PEDESTAL / STANDBY</h4>
          <div class="gfl-ped">
            <div class="gfl-blk" style="min-width:210px"><span>THRUST LEVERS <em id="gfl-thrv" style="font-style:normal;color:#6dff9b"></em></span><input type="range" id="gfl-thr" min="0" max="100" aria-label="Thrust lever">
              <div class="gfl-row"><button class="gfl-btn" data-t="0">IDLE</button><button class="gfl-btn" data-t="85">CLB</button><button class="gfl-btn" data-t="100">TO/GA</button></div></div>
            <div class="gfl-blk"><span>SPEEDBRAKE LEVER</span><div class="gfl-row"><button class="gfl-btn" data-sb="down">DOWN</button><button class="gfl-btn" data-sb="arm">ARMED</button><button class="gfl-btn" data-sb="up">FLIGHT</button></div></div>
            <div class="gfl-blk"><span>FLAP LEVER</span><div class="gfl-row">${FLAP_LABELS.map((l, i) => `<button class="gfl-btn" data-fl="${i}">${l}</button>`).join('')}</div></div>
            <div class="gfl-blk"><span>GEAR LEVER</span><div class="gfl-row"><button class="gfl-btn" data-g="up">UP</button><button class="gfl-btn" data-g="dn">DN</button></div></div>
            <div class="gfl-blk"><span>PARKING BRAKE</span><div class="gfl-row"><button class="gfl-btn" data-pb="1" id="gfl-pbk">SET</button></div></div>
            <div class="gfl-blk"><span>STAB TRIM <em id="gfl-trimv" style="font-style:normal;color:#6dff9b"></em></span><div class="gfl-row"><button class="gfl-btn" data-tr="-1">NOSE DN</button><button class="gfl-btn" data-tr="1">NOSE UP</button></div></div>
            <div class="gfl-blk"><span>BARO (EFIS)</span><div class="gfl-row"><button class="gfl-btn" data-b="std">STD</button><button class="gfl-btn" data-b="unit">hPa</button><input class="gfl-in" id="gfl-qnh" inputmode="decimal" aria-label="QNH"></div></div>
          </div>
          <div class="gfl-sby" id="gfl-sby">${['IAS', 'ALT', 'HDG', 'V/S', 'MACH', 'GS', 'RPM', 'CAB'].map(k => `<div><span>${k}</span><b data-s="${k}">---</b></div>`).join('')}</div>
        </section>
      </div></div>
    <button id="gfl-tab" aria-label="Toggle lower panel (Alt+P)">▲ PEDESTAL</button>`;
    document.body.appendChild(root);
    $('#gfl-brt').value = Math.round(S.bright * 100); $('#gfl-vol').value = S.vol; root.style.setProperty('--gfl-b', S.bright);
    ['pointerdown', 'mousedown', 'touchstart', 'touchmove'].forEach(ev => root.addEventListener(ev, e => e.stopPropagation(), { passive: true })); // keep taps off GeoFS's own touch controls
    const unlock = () => { tone(20, 0, .01, 'sine', .0001); document.removeEventListener('pointerdown', unlock, true); }; // iOS: start WebAudio from the first touch
    document.addEventListener('pointerdown', unlock, true);
    bind(); applyOpen(); renderCdu(); renderRadios();
  }

  function bind() {
    const stop = e => e.stopPropagation();
    $$('input[type=text],input:not([type]),.gfl-in', root).forEach(i => { i.addEventListener('keydown', stop); i.addEventListener('keyup', stop); });
    $('#gfl-tab').addEventListener('click', () => toggle());
    $('#gfl-brt').addEventListener('input', e => { S.bright = +e.target.value / 100; root.style.setProperty('--gfl-b', S.bright); save(); });
    $('#gfl-vol').addEventListener('input', e => { S.vol = +e.target.value; save(); });
    $('#gfl-scr').addEventListener('click', () => { S.kbd = true; renderCdu(); });
    document.addEventListener('pointerdown', e => { if (S.kbd && !e.target.closest('#gfl-scr')) { S.kbd = false; renderCdu(); } }, true);

    root.addEventListener('click', e => {
      const t = e.target;
      let b;
      if ((b = t.closest('[data-lsk]'))) { const [s, r] = b.dataset.lsk.split(',').map(Number); return lsk(s, r); }
      if ((b = t.closest('[data-k]')) && b.closest('.gfl-fk')) return cduKey(/^[A-Z]$/.test(b.dataset.k) ? b.dataset.k : b.dataset.k, e.shiftKey);
      if ((b = t.closest('[data-cdu]'))) { S.cur = +b.dataset.cdu; sfx.click(); save(); return renderCdu(); }
      if ((b = t.closest('[data-r]'))) return radioAct(b);
      if ((b = t.closest('[data-x]'))) return xpAct(b.dataset.x);
      if ((b = t.closest('[data-xm]'))) { S.xp.mode = +b.dataset.xm; sfx.click(); save(); return renderRadios(); }
      if ((b = t.closest('[data-t]'))) { setThr(+b.dataset.t); return; }
      if ((b = t.closest('[data-sb]'))) return sbLever(b.dataset.sb);
      if ((b = t.closest('[data-fl]'))) { setFlapsIdx(leverToIdx(+b.dataset.fl)); sfx.click(); return; }
      if ((b = t.closest('[data-g]')) && b.closest('.gfl-blk')) { if (!ensureGear(b.dataset.g === 'dn')) flash('GEAR IN TRANSIT'); sfx.click(); return; }
      if ((b = t.closest('[data-pb]'))) { GeoFSReal.parking(!parkSet()).then(m => { if (/FAILED/.test(m)) flash('PARK BRK: NO RESPONSE FROM GEOFS'); }); sfx.click(); return; }
      if ((b = t.closest('[data-tr]'))) return trim(+b.dataset.tr);
      if ((b = t.closest('[data-b]'))) { if (b.dataset.b === 'std') S.baro.std = !S.baro.std; else S.baro.inhg = !S.baro.inhg; sfx.click(); save(); return; }
      if ((b = t.closest('[data-a]'))) {
        switch (b.dataset.a) {
          case 'close': return toggle(false);
          case 'sound': S.sound = !S.sound; if (S.sound) sfx.click(); save(); return;
          case 'selcal': return sfx.selcal();
        }
      }
    });
    root.addEventListener('wheel', e => {
      const rt = e.target.closest('.gfl-rtp'); if (rt && e.target.closest('input')) { e.preventDefault(); stepRadio(rt.dataset.k, +rt.dataset.i, e.shiftKey ? 'm' : 'f', e.deltaY < 0 ? 1 : -1); }
      else if (e.target.closest('[data-tr]')) { e.preventDefault(); trim(e.deltaY < 0 ? 1 : -1); }
    }, { passive: false });
    root.addEventListener('change', e => {
      const inp = e.target.closest('input[data-o=stby]'); if (inp) { const rt = inp.closest('.gfl-rtp'); setStby(rt.dataset.k, +rt.dataset.i, inp.value); renderRadios(true); }
      if (e.target.id === 'gfl-qnh') { let x = parseFloat(e.target.value); if (S.baro.inhg) x *= 33.8639; if (isFinite(x) && x > 900 && x < 1100) { S.baro.qnh = x; S.baro.std = false; save(); } else flash('INVALID QNH'); }
    });
    root.addEventListener('keydown', e => { if (e.target.matches('input')) { stop(e); if (e.key === 'Enter') e.target.blur(); } }, true);
    const ptt = $('#gfl-ptt'), down = () => { const [k, i] = [S.mic.slice(0, -1), +S.mic.slice(-1)]; if (S[k] && S[k][i].on && powered()) { sim.tx = S.mic; renderRadios(); } };
    const up = () => { if (sim.tx) { sim.tx = null; sfx.roger(); renderRadios(); } };
    ptt.addEventListener('mousedown', down); ptt.addEventListener('mouseup', up); ptt.addEventListener('mouseleave', up);
    ptt.addEventListener('touchstart', e => { e.preventDefault(); down(); }, { passive: false }); ptt.addEventListener('touchend', up);
    const thrEl = $('#gfl-thr');
    thrEl.addEventListener('pointerdown', () => { sim.drag = true; }); window.addEventListener('pointerup', () => { sim.drag = false; }); window.addEventListener('pointercancel', () => { sim.drag = false; });
    thrEl.addEventListener('input', () => setThr(+thrEl.value, true));
  }

  function setThr(p, silent) { if (thr() === undefined) { flash('THROTTLE NOT AVAILABLE'); return; } safe(() => { controls.throttle = clamp(p, 0, 100) / 100; }); if (!silent) sfx.click(); }
  function sbLever(m) {
    if (m === 'arm') { S.sbArm = true; ensureAirbrake(false); flash('SPEEDBRAKE ARMED'); }
    else { S.sbArm = false; ensureAirbrake(m === 'up'); }
    sfx.click(); save();
  }
  function trim(d) {
    if (hasTrim()) { safe(() => { controls.elevatorTrim = clamp(controls.elevatorTrim + d * 0.02, -1, 1); }); sfx.click(); }
    else flash('TRIM NOT EXPOSED BY THIS AIRCRAFT');
  }
  function radioAct(b) {
    const rt = b.closest('.gfl-rtp'), k = rt.dataset.k, i = +rt.dataset.i, r = S[k][i];
    switch (b.dataset.r) {
      case 'xfer': { const a = r.act; r.act = r.stby; r.stby = a; sfx.click(); break; }
      case 'dnm': return stepRadio(k, i, 'm', -1);
      case 'upm': return stepRadio(k, i, 'm', 1);
      case 'dnf': return stepRadio(k, i, 'f', -1);
      case 'upf': return stepRadio(k, i, 'f', 1);
      case 'emer': r.stby = 121500; sfx.click(); break;
      case 'mic': S.mic = k + i; sfx.click(); break;
      case 'pwr': r.on = r.on ? 0 : 1; sfx.click(); break;
    }
    save(); renderRadios();
  }
  function xpAct(x) {
    const xp = S.xp; sfx.key();
    if (x === 'ident') { if (S.xp.mode >= 2) xp.identUntil = Date.now() + 18000; else flash('SET MODE XPNDR FIRST'); }
    else if (x === 'clr') { xp.entry = ''; }
    else { xp.entry = (xp.entry || '') + x; if (xp.entry.length >= 4) { xp.code = xp.entry.slice(0, 4); xp.entry = ''; } }
    save(); renderRadios();
  }

  function renderCdu() {
    if (!root) return;
    const el = $('#gfl-scr'); if (!el) return;
    el.innerHTML = cduHtml(cdus[S.cur]); const s = $('.gfl-scr', el); if (s) s.classList.toggle('kbd', S.kbd);
    $$('[data-cdu]', root).forEach(b => b.classList.toggle('on', +b.dataset.cdu === S.cur));
    const ex = $('.gfl-k.exec', root); if (ex) ex.classList.toggle('lit', !!F.exec && powered());
  }
  function renderRadios(forceInputs) {
    if (!root) return; const p = powered();
    $$('.gfl-rtp', root).forEach(rt => {
      const k = rt.dataset.k, i = +rt.dataset.i, r = S[k][i], live = p && r.on, tx = sim.tx === k + i;
      rt.classList.toggle('dim', !live); rt.classList.toggle('tx', tx);
      $('[data-o=act]', rt).textContent = live ? fmtF(r.act) : '------';
      const inp = $('[data-o=stby]', rt); if (document.activeElement !== inp || forceInputs) inp.value = live ? fmtF(r.stby) : '';
      inp.disabled = !live;
      $('[data-r=pwr]', rt).classList.toggle('on', !!r.on); $('[data-r=pwr]', rt).textContent = r.on ? 'ON' : 'OFF';
      $('[data-r=mic]', rt).classList.toggle('amb', S.mic === k + i);
    });
    const xp = S.xp, ident = Date.now() < xp.identUntil;
    $('#gfl-xcode').textContent = p ? (xp.entry ? xp.entry.padEnd(4, '_') : xp.code) : '----';
    $$('[data-xm]', root).forEach(b => b.classList.toggle('on', +b.dataset.xm === xp.mode));
    $('[data-x=ident]', root).classList.toggle('amb', ident);
    $('#gfl-ptt').classList.toggle('on', !!sim.tx);
  }

  function renderLive() {
    if (!S.open) return;
    const v = V(), alt = v.altitude || 0, bq = S.baro;
    const ind = bq.std ? alt : alt + (bq.qnh - 1013.25) * 27;
    const set = (k, t) => { const el = $(`[data-s="${k}"]`, root); if (el) el.textContent = t; };
    set('IAS', Math.round(v.kias || 0) + ' kt'); set('ALT', Math.round(ind) + ' ft'); set('HDG', pad(Math.round(((v.heading360 != null ? v.heading360 : v.heading) || 0) % 360), 3) + '°');
    set('V/S', Math.round(v.verticalSpeed || 0) + ' fpm'); set('MACH', (v.mach != null ? v.mach : 0).toFixed(3)); set('GS', Math.round(gsKt()) + ' kt');
    set('RPM', Math.round(v.rpm || 0)); set('CAB', safe(() => Math.round(GeoFSOverhead.sim.cabAlt) + ' ft', 'n/a'));
    const t = thr(), te = $('#gfl-thr'); te.disabled = t === undefined;
    if (t !== undefined) { $('#gfl-thrv').textContent = Math.round(t * 100) + '%'; if (!sim.drag) te.value = Math.round(t * 100); }
    const sb = sbPos() > .5; $$('[data-sb]', root).forEach(b => b.classList.toggle('amb', (b.dataset.sb === 'up' && sb) || (b.dataset.sb === 'arm' && S.sbArm && !sb) || (b.dataset.sb === 'down' && !sb && !S.sbArm)));
    const li = idxToLever(flapIdx()); $$('[data-fl]', root).forEach(b => b.classList.toggle('amb', +b.dataset.fl === li));
    const gp = gearPos(); $$('[data-g]', root).forEach(b => { if (b.closest('.gfl-blk')) b.classList.toggle('on', (b.dataset.g === 'dn' && gp >= .97) || (b.dataset.g === 'up' && gp <= .03)); });
    $('#gfl-pbk').classList.toggle('amb', parkSet()); $('#gfl-pbk').textContent = parkSet() ? 'SET' : 'RELEASED';
    $('#gfl-trimv').textContent = hasTrim() ? (7.5 + controls.elevatorTrim * 7.5).toFixed(1) + ' U' : 'N/A';
    $('[data-b=std]', root).classList.toggle('on', bq.std); $('[data-b=unit]', root).textContent = bq.inhg ? 'inHg' : 'hPa';
    const q = $('#gfl-qnh'); if (document.activeElement !== q) q.value = bq.inhg ? (bq.qnh / 33.8639).toFixed(2) : Math.round(bq.qnh);
    const msg = $('#gfl-msg'); if (performance.now() > sim.msgUntil && msg.textContent !== 'READY') msg.textContent = 'READY';
  }

  function applyOpen() { root.classList.toggle('open', S.open); $('#gfl-tab').textContent = S.open ? '▼ STOW' : '▲ PEDESTAL'; if (S.open) { renderCdu(); renderRadios(); renderLive(); } }
  function toggle(force) { S.open = typeof force === 'boolean' ? force : !S.open; sfx.click(); save(); applyOpen(); }

  /* ───────────────────────── tick + input ───────────────────────── */
  function tick() {
    const v = V(), ground = onGround(v);
    if (S.sbArm && ground && sim.wasAir) { ensureAirbrake(true); S.sbArm = false; flash('SPEEDBRAKES AUTO-DEPLOYED'); save(); }
    sim.wasAir = !ground;
    if (performance.now() - sim.lnavAt > 1000) { sim.lnavAt = performance.now(); lnavTick(); }
    if (!S.open) return;
    renderCdu(); renderRadios(); renderLive();
  }

  document.addEventListener('keydown', e => {
    if (e.altKey && e.code === 'KeyP') { e.preventDefault(); toggle(); return; }
    if (!S.kbd || !S.open || e.ctrlKey || e.metaKey) return;
    let k = null;
    if (/^[a-zA-Z0-9]$/.test(e.key)) k = e.key.toUpperCase();
    else if (e.key === '.' || e.key === '/') k = e.key;
    else if (e.key === ' ') k = 'sp';
    else if (e.key === '-' || e.key === '+') k = '+/-';
    else if (e.key === 'Backspace') k = 'clr';
    else if (e.key === 'Delete') k = 'del';
    else if (e.key === 'Escape') { S.kbd = false; renderCdu(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (k) { e.preventDefault(); e.stopImmediatePropagation(); cduKey(k, e.shiftKey); }
  }, true);
  document.addEventListener('keyup', e => { if (S.kbd && S.open && !e.ctrlKey && !e.metaKey && /^([a-zA-Z0-9./ +-]|Backspace|Delete|Escape)$/.test(e.key)) e.stopImmediatePropagation(); }, true);

  function boot() {
    if (!document.body) return setTimeout(boot, 200);
    build(); setInterval(tick, 250);
    window.GeoFSLower = { pages: PAGES, keypage: KEYPAGE, kit: { cell, fld, lk, act, info, rows6 }, save, gcd, brg, pos, selfTest: () => GeoFSReal.selfTest(), refresh: () => { try { renderCdu(); renderRadios(true); save(); } catch (e) { /* ignore */ } }, version: VERSION, open: () => toggle(true), close: () => toggle(false), toggle, state: S, fmc: F, cdus, loadPlan };
    console.log('[GeoFS Lower] loaded. Alt+P toggles the panel.');
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
GeoFSDock.add('#gfl-tab', 2);
