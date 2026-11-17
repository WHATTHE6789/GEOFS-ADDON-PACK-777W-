// ==UserScript==
// @name         GeoFS 777-300ER EICAS + System Synoptics
// @namespace    https://github.com/geofs-overhead
// @version      1.0.0
// @description  Boeing 777 style engine/alert display (upper EICAS) with system synoptic pages (ENG, ELEC, HYD, FUEL, AIR, GEAR, FCTL, STAT). Reads the Overhead Panel script's simulated systems. Draggable, resizable, touch friendly.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* global geofs, controls, multiplayer, ui, GeoFSReal, GeoFSOverhead, GeoFSEICAS, GeoFSNavATC */

/*
 * INSTALL: Tampermonkey/Violentmonkey -> Create new script -> paste -> save -> reload GeoFS.
 * USE:     Alt+I or tap the small "EICAS" tab at the bottom-left. Drag the title bar to move it, SIZE cycles S/M/L,
 *          page buttons switch the lower synoptic (ENG ELEC HYD FUEL AIR GEAR FCTL STAT).
 *
 * HONESTY NOTE
 *   GeoFS exposes very little engine/system data, so most numbers here are DERIVED, not measured:
 *     REAL      -> gear/flap/speedbrake/parking-brake positions, engine running, throttle lever, trim (if exposed),
 *                  speed/altitude, brake and flight-control inputs where GeoFS exposes them.
 *     SIMULATED -> N1/N2/EGT/fuel flow (smoothed from the throttle lever, spool up/down times, start transient),
 *                  fuel quantity (starts from the CDU's FUEL entry, 90 t if none, burns with fuel flow; it is NOT
 *                  GeoFS's fuel), bus/hydraulic/pressurisation state (from the Overhead Panel script).
 *   Without the Overhead script the system pages show only what GeoFS itself provides.
 *   Alert text follows Boeing 777 style (red warning, amber caution, indented advisory, white memo) but the alert
 *   logic is the Overhead script's, not Boeing's.
 */
(function () {
  'use strict';
  if (window.GeoFSEICAS) return;

  const VERSION = '1.0.0';
  const STORE = 'geofsEICAS.v1';

  /* ───────────────────────── helpers ───────────────────────── */
  const safe = (f, d) => { try { const r = f(); return r === undefined ? d : r; } catch (e) { return d; } };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const V = () => safe(() => geofs.animation.values, {}) || {};
  const inst = () => safe(() => geofs.aircraft.instance, null);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const RAD = Math.PI / 180;
  const OV = () => safe(() => window.GeoFSOverhead, null), LO = () => safe(() => window.GeoFSLower, null);
  const sw = k => safe(() => OV().state.sw[k], 0);
  const osim = () => safe(() => OV().sim, null) || {};
  const agl = v => (typeof v.haglFeet === 'number' ? v.haglFeet : Math.max(0, (v.altitude || 0) - (v.groundElevationFeet || 0)));
  const onGround = v => { const g = safe(() => inst().groundContact, undefined); return g !== undefined ? !!g : agl(v) < 8; };
  const gearPos = () => { const v = V().gearPosition; return typeof v === 'number' ? v : safe(() => controls.gear.position, 0); };
  const sbPos = () => { const v = V().airbrakesPosition; return typeof v === 'number' ? v : safe(() => controls.airbrakes.position, 0); };
  const parkSet = () => !!safe(() => controls.parkingBrake, false);
  const engRun = () => { const on = safe(() => inst().engine.on, undefined); return on !== undefined ? !!on : (V().rpm || 0) > 300; };
  const flapN = () => { const d = safe(() => inst().definition.flapsSteps, null); const n = typeof d === 'number' ? d : Array.isArray(d) ? d.length : safe(() => controls.flaps.maxPosition, 0); return clamp(Math.round(n || 4), 1, 10); };
  const flapIdx = () => { const t = safe(() => controls.flaps.target, undefined); return clamp(Math.round(typeof t === 'number' ? t : (V().flapsValue || 0) * flapN()), 0, 10); };
  const throttle = () => { const t = safe(() => controls.throttle, undefined); return typeof t === 'number' ? clamp(t, 0, 1) : undefined; };
  const COL = { g: '#3dff7a', a: '#ffbf47', r: '#ff4a3d', w: '#e9eef0', c: '#4fe3ff', m: '#ff5cf0', d: '#4a5560', k: '#0b0f13' };
  const kg = x => Math.round(x).toLocaleString('en-US');

  /* ───────────────────────── state ───────────────────────── */
  const DEF = () => ({ open: false, x: 12, y: 80, size: 1, page: 'ENG', fuel: null, fuelSrc: null });
  const S = DEF();
  try { Object.assign(S, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) { /* ignore */ }
  S.open = false;
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } }, 400); };

  /* ───────────────────────── derived engine + fuel model ───────────────────────── */
  const N_ENG = 2;
  const E = Array.from({ length: N_ENG }, () => ({ n1: 0, n2: 0, egt: 20, ff: 0, used: 0, start: 0 }));
  let last = performance.now(), wasRun = false, lastSave = 0;
  function simTick() {
    const now = performance.now(), dt = clamp((now - last) / 1000, 0, 1); last = now;
    const run = engRun(), v = V();
    let thr = throttle(); if (thr === undefined) thr = clamp(((v.rpm || 0) / (safe(() => inst().definition.maxRPM, 0) || 100)), 0, 1);
    if (run && !wasRun) E.forEach(e => { e.start = 1; });
    wasRun = run;
    const idle = 21, tgt = run ? idle + thr * (100 - idle) : 0;
    E.forEach((e, i) => {
      const tau = !run ? 5 : e.start ? 9 : (tgt > e.n1 ? 3.2 : 4.5);
      e.n1 += (tgt - e.n1) * (1 - Math.exp(-dt / tau));
      if (e.start && e.n1 > idle * .95) e.start = 0;
      e.n2 = e.n1 < 1 ? 0 : e.n1 < idle ? e.n1 * (60 / idle) : 60 + (e.n1 - idle) * (40 / (100 - idle));
      const egtT = run ? 360 + e.n1 * 5.4 + (e.start ? 260 * (1 - e.n1 / idle) : 0) : 25;
      e.egt += (egtT - e.egt) * (1 - Math.exp(-dt / (run ? 5 : 20)));
      e.ff = e.n1 > 8 ? 700 + Math.pow(clamp((e.n1 - idle) / (100 - idle), 0, 1), 1.8) * 9800 : 0;
      e.used += e.ff * dt / 3600;
      if (S.fuel) burn(e.ff * dt / 3600);
    });
    syncFuel(); if (S.fuel && performance.now() - lastSave > 10000) { lastSave = performance.now(); save(); }
  }
  function setTanks(total) { const main = Math.min(35000, total * .3); S.fuel = { L: main, R: main, C: Math.max(0, total - 2 * main) }; }
  function syncFuel() {
    const f = safe(() => LO().fmc.fuel, null); // t, from the CDU
    const ground = onGround(V()) && !engRun();
    if (!S.fuel) { setTanks((f ? f * 1000 : 90000)); S.fuelSrc = f; save(); return; }
    if (f != null && f !== S.fuelSrc && ground) { setTanks(f * 1000); E.forEach(e => { e.used = 0; }); S.fuelSrc = f; save(); }
  }
  function burn(k) { const t = S.fuel; if (t.C > 0) { const d = Math.min(t.C, k); t.C -= d; k -= d; } if (k > 0) { t.L = Math.max(0, t.L - k / 2); t.R = Math.max(0, t.R - k / 2); } }
  const totalFuel = () => (S.fuel ? S.fuel.L + S.fuel.C + S.fuel.R : 0);

  /* ───────────────────────── alerts (777 style) ───────────────────────── */
  function alerts() {
    const o = osim(), w = o.warns || {}, A = [];
    const add = (lvl, t) => A.push({ lvl, t });
    if (w.cab) add('r', 'CABIN ALTITUDE');
    if (w.fire) add('r', 'FIRE ENG L / R / APU  (TEST)');
    if (w.oxy) add('r', 'PASS OXYGEN ON');
    if (w.gear) add('a', '>GEAR DISAGREE');
    if (w.bus) add('a', '>ELEC BUS OFF');
    if (w.hyd) add('a', '>HYD PRESS SYS');
    if (w.fuel) add('a', '>FUEL PRESS ENG');
    if (w.batt) add('a', '>BATTERY LOW');
    if (w.fcpc) add('a', '>PRI FLT COMPUTERS');
    if (w.rat) add('a', '>RAM AIR TURBINE');
    if (w.ldg10) add('a', '>LANDING LIGHTS ON');
    if (w.taxiAir) add('a', '>TAXI LIGHT ON');
    if (w.spd) add('a', ' SPEEDBRAKE EXTENDED');
    if (parkSet()) add('w', 'PARKING BRAKE SET');
    if (osim().apuState === 'AVAIL') add('w', 'APU RUNNING');
    if (sw('belts') === 2 || (o.eff && o.eff.belts)) add('w', 'SEATBELTS ON');
    if (o.eff && o.eff.nosmk) add('w', 'NO SMOKING ON');
    if (sw('wai') || sw('eaiL') === 2 || sw('eaiR') === 2) add('w', 'ANTI-ICE ON');
    if (sw('abrk') >= 2) add('w', 'AUTOBRAKES');
    return A;
  }

  /* ───────────────────────── SVG helpers ───────────────────────── */
  const T = (x, y, t, c, s, a, b) => `<text x="${x}" y="${y}" fill="${COL[c] || c || COL.w}" font-size="${s || 12}" text-anchor="${a || 'start'}" font-weight="${b ? 800 : 600}">${esc(t)}</text>`;
  const Rc = (x, y, w, h, stroke, fill, r) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r || 3}" fill="${COL[fill] || fill || 'none'}" stroke="${COL[stroke] || stroke || 'none'}" stroke-width="2"/>`;
  const Ln = (x1, y1, x2, y2, c, w) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COL[c] || c}" stroke-width="${w || 3}" stroke-linecap="round"/>`;
  function arcPath(cx, cy, r, a0, a1) { const p = a => [cx + r * Math.cos(a * RAD), cy + r * Math.sin(a * RAD)]; const [x0, y0] = p(a0), [x1, y1] = p(a1); return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; }
  function gauge(cx, cy, r, val, max, red, label, dec) {
    const ang = v => -225 + 270 * clamp(v / max, 0, 1), c = val >= red ? 'r' : 'w', a = ang(val);
    return `<path d="${arcPath(cx, cy, r, -225, 45)}" fill="none" stroke="${COL.d}" stroke-width="5"/>` +
      `<path d="${arcPath(cx, cy, r, ang(red), 45)}" fill="none" stroke="${COL.r}" stroke-width="5"/>` +
      `<line x1="${cx}" y1="${cy}" x2="${(cx + (r - 3) * Math.cos(a * RAD)).toFixed(1)}" y2="${(cy + (r - 3) * Math.sin(a * RAD)).toFixed(1)}" stroke="${COL[c]}" stroke-width="3" stroke-linecap="round"/>` +
      Rc(cx - 26, cy - r - 24, 52, 20, 'w', 'k') + T(cx + 22, cy - r - 9, val.toFixed(dec == null ? 1 : dec), c, 14, 'end', true) + T(cx, cy + r + 15, label, 'c', 11, 'middle');
  }
  const bar = (x, y, w, h, frac, c) => Rc(x, y, w, h, 'd', 'k', 2) + `<rect x="${x + 1}" y="${y + h - 1 - (h - 2) * clamp(frac, 0, 1)}" width="${w - 2}" height="${(h - 2) * clamp(frac, 0, 1)}" fill="${COL[c] || c}"/>`;
  const pwrC = on => (on ? 'g' : 'd');

  /* ───────────────────────── upper EICAS ───────────────────────── */
  function upperSvg() {
    const v = V(), A = alerts(), run = engRun();
    let s = '';
    [0, 1].forEach(i => {
      const e = E[i], cx = 70 + i * 140;
      s += gauge(cx, 82, 46, e.n1, 117, 112, 'N1 %') + T(cx - 40, 150, 'EGT', 'c', 10) + T(cx + 40, 150, Math.round(e.egt) + '°', e.egt > 1000 ? 'r' : 'g', 12, 'end', true);
      s += T(cx, 168, 'FF ' + (e.ff / 1000).toFixed(1), 'w', 11, 'middle');
    });
    s += T(140, 18, 'ENG 1  ·  ENG 2', 'd', 10, 'middle');
    if (!run) s += T(140, 40, 'ENGINES OFF', 'a', 10, 'middle');
    // alerts
    s += Ln(295, 8, 295, 172, 'd', 1) + T(305, 18, 'ALERTS', 'd', 10);
    A.slice(0, 9).forEach((a, i) => { s += T(305, 38 + i * 15, a.t, a.lvl === 'r' ? 'r' : a.lvl === 'a' ? 'a' : 'w', 13, 'start', a.lvl !== 'w'); });
    if (A.length > 9) s += T(305, 38 + 9 * 15, '… +' + (A.length - 9) + ' MORE', 'c', 11);
    if (!A.length) s += T(305, 38, 'NO ALERTS', 'd', 12);
    return s;
  }
  /* gear/flap/trim strip below the alerts is in the lower pages; keep upper compact */

  /* ───────────────────────── lower pages ───────────────────────── */
  const PAGES = ['ENG', 'ELEC', 'HYD', 'FUEL', 'AIR', 'GEAR', 'FCTL', 'STAT'];
  const noOv = () => (OV() ? '' : T(280, 290, 'OVERHEAD SCRIPT NOT FOUND — LIMITED DATA', 'a', 11, 'middle'));
  const PG = {
    ENG() {
      let s = T(280, 20, 'ENGINE', 'w', 14, 'middle', true);
      [0, 1].forEach(i => {
        const e = E[i], cx = 140 + i * 280;
        s += T(cx, 50, 'ENG ' + (i + 1), 'c', 13, 'middle', true) + gauge(cx, 118, 52, e.n1, 117, 112, 'N1 %') + gauge(cx, 232, 36, e.n2, 120, 110, 'N2 %');
        s += T(cx - 100, 100, 'EGT', 'c', 11) + T(cx - 100, 120, Math.round(e.egt) + '°C', e.egt > 1000 ? 'r' : 'g', 14, 'start', true);
        s += T(cx + 100, 100, 'FF', 'c', 11, 'end') + T(cx + 100, 120, kg(e.ff) + ' kg/h', 'g', 13, 'end', true) + T(cx + 100, 150, 'USED', 'c', 11, 'end') + T(cx + 100, 168, kg(e.used) + ' kg', 'w', 13, 'end', true);
      });
      return s + T(280, 292, 'N1/N2/EGT/FF are DERIVED from the throttle lever (GeoFS gives no engine data)', 'd', 10, 'middle');
    },
    ELEC() {
      const o = osim(), run = engRun(), tie = k => !!sw(k);
      const gL = !!sw('genL') && run, gR = !!sw('genR') && run, bL = !!sw('bugL') && run, bR = !!sw('bugR') && run, apu = !!sw('apug') && o.apuState === 'AVAIL', ext = !!(sw('ext') || sw('ext2'));
      const L = gL || bL || ((apu || ext) && tie('btieL')) || (gR && tie('btieL') && tie('btieR')), R = gR || bR || ((apu || ext) && tie('btieR')) || (gL && tie('btieL') && tie('btieR'));
      const batt = !!sw('batt') || sw('stby') > 0, bat = batt && (o.batt || 0) > 0, anyS = gL || gR || bL || bR || apu || ext;
      const bl = L || (!anyS && bat), br = R || (!anyS && bat);
      let s = T(280, 20, 'ELECTRICAL', 'w', 14, 'middle', true);
      const src = (x, y, lab, on) => Rc(x, y, 84, 34, pwrC(on), 'k') + T(x + 42, y + 22, lab, on ? 'g' : 'd', 12, 'middle', true);
      s += src(30, 40, 'GEN L', gL) + src(130, 40, 'BU GEN L', bL) + src(366, 40, 'BU GEN R', bR) + src(466, 40, 'GEN R', gR);
      s += src(205, 40, 'APU GEN', apu) + src(281, 40, 'EXT PWR', ext);
      [[72, gL], [172, bL], [408, bR], [508, gR]].forEach(([x, on]) => { s += Ln(x, 74, x, 130, pwrC(on)); });
      s += Ln(247, 74, 247, 100, pwrC(apu)) + Ln(323, 74, 323, 100, pwrC(ext)) + Ln(247, 100, 323, 100, pwrC(apu || ext));
      s += Rc(30, 130, 230, 30, pwrC(bl), 'k') + T(145, 151, 'L MAIN BUS', bl ? (anyS ? 'g' : 'a') : 'd', 13, 'middle', true) + Rc(310, 130, 230, 30, pwrC(br), 'k') + T(425, 151, 'R MAIN BUS', br ? (anyS ? 'g' : 'a') : 'd', 13, 'middle', true);
      s += Ln(260, 145, 310, 145, pwrC(tie('btieL') && tie('btieR') && bl && br)) + T(285, 138, 'TIE', 'd', 9, 'middle');
      s += Rc(215, 195, 150, 56, bat ? (anyS ? 'g' : 'a') : 'd', 'k') + T(290, 215, 'BATTERY', 'c', 11, 'middle') + T(290, 238, Math.round(o.batt || 0) + ' %   ' + (o.busV || 0).toFixed(1) + ' V', bat ? (o.batt < 20 ? 'a' : 'g') : 'd', 14, 'middle', true);
      s += Ln(290, 160, 290, 195, pwrC(bat)) + T(70, 230, 'CAB/UTIL', sw('cabutil') ? 'g' : 'd', 12) + T(70, 250, 'IFE/PASS', sw('ife') ? 'g' : 'd', 12);
      return s + noOv();
    },
    HYD() {
      const h = osim().hyd || {}, ps = on => (on ? 2950 + Math.round(Math.sin(Date.now() / 900) * 20) : 0);
      let s = T(280, 20, 'HYDRAULICS', 'w', 14, 'middle', true);
      [['L', 'L', 90, h.L, sw('hydL') ? 'ENG' : 'OFF'], ['C', 'C', 280, h.C, (sw('hydC1') + sw('hydC2')) ? 'ELEC/DEM' : 'OFF'], ['R', 'R', 470, h.R, sw('hydR') ? 'ENG' : 'OFF']].forEach(([n, , cx, on, pump]) => {
        s += Rc(cx - 55, 40, 110, 150, on ? 'g' : 'a', 'k') + T(cx, 62, n + ' SYSTEM', 'c', 12, 'middle', true) + bar(cx - 14, 74, 28, 90, ps(on) / 3500, on ? 'g' : 'a') + T(cx, 182, ps(on) + ' PSI', on ? 'g' : 'a', 12, 'middle', true) + T(cx, 214, 'PUMP ' + pump, on ? 'g' : 'd', 11, 'middle');
      });
      s += T(280, 250, 'RAT: ' + (sw('rat') ? 'DEPLOYED' : 'STOWED'), sw('rat') ? 'a' : 'd', 14, 'middle', true);
      return s + noOv();
    },
    FUEL() {
      const t = S.fuel || { L: 0, C: 0, R: 0 }, run = engRun();
      let s = T(280, 20, 'FUEL', 'w', 14, 'middle', true);
      const tank = (x, w, lab, q, cap, pumps) => Rc(x, 70, w, 120, q < 500 ? 'a' : 'g', 'k') + `<rect x="${x + 2}" y="${188 - 116 * clamp(q / cap, 0, 1)}" width="${w - 4}" height="${116 * clamp(q / cap, 0, 1)}" fill="#1c5a38"/>` + T(x + w / 2, 62, lab, 'c', 12, 'middle', true) + T(x + w / 2, 135, kg(q), 'w', 16, 'middle', true) + T(x + w / 2, 208, pumps ? 'PUMPS ON' : 'PUMPS OFF', pumps ? 'g' : 'a', 10, 'middle');
      s += tank(40, 140, 'L MAIN', t.L, 35000, sw('fLF') || sw('fLA')) + tank(210, 140, 'CENTER', t.C, 60000, sw('fCL') || sw('fCR')) + tank(380, 140, 'R MAIN', t.R, 35000, sw('fRF') || sw('fRA'));
      s += Ln(180, 140, 210, 140, sw('xfF') ? 'g' : 'd') + Ln(350, 140, 380, 140, sw('xfA') ? 'g' : 'd') + T(195, 132, 'X', 'd', 9, 'middle') + T(365, 132, 'X', 'd', 9, 'middle');
      s += T(40, 245, 'TOTAL', 'c', 11) + T(40, 268, kg(totalFuel()) + ' KG', 'g', 20, 'start', true) + T(360, 245, 'FUEL USED', 'c', 11) + T(360, 268, kg(E[0].used + E[1].used) + ' KG', 'w', 18, 'start', true);
      s += T(520, 100, 'FF', 'c', 11, 'middle') + T(520, 120, ((E[0].ff + E[1].ff) / 1000).toFixed(1), 'g', 14, 'middle', true) + T(520, 134, 't/h', 'd', 9, 'middle');
      return s + T(280, 292, 'SIMULATED QUANTITY — starts from the CDU FUEL entry (90 t default); not GeoFS fuel', 'd', 10, 'middle');
    },
    AIR() {
      const o = osim(), ca = o.cabAlt || 0, alt = V().altitude || 0, dp = o.dP || 0, src = !!o.pressSrc;
      let s = T(280, 20, 'AIR / PRESSURISATION', 'w', 14, 'middle', true);
      const unit = (x, lab, pack, bleed, isln) => Rc(x, 40, 160, 120, pack && src ? 'g' : 'd', 'k') + T(x + 80, 60, lab, 'c', 12, 'middle', true) + T(x + 14, 90, 'PACK ' + (pack ? 'ON' : 'OFF'), pack ? (src ? 'g' : 'a') : 'd', 13, 'start', true) + T(x + 14, 116, 'BLEED ' + (bleed ? 'ON' : 'OFF'), bleed ? 'g' : 'd', 13, 'start', true) + T(x + 14, 142, 'ISLN ' + (isln ? 'OPEN' : 'CLOSED'), 'w', 11);
      s += unit(40, 'LEFT', sw('packL'), sw('bleedL'), sw('islnL')) + unit(360, 'RIGHT', sw('packR'), sw('bleedR'), sw('islnR'));
      s += Rc(225, 60, 110, 90, ca > 10000 ? 'r' : 'g', 'k') + T(280, 82, 'CABIN', 'c', 11, 'middle') + T(280, 112, Math.round(ca / 10) * 10, ca > 10000 ? 'r' : 'g', 20, 'middle', true) + T(280, 128, 'ALT FT', 'd', 10, 'middle') + T(280, 144, 'ΔP ' + dp.toFixed(1) + ' PSI', 'w', 12, 'middle', true);
      s += T(40, 200, 'APU BLEED ' + (sw('apuB') ? 'ON' : 'OFF'), sw('apuB') ? 'g' : 'd', 12) + T(40, 222, 'RECIRC UPR ' + (sw('recU') ? 'ON' : 'OFF'), sw('recU') ? 'g' : 'd', 12) + T(40, 244, 'RECIRC LWR ' + (sw('recL') ? 'ON' : 'OFF'), sw('recL') ? 'g' : 'd', 12);
      s += T(300, 200, 'ACFT ALT ' + Math.round(alt) + ' FT', 'w', 12) + T(300, 222, 'LDG ALT ' + safe(() => OV().state.ap.ldg, 0) + ' FT', 'c', 12) + T(300, 244, 'TRIM AIR ' + (sw('trim') ? 'ON' : 'OFF'), sw('trim') ? 'g' : 'd', 12);
      return s + noOv();
    },
    GEAR() {
      const gp = gearPos(), down = gp >= .97, tr = gp > .03 && gp < .97, c = down ? 'g' : tr ? 'r' : 'd', lab = down ? 'DOWN' : tr ? 'TRANSIT' : 'UP', ab = safe(() => OV().state.sw.abrk, null);
      let s = T(280, 20, 'GEAR', 'w', 14, 'middle', true);
      [[280, 50, 'NOSE'], [140, 110, 'LEFT'], [420, 110, 'RIGHT']].forEach(([x, y, n]) => { s += Rc(x - 50, y, 100, 80, c, 'k') + T(x, y + 24, n, 'c', 12, 'middle') + T(x, y + 56, lab, c === 'd' ? 'w' : c, 16, 'middle', true); });
      const park = parkSet(), sb = sbPos() > .5;
      s += T(40, 230, 'PARK BRK ' + (park ? 'SET' : 'REL'), park ? 'a' : 'w', 13, 'start', true) + T(230, 230, 'AUTOBRAKE ' + (ab == null ? '---' : ['RTO', 'OFF', '1', '2', '3', '4', 'MAX'][ab]), ab >= 2 ? 'g' : 'w', 13, 'start', true) + T(430, 230, 'SPDBRK ' + (sb ? 'OUT' : 'IN'), sb ? 'a' : 'w', 13, 'start', true);
      s += T(40, 254, 'GS ' + Math.round(safe(() => { const v = V(); return typeof v.groundSpeedKnt === 'number' ? v.groundSpeedKnt : (v.groundSpeed || 0) * 1.944; }, 0)) + ' KT', 'w', 13) + T(230, 254, 'AGL ' + Math.round(agl(V())) + ' FT', 'w', 13);
      return s;
    },
    FCTL() {
      const n = flapN(), fi = flapIdx(), tr = safe(() => controls.elevatorTrim, null), pit = safe(() => controls.pitch, null), rol = safe(() => controls.roll, null), yaw = safe(() => controls.yaw, null);
      const ctl = (x, y, lab, v) => T(x, y, lab, 'c', 11, 'middle') + Rc(x - 60, y + 6, 120, 12, 'd', 'k', 2) + (typeof v === 'number' ? Ln(x + clamp(v, -1, 1) * 56, y + 6, x + clamp(v, -1, 1) * 56, y + 18, 'g', 4) : T(x, y + 16, '—', 'd', 10, 'middle'));
      let s = T(280, 20, 'FLIGHT CONTROLS', 'w', 14, 'middle', true);
      s += T(60, 56, 'FLAPS', 'c', 12, 'middle');
      for (let i = 0; i <= n; i++) { const y = 70 + i * (150 / n); s += Ln(46, y, 74, y, i === fi ? 'g' : 'd', i === fi ? 5 : 2) + T(84, y + 4, i === 0 ? 'UP' : i === n ? 'FULL' : i, i === fi ? 'g' : 'd', 11); }
      s += T(220, 56, 'SPEEDBRAKE', 'c', 12, 'middle') + bar(205, 66, 30, 110, sbPos(), 'a') + T(220, 194, sbPos() > .5 ? 'OUT' : 'IN', sbPos() > .5 ? 'a' : 'w', 12, 'middle', true);
      s += T(360, 56, 'STAB TRIM', 'c', 12, 'middle');
      if (typeof tr === 'number') s += bar(345, 66, 30, 110, (tr + 1) / 2, 'g') + T(360, 194, (7.5 + tr * 7.5).toFixed(1) + ' U', 'g', 12, 'middle', true); else s += T(360, 120, 'N/A', 'd', 14, 'middle') + T(360, 138, 'not exposed', 'd', 10, 'middle');
      s += ctl(490, 76, 'AILERON', rol) + ctl(490, 126, 'ELEVATOR', typeof pit === 'number' ? -pit : pit) + ctl(490, 176, 'RUDDER', yaw);
      return s + T(280, 292, 'Surface bars use GeoFS control inputs where exposed', 'd', 10, 'middle');
    },
    STAT() {
      const o = osim(), f = safe(() => LO().fmc, null), v = V(), d = new Date();
      const row = (i, l, val, c) => T(40, 52 + i * 26, l, 'c', 12) + T(250, 52 + i * 26, val, c || 'w', 14, 'end', true);
      let s = T(280, 20, 'STATUS', 'w', 14, 'middle', true);
      s += row(0, 'UTC', pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + 'Z') + row(1, 'APU', (o.apuState || 'OFF') + ' ' + Math.round(o.apu || 0) + '%', o.apuState === 'AVAIL' ? 'g' : 'w') + row(2, 'BUS', (o.busV || 0).toFixed(1) + ' V', o.bus ? 'g' : 'a') + row(3, 'BATTERY', Math.round(o.batt || 0) + ' %', (o.batt || 0) < 20 ? 'a' : 'g') + row(4, 'CABIN ALT', Math.round(o.cabAlt || 0) + ' FT') + row(5, 'FLAPS', flapIdx() + ' / ' + flapN()) + row(6, 'GEAR', gearPos() >= .97 ? 'DOWN' : gearPos() <= .03 ? 'UP' : 'TRANSIT', gearPos() >= .97 ? 'g' : 'w');
      const gw = f ? (f.zfw + (S.fuel ? totalFuel() / 1000 : f.fuel)) : null;
      s += T(300, 52, 'FLIGHT', 'd', 10) + T(300, 78, 'IAS ' + Math.round(v.kias || 0) + ' KT', 'w', 14, 'start', true) + T(300, 104, 'ALT ' + Math.round(v.altitude || 0) + ' FT', 'w', 14, 'start', true) + T(300, 130, 'V/S ' + Math.round(v.verticalSpeed || 0) + ' FPM', 'w', 14, 'start', true) + T(300, 156, 'MACH ' + (v.mach != null ? v.mach.toFixed(3) : '---'), 'w', 14, 'start', true);
      s += T(300, 190, 'FUEL REM ' + kg(totalFuel()) + ' KG', 'g', 13, 'start', true) + T(300, 214, 'GW EST ' + (gw != null ? gw.toFixed(1) + ' T' : '---'), 'w', 13, 'start', true) + T(300, 238, 'CDU FLT ' + (f && f.flt ? f.flt : '---'), 'c', 13, 'start', true);
      return s + noOv();
    },
  };

  /* ───────────────────────── UI ───────────────────────── */
  const CSS = `
  #gfi-root,#gfi-root *{box-sizing:border-box}
  #gfi-root{position:fixed;z-index:99989;width:calc(560px * var(--gfi-s,1));font:600 11px system-ui,"Segoe UI",sans-serif;color:#dde4ea;background:#1d2125;border:2px solid #000;border-radius:10px;
    box-shadow:0 10px 36px #000c;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;display:none;overflow:hidden}
  #gfi-root.open{display:block}
  #gfi-bar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:linear-gradient(#3a3f44,#2a2e32);cursor:grab;touch-action:none;letter-spacing:.12em;font-size:10px}
  #gfi-bar b{flex:1;color:#f1f4f6}#gfi-bar button,.gfi-pg button{all:unset;cursor:pointer;padding:4px 9px;border-radius:4px;background:#3b4046;border:1px solid #0d0f11;font-size:10px;letter-spacing:.06em;color:#dfe5e9;text-align:center}
  .gfi-pg button.on{background:#1f3b57;color:#fff}.gfi-pg{display:flex;flex-wrap:wrap;gap:4px;padding:5px 8px;background:#14181c}
  #gfi-root svg{display:block;width:100%;background:#050709;font-family:system-ui,"Segoe UI",sans-serif}
  #gfi-up{border-bottom:2px solid #1d2125}
  #gfi-tab{all:unset;position:fixed;left:0;bottom:90px;z-index:99988;width:34px;height:96px;cursor:pointer;background:linear-gradient(#3a3f44,#2a2e32);border:1px solid #0d0f11;border-left:none;border-radius:0 9px 9px 0;color:#cfd6db;
    font:700 11px system-ui;letter-spacing:.18em;writing-mode:vertical-rl;text-align:center;line-height:34px;box-shadow:0 0 8px #0008}
  #gfi-tab:focus-visible,#gfi-root button:focus-visible{outline:2px solid #7cc4ff;outline-offset:1px}
  @media (pointer:coarse),(hover:none){#gfi-bar button,.gfi-pg button{padding:11px 13px;font-size:11px}#gfi-tab{width:42px;height:110px;line-height:42px}}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
  `;
  let root = null;
  const SIZES = [.72, 1, 1.3];
  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'gfi-root';
    root.innerHTML = `<div id="gfi-bar"><b>777 EICAS <small style="opacity:.6">v${VERSION}</small></b><button data-c="refuel" title="Reset tanks to the CDU fuel entry (ground only)">REFUEL</button><button data-c="size">SIZE</button><button data-c="close">HIDE</button></div>
      <svg id="gfi-up" viewBox="0 0 560 180" role="img" aria-label="Upper EICAS"></svg>
      <div class="gfi-pg">${PAGES.map(p => `<button data-p="${p}">${p}</button>`).join('')}</div>
      <svg id="gfi-lo" viewBox="0 0 560 300" role="img" aria-label="System page"></svg>`;
    document.body.appendChild(root);
    const tab = document.createElement('button'); tab.id = 'gfi-tab'; tab.textContent = 'EICAS'; tab.setAttribute('aria-label', 'Toggle EICAS (Alt+I)'); document.body.appendChild(tab);
    tab.addEventListener('click', () => toggle());
    ['pointerdown', 'mousedown', 'touchstart', 'touchmove'].forEach(ev => root.addEventListener(ev, e => { if (!e.target.closest('#gfi-bar')) e.stopPropagation(); }, { passive: true }));
    root.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.p) { S.page = b.dataset.p; save(); draw(); }
      if (b.dataset.c === 'close') toggle(false);
      if (b.dataset.c === 'refuel') { if (onGround(V()) && !engRun()) { const f = safe(() => LO().fmc.fuel, null); setTanks(f ? f * 1000 : 90000); S.fuelSrc = f; E.forEach(x => { x.used = 0; }); save(); draw(); } }
      if (b.dataset.c === 'size') { S.size = (S.size + 1) % SIZES.length; save(); place(); }
    });
    // drag by title bar
    const bar = $('#gfi-bar'); let d = null;
    bar.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; d = { dx: e.clientX - S.x, dy: e.clientY - S.y }; bar.setPointerCapture(e.pointerId); bar.style.cursor = 'grabbing'; e.stopPropagation(); });
    bar.addEventListener('pointermove', e => { if (!d) return; S.x = e.clientX - d.dx; S.y = e.clientY - d.dy; place(); });
    const end = () => { if (d) { d = null; bar.style.cursor = 'grab'; save(); } };
    bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
    window.addEventListener('resize', place);
    place(); applyOpen();
  }
  function place() {
    const s = SIZES[S.size] || 1; root.style.setProperty('--gfi-s', s);
    const w = 560 * s, h = root.offsetHeight || 420;
    S.x = clamp(S.x, -w + 120, innerWidth - 120); S.y = clamp(S.y, 0, Math.max(0, innerHeight - 60));
    root.style.left = S.x + 'px'; root.style.top = S.y + 'px';
  }
  function draw() {
    if (!S.open) return;
    $('#gfi-up', root).innerHTML = upperSvg();
    $('#gfi-lo', root).innerHTML = (PG[S.page] || PG.ENG)();
    $$('.gfi-pg button', root).forEach(b => b.classList.toggle('on', b.dataset.p === S.page));
  }
  function applyOpen() { root.classList.toggle('open', S.open); if (S.open) { place(); draw(); } }
  function toggle(force) { S.open = typeof force === 'boolean' ? force : !S.open; save(); applyOpen(); }
  document.addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyI') { e.preventDefault(); toggle(); } }, true);

  function boot() {
    if (!document.body) return setTimeout(boot, 200);
    build();
    setInterval(simTick, 250);
    setInterval(draw, 500);
    window.GeoFSEICAS = { version: VERSION, open: () => toggle(true), close: () => toggle(false), toggle, state: S, engines: E, refuel: kgTotal => { setTanks(kgTotal); E.forEach(e => { e.used = 0; }); save(); } };
    console.log('[GeoFS EICAS] loaded. Alt+I toggles the display.');
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
window.GeoFSDock.add('#gfi-tab', 4);
