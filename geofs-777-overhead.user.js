// ==UserScript==
// @name         GeoFS 777-300ER Overhead Panel
// @namespace    https://github.com/geofs-overhead
// @version      2.2.0
// @description  Boeing 777-300ER style overhead panel for GeoFS: electrical, APU/engine, fuel, hydraulics, air/pressurisation, anti-ice, lights, signs, fire protection, flight controls, autobrake, AFDS, EICAS-style annunciators, scenes and sounds.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * INSTALL: Tampermonkey/Violentmonkey -> Create new script -> paste this file -> save -> reload GeoFS.
 *
 * USE:     Alt+O or click the tab at the top of the screen.
 *          Click pushbuttons. Rotary knobs: click / right-click / scroll (mouse) or tap left/right half (touch).
 *          AFDS fields: type, scroll, or use the arrows. iPad/Orion: no Alt key, so use the tab at the top of the screen.
 *          Guarded switches (red border) need two clicks: lift guard, then operate.
 *          Console helpers:  GeoFSOverhead.probe()  /  .toggle()  /  .scene('taxi')
 *
 * HONESTY NOTE
 *   GeoFS has no addon API and only models a few things (engine on/off, lights as ONE switch, gear,
 *   flaps, airbrake, parking brake, a basic autopilot). This panel is therefore two things:
 *     REAL      -> ENG START, GEAR, SPD BRK, PARK BRK, FLAPS, AP engage + targets, exterior lights (collectively).
 *     SIMULATED -> everything else (buses, battery, APU, hydraulics, fuel pumps, packs/cabin altitude,
 *                  signs, fire handles, RAT...). They drive lamps, warnings, sounds and (with STRICT ELEC)
 *                  gate the real things above, but they do not change GeoFS flight physics.
 *   AUTOBRAKE (levels 1-4/MAX) writes controls.brakes after touchdown (experimental). RTO is annunciated only.
 *   If something doesn't respond: GeoFSOverhead.probe() and check the KEYS table against your bindings.
 */
(function () {
  'use strict';
  if (window.GeoFSOverhead) return;

  const VERSION = '2.2.0';
  const STORE = 'geofsOverhead.v2';

  /* Fallback key presses (only used if the GeoFS API call isn't found). Edit to match your bindings. */
  const KEYS = {
    lights:  { key: 'l', code: 'KeyL', keyCode: 76 },
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
  const inst = () => safe(() => geofs.aircraft.instance, null);
  const V = () => safe(() => geofs.animation.values, {}) || {};
  const typing = e => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
  const pAt = h => 14.696 * Math.pow(1 - 6.8756e-6 * clamp(h, -1000, 60000), 5.2559); // ISA pressure, psi

  /* ───────────────────────── definitions ───────────────────────── */
  const pb = (id, g, label, o) => Object.assign({ id, g, t: 'pb', label }, o);
  const rot = (id, g, label, opts, def, o) => Object.assign({ id, g, t: 'rot', label, opts, def: def || 0 }, o);
  const DEFS = [
    // electrical
    pb('batt', 'elec', 'BATT'), rot('stby', 'elec', 'STBY PWR', ['OFF', 'AUTO', 'BAT']),
    pb('ext', 'elec', 'EXT PWR 1'), pb('ext2', 'elec', 'EXT PWR 2'), pb('apug', 'elec', 'APU GEN'),
    pb('genL', 'elec', 'GEN L'), pb('genR', 'elec', 'GEN R'), pb('bugL', 'elec', 'BU GEN L'), pb('bugR', 'elec', 'BU GEN R'),
    pb('btieL', 'elec', 'BUS TIE L'), pb('btieR', 'elec', 'BUS TIE R'), pb('ife', 'elec', 'IFE/PASS'), pb('cabutil', 'elec', 'CAB/UTIL'),
    // APU / engines
    rot('apu', 'eng', 'APU', ['OFF', 'ON', 'START']), pb('eng', 'eng', 'ENG START'),
    rot('fctlL', 'eng', 'FUEL CTL L', ['CUTOFF', 'RUN']), rot('fctlR', 'eng', 'FUEL CTL R', ['CUTOFF', 'RUN']),
    // fuel
    pb('fLF', 'fuel', 'L FWD'), pb('fLA', 'fuel', 'L AFT'), pb('fRF', 'fuel', 'R FWD'), pb('fRA', 'fuel', 'R AFT'),
    pb('fCL', 'fuel', 'CTR L'), pb('fCR', 'fuel', 'CTR R'), pb('xfF', 'fuel', 'XFEED FWD'), pb('xfA', 'fuel', 'XFEED AFT'),
    // hydraulics
    pb('hydL', 'hyd', 'L ENG PUMP'), pb('hydR', 'hyd', 'R ENG PUMP'),
    rot('hydC1', 'hyd', 'C1 DEMAND', ['OFF', 'AUTO', 'ON'], 1), rot('hydC2', 'hyd', 'C2 DEMAND', ['OFF', 'AUTO', 'ON'], 1),
    pb('rat', 'hyd', 'RAT', { guard: true }),
    // air / pressurisation
    pb('packL', 'air', 'PACK L'), pb('packR', 'air', 'PACK R'), pb('trim', 'air', 'TRIM AIR'),
    pb('islnL', 'air', 'ISLN L'), pb('islnR', 'air', 'ISLN R'), pb('bleedL', 'air', 'BLEED L'), pb('bleedR', 'air', 'BLEED R'), pb('apuB', 'air', 'APU BLEED'),
    pb('recU', 'air', 'RECIRC UPR'), pb('recL', 'air', 'RECIRC LWR'),
    rot('tmpFD', 'air', 'FD TEMP', ['COLD', 'AUTO', 'HOT'], 1), rot('tmpCB', 'air', 'CAB TEMP', ['COLD', 'AUTO', 'HOT'], 1),
    // anti-ice
    pb('wai', 'ice', 'WING A-ICE'), rot('eaiL', 'ice', 'ENG A-ICE L', ['OFF', 'AUTO', 'ON']), rot('eaiR', 'ice', 'ENG A-ICE R', ['OFF', 'AUTO', 'ON']),
    pb('whFL', 'ice', 'WNDW FWD L'), pb('whFR', 'ice', 'WNDW FWD R'), pb('whSL', 'ice', 'WNDW SIDE L'), pb('whSR', 'ice', 'WNDW SIDE R'), pb('probe', 'ice', 'PROBE HT'),
    // exterior lights
    pb('ldgL', 'ext', 'LDG L'), pb('ldgR', 'ext', 'LDG R'), pb('nose', 'ext', 'NOSE LDG'), pb('rwyL', 'ext', 'RWY TO L'), pb('rwyR', 'ext', 'RWY TO R'),
    pb('taxi', 'ext', 'TAXI'), pb('nav', 'ext', 'POSITION'), rot('strobe', 'ext', 'STROBE', ['OFF', 'AUTO', 'ON']),
    pb('beacon', 'ext', 'BEACON'), pb('wing', 'ext', 'WING'), pb('logo', 'ext', 'LOGO'),
    // cabin / interior
    rot('dome', 'int', 'FLT DECK', ['OFF', 'DIM', 'BRT']), pb('storm', 'int', 'STORM'), pb('cabin', 'int', 'CABIN'),
    rot('belts', 'int', 'SEAT BELTS', ['OFF', 'AUTO', 'ON']), rot('nosmk', 'int', 'NO SMOKE', ['OFF', 'AUTO', 'ON']), rot('emer', 'int', 'EMER LT', ['OFF', 'ARM', 'ON']),
    pb('oxy', 'int', 'PASS OXY', { guard: true }), pb('call', 'int', 'ATTND CALL', { mom: true }), pb('gcall', 'int', 'GND CALL', { mom: true }),
    // fire protection
    pb('fireL', 'fire', 'ENG L FIRE', { guard: true }), pb('fireR', 'fire', 'ENG R FIRE', { guard: true }), pb('fireA', 'fire', 'APU FIRE', { guard: true }),
    pb('cgfF', 'fire', 'CARGO FWD', { guard: true }), pb('cgfA', 'fire', 'CARGO AFT', { guard: true }), pb('ftest', 'fire', 'FIRE TEST', { mom: true }),
    // flight controls
    pb('gear', 'flt', 'GEAR'), pb('spd', 'flt', 'SPD BRK'), pb('pbrk', 'flt', 'PARK BRK'),
    rot('abrk', 'flt', 'AUTOBRAKE', ['RTO', 'OFF', '1', '2', '3', '4', 'MAX'], 1), pb('fcpc', 'flt', 'PRIM FLT'), pb('tac', 'flt', 'THR ASYM'),
    // autoflight
    pb('apm', 'ap', 'AP CMD'), pb('lnav', 'ap', 'LNAV'), pb('hdgs', 'ap', 'HDG SEL'), pb('alth', 'ap', 'ALT HLD'), pb('vs', 'ap', 'V/S'), pb('flch', 'ap', 'FLCH'),
  ];
  const DEFMAP = Object.fromEntries(DEFS.map(d => [d.id, d]));
  const GROUPS = [
    { id: 'elec', title: 'ELECTRICAL' },
    { id: 'eng', title: 'APU / ENGINES' },
    { id: 'fuel', title: 'FUEL' },
    { id: 'hyd', title: 'HYDRAULICS' },
    { id: 'air', title: 'AIR COND / PRESSURISATION', extra: '<label class="gfo-fld"><span>LDG ALT</span><input class="gfo-lcd" data-ap="ldg" type="number" inputmode="numeric" step="100"><em>ft</em></label><div class="gfo-step"><button data-nudge="ldg,1" aria-label="Landing altitude up">▲</button><button data-nudge="ldg,-1" aria-label="Landing altitude down">▼</button></div>' },
    { id: 'ice', title: 'ANTI-ICE / WINDOW HEAT' },
    { id: 'ext', title: 'EXTERIOR LIGHTS' },
    { id: 'int', title: 'CABIN / INTERIOR' },
    { id: 'fire', title: 'FIRE PROTECTION' },
    { id: 'flt', title: 'FLIGHT CONTROLS', extra: '<div class="gfo-flaps-wrap"><span>FLAPS</span><div class="gfo-flaps" id="gfo-flaps"></div></div>' },
    {
      id: 'ap', title: 'AUTOFLIGHT (AFDS)', extra:
        '<div class="gfo-apf">' +
        [['spd', 'SPD', 'kt'], ['hdg', 'HDG', '°'], ['alt', 'ALT', 'ft'], ['vs', 'V/S', 'fpm']]
          .map(([k, l, u]) => `<div class="row"><label class="gfo-fld"><span>${l}</span><input class="gfo-lcd" data-ap="${k}" type="number" inputmode="numeric"><em>${u}</em></label><div class="gfo-step"><button data-nudge="${k},1" aria-label="${l} up">▲</button><button data-nudge="${k},-1" aria-label="${l} down">▼</button></div></div>`).join('') +
        '<button class="gfo-mini" data-act="apsync">SYNC</button></div>'
    },
  ];
  const MIRRORED = new Set(['eng', 'gear', 'spd', 'pbrk', 'apm']);
  const MODEBTN = new Set(['lnav', 'hdgs', 'alth', 'vs', 'flch']);
  const LIGHT_IDS = ['ldgL', 'ldgR', 'nose', 'rwyL', 'rwyR', 'taxi', 'nav', 'strobe', 'beacon', 'wing', 'logo'];
  const PUMPS = ['fLF', 'fLA', 'fRF', 'fRA', 'fCL', 'fCR'];
  const AP_STEP = { spd: 5, hdg: 1, alt: 100, vs: 100, ldg: 100 };
  const AP_LIM = { spd: [0, 700], hdg: [0, 360], alt: [0, 60000], vs: [-6000, 6000], ldg: [-1000, 15000] };

  const PWR = { batt: 1, stby: 1, btieL: 1, btieR: 1, ife: 1, cabutil: 1 };
  const ALLP = { fLF: 1, fLA: 1, fRF: 1, fRA: 1, fCL: 1, fCR: 1 };
  const SIGNS = { cabin: 1, belts: 2, nosmk: 2, emer: 1, dome: 1 };
  const RUN = Object.assign({}, PWR, ALLP, SIGNS, { genL: 1, genR: 1, bugL: 1, bugR: 1, fctlL: 1, fctlR: 1, hydL: 1, hydR: 1, hydC1: 1, hydC2: 1,
    packL: 1, packR: 1, trim: 1, islnL: 1, islnR: 1, bleedL: 1, bleedR: 1, recU: 1, recL: 1, probe: 1, whFL: 1, whFR: 1, whSL: 1, whSR: 1, nav: 1, beacon: 1, dome: 0 });
  const SCENES = {
    cold:     { label: 'COLD & DARK' },
    prestart: { label: 'BEFORE START', batt: 1, stby: 1, btieL: 1, btieR: 1, apu: 2, apug: 1, ife: 1, cabutil: 1, ...ALLP, hydC1: 1, hydC2: 2, hydL: 1, hydR: 1,
                nav: 1, beacon: 1, recU: 1, recL: 1, probe: 1, ...SIGNS, abrk: 0 },
    taxi:     { label: 'TAXI', ...RUN, taxi: 1, dome: 0, abrk: 0, strobe: 1 },
    takeoff:  { label: 'TAKEOFF', ...RUN, taxi: 0, ldgL: 1, ldgR: 1, nose: 1, rwyL: 1, rwyR: 1, strobe: 2, logo: 1, abrk: 0, dome: 0 },
    cruise:   { label: 'CRUISE', ...RUN, strobe: 2, belts: 1, nosmk: 1, logo: 1, dome: 0, abrk: 1 },
    landing:  { label: 'LANDING', ...RUN, ldgL: 1, ldgR: 1, nose: 1, rwyL: 1, rwyR: 1, wing: 1, strobe: 2, logo: 1, abrk: 4, dome: 0 },
    shutdown: { label: 'SHUTDOWN', ...PWR, apu: 2, apug: 1, ...ALLP, hydC2: 2, nav: 1, cabin: 1, dome: 1, emer: 1, ...{ btieL: 1, btieR: 1 }, abrk: 1 },
  };

  /* ───────────────────────── state ───────────────────────── */
  const DEFAULTS = () => ({
    open: false, bright: 1, sound: true, strict: false,
    sw: Object.fromEntries(DEFS.map(d => [d.id, d.def || 0])),
    ap: { spd: 250, hdg: 0, alt: 10000, vs: 0, ldg: 0 },
    mode: { lat: 'hdgs', vert: 'alth' },
  });
  function load() {
    const d = DEFAULTS();
    try {
      const o = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (o) {
        Object.assign(d, { open: !!o.open, bright: clamp(+o.bright || 1, .4, 1.3), sound: o.sound !== false, strict: !!o.strict });
        Object.assign(d.sw, o.sw || {}); Object.assign(d.ap, o.ap || {}); Object.assign(d.mode, o.mode || {});
      }
    } catch (e) { /* ignore */ }
    return d;
  }
  const S = load();
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } };

  const sim = {
    batt: 100, apu: 0, apuState: 'OFF', bus: false, busV: 0, src: false, engRun: false, extOk: false,
    last: performance.now(), lastInst: null, wantNative: null, nativeAssumed: false,
    warns: {}, prevWarns: {}, mcLit: false, mwLit: false, belts: null, nosmk: null,
    hold: {}, guard: {}, testUntil: 0, fireTest: 0, msgUntil: 0, chr: { run: false, t: 0 }, eff: {},
    cabAlt: null, dP: 0, pressSrc: false, hyd: { L: false, R: false, C: false }, wasAir: false, ab: false, abSet: false,
  };

  /* ───────────────────────── audio ───────────────────────── */
  let ac = null;
  function audio() {
    if (!S.sound) return null;
    try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; } catch (e) { return null; }
  }
  function tone(f, t0, d, type = 'sine', v = .06) {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + t0;
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + d);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + d + .05);
  }
  const sfx = {
    click: () => tone(1700, 0, .035, 'square', .025),
    knob: () => tone(900, 0, .05, 'square', .03),
    chime: () => { tone(880, 0, .4); tone(660, .2, .6); },
    caution: () => [0, .22, .44].forEach(t => tone(1050, t, .14, 'triangle', .07)),
    warn: () => [0, .3, .6, .9, 1.2, 1.5].forEach(t => { tone(1320, t, .12, 'square', .05); tone(1760, t + .13, .12, 'square', .04); }),
    bell: () => [0, .4, .8].forEach(t => tone(1500, t, .35, 'sine', .08)),
  };

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
  const setter = name => safe(() => (typeof controls.setters[name].set === 'function' ? controls.setters[name] : null), null);
  function viaSetterOrKey(name, key) { const s = setter(name); if (s) { safe(() => s.set()); return 'api'; } pressKey(key); return 'key'; }

  const gearPos = () => { const v = V().gearPosition; return typeof v === 'number' ? v : safe(() => controls.gear.position, 0); };
  const spdbrkPos = () => { const v = V().airbrakesPosition; return typeof v === 'number' ? v : safe(() => controls.airbrakes.position, 0); };
  const parkingSet = () => !!safe(() => controls.parkingBrake, false);
  const agl = v => (typeof v.haglFeet === 'number' ? v.haglFeet : Math.max(0, (v.altitude || 0) - (v.groundElevationFeet || 0)));
  const onGround = v => { const g = safe(() => inst().groundContact, undefined); return g !== undefined ? !!g : agl(v) < 8; };
  const gsKnots = v => (typeof v.groundSpeedKnt === 'number' ? v.groundSpeedKnt : (v.groundSpeed || 0) * 1.944);
  function engineRunning() {
    const on = safe(() => inst().engine.on, undefined);
    return on !== undefined ? !!on : (V().rpm || 0) > 300;
  }

  const LightBridge = {
    read() {
      const c = [() => geofs.aircraft.instance.lights.on, () => geofs.aircraft.instance.lightsOn, () => controls.lights, () => geofs.animation.values.lights];
      for (const f of c) { const r = safe(f, undefined); if (typeof r === 'boolean' || typeof r === 'number') return !!r; }
      return undefined;
    },
    toggle() { return GeoFSReal.lights(!(this.read() === undefined ? sim.nativeAssumed : this.read())); },
    set(want) {
      const cur = this.read();
      const c = cur === undefined ? sim.nativeAssumed : cur;
      if (c !== want) realDo('LIGHTS', GeoFSReal.lights(want));
      sim.nativeAssumed = want;
    },
  };

  const Engine = {
    start() { if (typeof safe(() => inst().startEngine, null) === 'function') { safe(() => inst().startEngine()); return true; } return false; },
    stop() { if (typeof safe(() => inst().stopEngine, null) === 'function') { safe(() => inst().stopEngine()); return true; } return false; },
  };

  const Flaps = {
    info() {
      const def = safe(() => inst().definition.flapsSteps, null);
      let n = typeof def === 'number' ? def : Array.isArray(def) ? def.length : safe(() => controls.flaps.maxPosition, 0);
      if (!n) n = 4;
      const t = safe(() => controls.flaps.target, undefined);
      let idx = typeof t === 'number' ? t : Math.round((V().flapsValue || 0) * n);
      return { n: clamp(Math.round(n), 1, 10), idx: clamp(Math.round(idx), 0, 10) };
    },
    set(i) {
      const { n, idx } = this.info(); i = clamp(i, 0, n);
      realDo('FLAPS', GeoFSReal.flaps(i));
    },
  };

  const AP = {
    api: () => safe(() => geofs.autopilot, null),
    on: () => !!safe(() => geofs.autopilot.on, false),
    push() {
      const a = this.api(); if (!a) return false;
      const set = (fn, k, v) => { if (typeof a[fn] === 'function') safe(() => a[fn](v)); else if (a.values) a.values[k] = v; };
      set('setSpeed', 'speed', S.ap.spd); set('setHeading', 'heading', S.ap.hdg);
      set('setAltitude', 'altitude', S.ap.alt); set('setVerticalSpeed', 'verticalSpeed', S.ap.vs);
      return true;
    },
    engage() {
      if (S.strict && !sim.bus) { say('AP: NO ELECTRICAL POWER', 'a'); return; }
      if (S.strict && S.sw.fcpc) { say('AP: PRIM FLT COMPUTERS DISC', 'a'); return; }
      const a = this.api(); if (!a) { say('AP: AUTOPILOT NOT FOUND', 'a'); return; }
      this.push(); safe(() => a.turnOn());
    },
    off() { safe(() => geofs.autopilot.turnOff()); },
    sync() {
      const v = V();
      S.ap.spd = Math.round(v.kias || S.ap.spd);
      S.ap.hdg = ((Math.round((v.heading360 != null ? v.heading360 : v.heading) || 0) % 360) + 360) % 360;
      S.ap.alt = Math.round((v.altitude || S.ap.alt) / 100) * 100;
      S.ap.vs = 0; if (this.on()) this.push(); commit(); say('AFDS TARGETS SYNCED');
    },
  };
  function setMode(id) {
    const a = AP.api(), v = V();
    if (id === 'lnav' || id === 'hdgs') {
      S.mode.lat = id;
      if (a && 'mode' in a) safe(() => { a.mode = id === 'lnav' ? 'NAV' : 'heading'; });
      else if (id === 'lnav') say('LNAV: NO GEOFS NAV MODE (USE CDU LEGS > LNAV)', 'a');
    } else {
      S.mode.vert = id;
      if (id === 'alth') { S.ap.alt = Math.round((v.altitude || S.ap.alt) / 100) * 100; S.ap.vs = 0; }
      if (id === 'flch') S.ap.vs = S.ap.alt > (v.altitude || 0) ? 2000 : -1500;
      if (id === 'vs' && !S.ap.vs) S.ap.vs = 1000;
    }
    sfx.click(); if (AP.on()) AP.push(); commit();
  }

  /* ───────────────────────── lamps ───────────────────────── */
  const L = (tc, tt, bc, bt) => ({ tc: tc || '', tt: tt || '', bc: bc || '', bt: bt || '' });
  function lampFor(id) {
    const on = !!S.sw[id], np = S.strict && !sim.bus, tst = sim.fireTest > performance.now();
    switch (id) {
      case 'batt': return on ? (sim.batt < 20 ? L('', '', 'a', 'LOW') : L('g', 'ON')) : L('', '', '', 'OFF');
      case 'ext': case 'ext2': return on ? L('g', 'ON') : sim.extOk ? L('b', 'AVAIL', '', 'OFF') : L('', '', '', 'OFF');
      case 'apug': return on ? (sim.apuState === 'AVAIL' ? L('g', 'ON') : L('', '', 'a', 'NO APU')) : L('', '', '', 'OFF');
      case 'genL': case 'genR': case 'bugL': case 'bugR': return on ? (sim.engRun ? L('g', 'ON') : L('', '', 'a', 'OFF BUS')) : L('', '', '', 'OFF');
      case 'btieL': case 'btieR': return on ? L('g', 'AUTO') : L('a', 'ISLN');
      case 'eng': return on ? L('g', 'RUN') : L('', '', '', 'OFF');
      case 'hydL': case 'hydR': return on ? (sim.engRun ? L('g', 'ON') : L('', '', 'a', 'LOW')) : L('', '', '', 'OFF');
      case 'rat': return on ? L('a', 'DEPLOY') : L('', '', '', 'STOW');
      case 'packL': case 'packR': return on ? (sim.pressSrc ? L('g', 'ON') : L('', '', 'a', 'NO AIR')) : L('', '', '', 'OFF');
      case 'bleedL': case 'bleedR': return on ? (sim.engRun ? L('g', 'ON') : L('', '', 'a', 'NO ENG')) : L('', '', '', 'OFF');
      case 'apuB': return on ? (sim.apuState === 'AVAIL' ? L('g', 'ON') : L('', '', 'a', 'NO APU')) : L('', '', '', 'OFF');
      case 'fireL': case 'fireR': case 'fireA': return tst ? L('r', 'FIRE', 'r', 'FIRE') : on ? L('a', 'PULLED', '', 'CUT') : L('', '', '', 'NORM');
      case 'cgfF': case 'cgfA': return tst ? L('r', 'FIRE') : on ? L('a', 'ARMED') : L('', '', '', 'OFF');
      case 'ftest': return tst ? L('r', 'TEST') : L('', '', '', 'PUSH');
      case 'call': case 'gcall': return L('', '', '', 'PUSH');
      case 'oxy': return on ? L('r', 'DEPLOY') : L('', '', '', 'NORM');
      case 'gear': { const p = gearPos(); return p >= .97 ? L('g', 'DOWN') : p > .03 ? L('r', 'TRANSIT') : L('', '', '', 'UP'); }
      case 'spd': return on ? L('a', 'OUT') : L('', '', '', 'IN');
      case 'pbrk': return on ? L('a', 'SET') : L('', '', '', 'REL');
      case 'fcpc': return on ? L('a', 'DISC') : L('', '', '', 'AUTO');
      case 'tac': return on ? L('', '', '', 'OFF') : L('g', 'AUTO');
      case 'apm': return on ? L('g', 'ENGD') : L('', '', '', 'OFF');
      case 'lnav': case 'hdgs': return S.mode.lat === id ? L('g', 'SEL') : L('', '', '', '');
      case 'alth': case 'vs': case 'flch': return S.mode.vert === id ? L('g', 'SEL') : L('', '', '', '');
      default: return on ? (np ? L('', '', 'a', 'NO PWR') : L('g', 'ON')) : L('', '', '', 'OFF');
    }
  }

  /* ───────────────────────── effective states & warnings ───────────────────────── */
  function computeEffective(v) {
    const pow = S.strict ? sim.bus : true, airborne = !onGround(v), alt = v.altitude || 0;
    const gp = gearPos(), fl = Flaps.info().idx, e = {};
    ['ldgL', 'ldgR', 'nose', 'rwyL', 'rwyR', 'taxi', 'nav', 'beacon', 'wing', 'logo', 'cabin', 'storm'].forEach(k => { e[k] = !!S.sw[k] && pow; });
    e.landing = e.ldgL || e.ldgR || e.nose;
    e.strobe = pow && (S.sw.strobe === 2 || (S.sw.strobe === 1 && airborne));
    e.dome = pow ? S.sw.dome : 0;
    e.emer = S.sw.emer === 2 || (S.sw.emer === 1 && !sim.bus);
    const beltsAuto = airborne ? (alt < 10000 || gp > .5 || fl > 0) : sim.engRun;
    e.belts = pow && (S.sw.belts === 2 || (S.sw.belts === 1 && (beltsAuto || sim.cabAlt > 9500)));
    e.nosmk = pow && (S.sw.nosmk === 2 || (S.sw.nosmk === 1 && (alt < 10000 || sim.cabAlt > 9500)));
    return e;
  }
  function computeWarnings(v) {
    const airborne = !onGround(v), gp = gearPos(), kias = v.kias || 0, alt = v.altitude || 0, e = sim.eff;
    const pumps = PUMPS.some(k => S.sw[k]) && (!S.strict || sim.bus);
    return {
      gear: (gp > .03 && gp < .97) || (airborne && gp < .03 && agl(v) < 1000 && kias < 160 && agl(v) > 30),
      spd: spdbrkPos() > .5 && airborne && gp > .5,
      ldg10: e.landing && alt > 10500,
      taxiAir: e.taxi && airborne && agl(v) > 100,
      batt: !!S.sw.batt && sim.batt < 20 && !sim.src,
      bus: !sim.bus && (sim.engRun || airborne),
      hyd: (sim.engRun || airborne) && !(sim.hyd.L || sim.hyd.R || sim.hyd.C),
      fuel: sim.engRun && !pumps && S.strict,
      fcpc: !!S.sw.fcpc && airborne,
      cab: sim.cabAlt > 10000,
      fire: sim.fireTest > performance.now(),
      oxy: !!S.sw.oxy, rat: !!S.sw.rat,
    };
  }
  const CAUTION = ['gear', 'spd', 'ldg10', 'taxiAir', 'batt', 'bus', 'hyd', 'fuel', 'fcpc', 'rat'];
  const WARNING = ['cab', 'fire', 'oxy'];
  const ANN = [
    ['gear', 'GEAR', 'r'], ['cab', 'CABIN ALT', 'r'], ['fire', 'FIRE', 'r'], ['oxy', 'PAX OXY', 'r'], ['spd', 'SPD BRK', 'a'], ['ldg10', 'LDG LT >10K', 'a'],
    ['taxiAir', 'TAXI LT', 'a'], ['batt', 'BATT LOW', 'a'], ['bus', 'BUS OFF', 'a'], ['hyd', 'HYD PRESS', 'a'], ['fuel', 'FUEL PRESS', 'a'],
    ['fcpc', 'PRIM FLT DISC', 'a'], ['rat', 'RAT', 'a'], ['park', 'PARK BRK', 'a'], ['apu', 'APU AVAIL', 'g'], ['ext', 'EXT PWR', 'b'],
    ['engr', 'ENG RUN', 'g'], ['ap', 'AP ENGD', 'g'], ['ab', 'AUTOBRAKE', 'g'], ['belts', 'SEAT BELTS', 'w'], ['nosmk', 'NO SMOKE', 'w'], ['emer', 'EMER LT', 'r'],
  ];

  /* ───────────────────────── commands ───────────────────────── */
  // run a verified GeoFS command; tell the pilot if GeoFS ignored it
  function realDo(name, pr) { return Promise.resolve(pr).then(m => { if (/FAILED/.test(String(m))) { say(name + ': NO RESPONSE FROM GEOFS - RUN SELF-TEST', 'a'); sfx.caution && sfx.caution(); } render(); return m; }); }
  async function selfTest() {
    say('SELF-TEST RUNNING...'); const res = await GeoFSReal.selfTest(); console.table(res);
    let el = $('#gfo-st'); if (!el) { el = document.createElement('div'); el.id = 'gfo-st'; el.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:99999;background:#101418;color:#dfe;border:2px solid #000;border-radius:8px;padding:10px 12px;font:600 12px ui-monospace,monospace;max-width:min(560px,96vw);max-height:70vh;overflow:auto;box-shadow:0 8px 30px #000c'; document.body.appendChild(el); el.addEventListener('click', () => el.remove()); }
    el.innerHTML = '<b>GEOFS CONTROL SELF-TEST</b> <small>(tap to close)</small><br>' + res.map(x => `<div style="color:${x.ok ? '#7dff9a' : '#ff8d7d'}">${x.ok ? '✔' : '✘'} ${x.ctl}: ${x.how}${x.note ? ' (' + x.note + ')' : ''}</div>`).join('') + '<small>Failed = GeoFS did not change state after setter, direct write and key press. Copy the API line to me if so.</small>';
    const bad = res.filter(x => !x.ok); say(bad.length ? 'SELF-TEST: ' + bad.length + ' FAILED - SEE LIST' : 'SELF-TEST: ALL CONTROLS RESPOND', bad.length ? 'a' : ''); return res;
  }
  function say(msg, c) {
    const el = $('#gfo-msg'); if (!el) return;
    el.textContent = msg; el.dataset.c = c || ''; sim.msgUntil = performance.now() + 4500;
  }
  function commit() { save(); render(); }
  function cutIfBoth() { if (!S.sw.fctlL && !S.sw.fctlR && sim.engRun) { Engine.stop(); sim.hold.eng = performance.now() + 3500; S.sw.eng = 0; say('ENGINES SHUTDOWN (BOTH FUEL CONTROLS CUTOFF)'); } }

  const MIRROR_CUR = { gear: () => gearPos() > .5, spd: () => spdbrkPos() > .5, pbrk: () => parkingSet(), eng: () => engineRunning(), apm: () => AP.on() };
  // set a mirrored (real) control to a wanted state; used by Crew Link. local=true bypasses the guest->host forwarding.
  function pressTo(id, want, local) { const c = MIRROR_CUR[id]; if (!c || c() === !!want) return; sim.localApply = !!local; try { press(id); } finally { sim.localApply = false; } }
  function press(id, dir = 1) {
    const d = DEFMAP[id]; if (!d) return;
    const now = performance.now();
    if (d.guard && !MIRRORED.has(id)) {
      if (now > (sim.guard[id] || 0)) { sim.guard[id] = now + 5000; sfx.click(); say(d.label + ': GUARD OPEN', 'a'); return render(); }
      sim.guard[id] = 0;
    }
    if (d.mom) {
      sfx.click();
      if (id === 'ftest') { sim.fireTest = now + 5000; sfx.bell(); say('FIRE TEST', 'r'); }
      else { sfx.chime(); say(id === 'call' ? 'ATTENDANT CALL' : 'GROUND CALL'); }
      return render();
    }
    if (MODEBTN.has(id)) return setMode(id);
    if (MIRRORED.has(id)) {
      sfx.click();
      const curOf = MIRROR_CUR[id];
      if (!sim.localApply && window.GeoFSReal && GeoFSReal.remote && curOf) { GeoFSReal.remote('press', { id, want: !curOf() }); say(d.label + ' -> HOST'); return; }
      switch (id) {
        case 'eng':
          if (!S.sw.eng) {
            if (S.strict && !sim.bus) { say('ENG START: NO ELECTRICAL POWER', 'a'); return; }
            if (S.strict && !PUMPS.some(k => S.sw[k])) { say('ENG START: FUEL PUMPS OFF', 'a'); return; }
            if (S.strict && S.sw.fireL && S.sw.fireR) { say('ENG START: FIRE HANDLES PULLED', 'a'); return; }
            if (!Engine.start()) say('ENG START: API NOT FOUND', 'a'); else { say('ENGINE START'); S.sw.fctlL = 1; S.sw.fctlR = 1; }
          } else { Engine.stop(); say('ENGINE SHUTDOWN'); }
          sim.hold.eng = performance.now() + 3500; S.sw.eng = S.sw.eng ? 0 : 1; break;
        case 'gear': { const p = gearPos(); if (p > .03 && p < .97) { say('GEAR IN TRANSIT', 'a'); return; } realDo('GEAR', GeoFSReal.gear(!(p > .5))); break; }
        case 'spd': realDo('SPEEDBRAKE', GeoFSReal.airbrake(!(spdbrkPos() > .5))); break;
        case 'pbrk': realDo('PARK BRK', GeoFSReal.parking(!parkingSet())); break;
        case 'apm': AP.on() ? AP.off() : AP.engage(); break;
      }
      setTimeout(render, 250); return;
    }
    if (d.t === 'rot') { const n = d.opts.length; S.sw[id] = (S.sw[id] + dir + n) % n; sfx.knob(); }
    else { S.sw[id] = S.sw[id] ? 0 : 1; sfx.click(); }

    // side effects
    const on = !!S.sw[id];
    if ((id === 'ext' || id === 'ext2') && on && !sim.extOk) { S.sw[id] = 0; say('EXT PWR: AIRCRAFT MUST BE STOPPED ON GROUND', 'a'); }
    if (id === 'apu' && S.sw.apu && S.strict && !sim.bus) { S.sw.apu = 0; say('APU: NO POWER TO START', 'a'); }
    if ((id === 'fctlL' || id === 'fctlR') && !on) cutIfBoth();
    if (id === 'fireL' && on) { Object.assign(S.sw, { fctlL: 0, genL: 0, hydL: 0, bleedL: 0, bugL: 0 }); say('ENG L FIRE HANDLE PULLED', 'a'); cutIfBoth(); }
    if (id === 'fireR' && on) { Object.assign(S.sw, { fctlR: 0, genR: 0, hydR: 0, bleedR: 0, bugR: 0 }); say('ENG R FIRE HANDLE PULLED', 'a'); cutIfBoth(); }
    if (id === 'fireA' && on) { Object.assign(S.sw, { apu: 0, apug: 0, apuB: 0 }); say('APU FIRE HANDLE PULLED', 'a'); }
    if (id === 'rat' && on) say('RAT DEPLOYED', 'a');
    if (id === 'oxy' && on) { sfx.warn(); say('PASSENGER OXYGEN DEPLOYED', 'r'); }
    commit();
  }

  function scene(name) {
    const s = SCENES[name]; if (!s) return;
    DEFS.forEach(d => { if (!MIRRORED.has(d.id)) S.sw[d.id] = d.def || 0; });
    Object.keys(s).forEach(k => { if (k !== 'label') S.sw[k] = s[k]; });
    sfx.chime(); say('SCENE: ' + s.label); commit();
  }

  /* ───────────────────────── simulation tick ───────────────────────── */
  function tick() {
    const now = performance.now(), dt = clamp((now - sim.last) / 1000, 0, 1); sim.last = now;
    const v = V(), I = inst();

    if (I !== sim.lastInst) { sim.lastInst = I; sim.wantNative = null; sim.nativeAssumed = false; setTimeout(buildFlaps, 400); }
    sim.engRun = engineRunning();
    const ground = onGround(v), gs = gsKnots(v), alt = v.altitude || 0;
    sim.extOk = ground && gs < 3 && !sim.engRun;
    ['ext', 'ext2'].forEach(k => { if (S.sw[k] && !sim.extOk) { S.sw[k] = 0; say('EXT PWR DISCONNECTED'); } });

    // APU
    if (S.sw.apu) {
      if (sim.apuState !== 'START' && sim.apuState !== 'AVAIL') sim.apuState = 'START';
      if (sim.apuState === 'START') { sim.apu = Math.min(100, sim.apu + dt * 100 / (S.sw.apu === 2 ? 10 : 14)); if (sim.apu >= 100) { sim.apuState = 'AVAIL'; sfx.chime(); say('APU AVAILABLE', 'g'); } }
    } else if (sim.apu > 0) { sim.apu = Math.max(0, sim.apu - dt * 100 / 8); sim.apuState = sim.apu > 0 ? 'DOWN' : 'OFF'; }
    else sim.apuState = 'OFF';

    // buses + battery
    const apuOn = sim.apuState === 'AVAIL' && !!S.sw.apug;
    const src = ((!!S.sw.genL || !!S.sw.genR || !!S.sw.bugL || !!S.sw.bugR) && sim.engRun) || apuOn || !!S.sw.ext || !!S.sw.ext2;
    sim.src = src;
    const batOn = !!S.sw.batt || S.sw.stby > 0;
    sim.bus = src || (batOn && sim.batt > 0);
    if (batOn) {
      if (src) sim.batt = Math.min(100, sim.batt + dt * .25);
      else {
        const loads = [...LIGHT_IDS.filter(k => k !== 'strobe'), 'strobe', 'cabin', 'ife', 'cabutil', 'probe', 'wai', 'whFL', 'whFR', 'whSL', 'whSR', 'dome', 'storm', ...PUMPS].filter(k => S.sw[k]).length;
        sim.batt = Math.max(0, sim.batt - dt * (.03 + loads * .01));
      }
    }
    sim.busV = sim.bus ? (src ? 28 : 22 + 6 * sim.batt / 100) + (Math.random() - .5) * .06 : 0;

    // hydraulics (simulated)
    const demand = k => S.sw[k] === 2 || (S.sw[k] === 1 && sim.bus && (!sim.engRun || !S.sw.hydL || !S.sw.hydR));
    sim.hyd = { L: !!S.sw.hydL && sim.engRun, R: !!S.sw.hydR && sim.engRun, C: (demand('hydC1') || demand('hydC2')) && sim.bus || !!S.sw.rat && !ground };

    // air + pressurisation (simulated)
    sim.pressSrc = (!!S.sw.bleedL && sim.engRun) || (!!S.sw.bleedR && sim.engRun) || (!!S.sw.apuB && sim.apuState === 'AVAIL');
    const packs = (S.sw.packL ? 1 : 0) + (S.sw.packR ? 1 : 0), pressurised = sim.pressSrc && packs > 0;
    if (sim.cabAlt === null) sim.cabAlt = alt;
    let tgt = alt;
    if (pressurised && !ground) {
      tgt = Math.min(alt, 8000 * Math.min(1, alt / 41000));
      if ((v.verticalSpeed || 0) < -300 && alt < 20000) tgt = Math.min(alt, S.ap.ldg);
    } else if (pressurised && ground) tgt = alt;
    const rate = (tgt > sim.cabAlt ? (pressurised ? 500 : 1500) : (pressurised ? 400 : 3000)) / 60;
    sim.cabAlt += clamp(tgt - sim.cabAlt, -rate * dt, rate * dt);
    sim.dP = Math.max(0, pAt(sim.cabAlt) - pAt(alt));

    // RAT auto-deploy
    if (!ground && !sim.engRun && !S.sw.rat) { S.sw.rat = 1; sfx.caution(); say('RAT DEPLOYED (BOTH ENGINES OUT)', 'a'); }

    // mirror real aircraft state back onto the panel
    if (now > (sim.hold.eng || 0)) { S.sw.eng = sim.engRun ? 1 : 0; if (sim.engRun && !S.sw.fctlL && !S.sw.fctlR) { S.sw.fctlL = 1; S.sw.fctlR = 1; } }
    S.sw.pbrk = parkingSet() ? 1 : 0; S.sw.spd = spdbrkPos() > .5 ? 1 : 0; S.sw.apm = AP.on() ? 1 : 0;
    if (S.strict && S.sw.apm && (!sim.bus || S.sw.fcpc)) { AP.off(); say('AP DISCONNECT', 'r'); }

    // effective lights → GeoFS
    const e = (sim.eff = computeEffective(v));
    const any = !!(e.landing || e.rwyL || e.rwyR || e.taxi || e.nav || e.strobe || e.beacon || e.wing || e.logo);
    if (sim.wantNative !== any) { sim.wantNative = any; LightBridge.set(any); }

    // cabin signs chime
    if (sim.belts !== null && (e.belts !== sim.belts || e.nosmk !== sim.nosmk)) sfx.chime();
    sim.belts = e.belts; sim.nosmk = e.nosmk;

    // autobrake (experimental): apply after touchdown, release when slow
    if (ground && sim.wasAir && S.sw.abrk >= 2 && typeof safe(() => controls.brakes, null) === 'number') { sim.ab = true; say('AUTOBRAKE APPLIED'); }
    if (sim.ab) {
      if (!ground || gs < 20 || S.sw.abrk < 2) { sim.ab = false; if (sim.abSet) { safe(() => { controls.brakes = 0; }); sim.abSet = false; } }
      else { safe(() => { controls.brakes = [.25, .4, .55, .7, 1][S.sw.abrk - 2]; }); sim.abSet = true; }
    }
    sim.wasAir = !ground;

    // warnings / master caution / master warning
    sim.warns = computeWarnings(v);
    let freshC = false, freshW = false;
    CAUTION.forEach(k => { if (sim.warns[k] && !sim.prevWarns[k]) freshC = true; });
    WARNING.forEach(k => { if (sim.warns[k] && !sim.prevWarns[k]) freshW = true; });
    if (freshW) { sim.mwLit = true; sfx.warn(); } else if (freshC) { sim.mcLit = true; sfx.caution(); }
    if (!CAUTION.some(k => sim.warns[k])) sim.mcLit = false;
    if (!WARNING.some(k => sim.warns[k])) sim.mwLit = false;
    sim.prevWarns = sim.warns;

    if (sim.chr.run) sim.chr.t += dt;

    // cockpit glow
    const tint = $('#gfo-tint');
    if (tint) {
      const cam = safe(() => geofs.camera.currentModeName, 'cockpit');
      const o = Math.max([0, .22, .42][e.dome] || 0, e.storm ? .55 : 0, e.emer ? .5 : 0);
      tint.style.opacity = cam === 'cockpit' || cam === undefined ? o : 0;
      tint.dataset.emer = e.emer ? '1' : '0';
    }
    render();
  }

  /* ───────────────────────── UI ───────────────────────── */
  const CSS = `
  #gfo-root,#gfo-root *{box-sizing:border-box}
  #gfo-root{position:fixed;left:50%;top:0;z-index:99990;width:min(1320px,99vw);transform:translate(-50%,-100%);transition:transform .38s cubic-bezier(.2,.8,.2,1);
    font:600 11px/1.2 "Segoe UI",system-ui,sans-serif;color:#d9dfe3;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;filter:brightness(var(--gfo-b,1))}
  #gfo-root.open{transform:translate(-50%,0)}
  #gfo-tab{all:unset;position:absolute;left:50%;top:100%;margin-left:-60px;width:120px;height:20px;text-align:center;line-height:20px;
    cursor:pointer;background:linear-gradient(#3a3f44,#2a2e32);border:1px solid #0d0f11;border-top:none;border-radius:0 0 9px 9px;font-size:10px;letter-spacing:.14em;color:#cfd6db;box-shadow:0 3px 8px #0008}
  #gfo-tab:hover{color:#fff}
  .gfo-body{background:linear-gradient(#383d42,#272b2f);border:2px solid #121416;border-top:none;border-radius:0 0 16px 16px;box-shadow:0 14px 44px #000b,inset 0 1px 0 #ffffff22;padding:calc(8px + env(safe-area-inset-top,0px)) 10px 10px;max-height:86vh;max-height:86dvh;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
  .gfo-head{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #00000055;box-shadow:0 1px 0 #ffffff12}
  .gfo-title{font-size:13px;letter-spacing:.16em;color:#f1f4f6}.gfo-title small{font-size:9px;color:#8e99a1;letter-spacing:.05em;margin-left:4px}
  .gfo-lcds{display:flex;gap:6px;flex-wrap:wrap}
  .gfo-rd{background:#07140c;border:1px solid #000;border-radius:3px;padding:3px 7px;display:flex;gap:6px;align-items:baseline;box-shadow:inset 0 1px 4px #000}
  .gfo-rd span{font-size:8px;color:#4a8d63;letter-spacing:.1em}.gfo-rd b{font:700 12px Consolas,"Courier New",monospace;color:#6dff9b;min-width:46px;text-align:right}
  .gfo-rd.warn b{color:#ffbf47}.gfo-rd.bad b{color:#ff6b5e}.gfo-rd.chr{cursor:pointer}
  .gfo-msg{flex:1 1 180px;min-width:150px;background:#07140c;border:1px solid #000;border-radius:3px;padding:5px 8px;font:700 11px Consolas,monospace;color:#6dff9b;box-shadow:inset 0 1px 4px #000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gfo-msg[data-c=a]{color:#ffbf47}.gfo-msg[data-c=r]{color:#ff6b5e}
  .gfo-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .gfo-btn,.gfo-mini{all:unset;box-sizing:border-box;cursor:pointer;padding:4px 8px;border-radius:3px;background:linear-gradient(#4b5157,#353a3f);border:1px solid #0d0f11;font-size:9.5px;letter-spacing:.08em;color:#dfe5e9;box-shadow:0 1px 0 #0007,inset 0 1px 0 #ffffff22}
  .gfo-btn:active,.gfo-mini:active{transform:translateY(1px)}.gfo-btn.on{color:#6dff9b;box-shadow:0 0 6px #2cff8a55,inset 0 1px 0 #ffffff22}
  .gfo-btn:focus-visible,.gfo-pb:focus-visible,.gfo-det:focus-visible,.gfo-mini:focus-visible,.gfo-rot:focus-visible,#gfo-tab:focus-visible,.gfo-mc:focus-visible{outline:2px solid #7cc4ff;outline-offset:1px}
  .gfo-tools label{display:flex;gap:5px;align-items:center;font-size:9px;letter-spacing:.1em;color:#9aa5ad}.gfo-tools input[type=range]{width:70px;accent-color:#e6b84a}
  .gfo-scenes{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-bottom:12px}.gfo-scenes>span{font-size:9px;letter-spacing:.12em;color:#8f9aa2;margin-right:2px}
  .gfo-grid{display:flex;flex-wrap:wrap;gap:14px 10px}
  .gfo-grp{position:relative;flex:1 1 auto;border:1px solid #0b0d0f;border-radius:6px;padding:15px 9px 9px;background:#0000001c;box-shadow:inset 0 0 0 1px #ffffff0e;display:flex;flex-wrap:wrap;gap:7px;align-items:flex-start}
  .gfo-grp>h4{position:absolute;margin:0;top:-1px;left:10px;transform:translateY(-50%);background:#30353a;padding:0 6px;font-size:9.5px;letter-spacing:.14em;color:#eef2f4;font-weight:700}
  .gfo-pb{all:unset;box-sizing:border-box;width:60px;height:56px;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;padding:3px;border-radius:4px;border:1px solid #0b0d0f;
    background:linear-gradient(#50565c,#363b40);box-shadow:0 2px 0 #000a,inset 0 1px 0 #ffffff28}
  .gfo-pb:active{transform:translateY(1px);box-shadow:0 1px 0 #000a,inset 0 1px 0 #ffffff28}
  .gfo-pb.guard{border:2px solid #7d1d16}.gfo-pb.guard.lift{border-color:#ff5a4a;box-shadow:0 0 10px #ff3b2e99,0 2px 0 #000a}
  .gfo-pb i{display:block;height:13px;border-radius:2px;background:#15181b;text-align:center;font:700 8px/13px "Segoe UI",sans-serif;font-style:normal;letter-spacing:.06em;color:#3a424a;box-shadow:inset 0 1px 2px #000;overflow:hidden;white-space:nowrap}
  .gfo-pb .lbl{font-size:8px;text-align:center;letter-spacing:.03em;color:#edf1f4;line-height:1;white-space:nowrap;overflow:hidden}
  i.lg{background:#0f4a2e;color:#7dffb4;box-shadow:0 0 9px #27e58b99,inset 0 0 3px #0008}
  i.la{background:#5a3b05;color:#ffd470;box-shadow:0 0 9px #ffa31a88,inset 0 0 3px #0008}
  i.lw{background:#707880;color:#fff;box-shadow:0 0 7px #fff4,inset 0 0 3px #0006}
  i.lb{background:#0d3f66;color:#a9deff;box-shadow:0 0 9px #3aa7ff88,inset 0 0 3px #0008}
  i.lr{background:#661410;color:#ffb1a8;box-shadow:0 0 9px #ff463a99,inset 0 0 3px #0008}
  .gfo-rot{all:unset;box-sizing:border-box;width:72px;text-align:center;cursor:pointer;padding:2px 0}
  .gfo-rot .knob{position:relative;width:34px;height:34px;margin:0 auto 3px;border-radius:50%;border:2px solid #0b0d0f;background:radial-gradient(circle at 35% 28%,#7a828a,#2b3035 72%);box-shadow:0 2px 4px #000a,inset 0 1px 0 #ffffff33;transition:transform .16s}
  .gfo-rot .knob b{position:absolute;left:50%;top:2px;width:3px;height:11px;margin-left:-1.5px;border-radius:2px;background:#f4f6f7}
  .gfo-rot .lbl{font-size:8.5px;letter-spacing:.03em;color:#edf1f4;margin-bottom:2px;white-space:nowrap}
  .gfo-rot .opts{display:flex;justify-content:space-between;font-size:7px;color:#7f8a92;padding:0 1px}.gfo-rot .opts u{text-decoration:none}.gfo-rot .opts u.sel{color:#ffd24a;font-weight:800}
  .gfo-flaps-wrap{display:flex;flex-direction:column;gap:3px}.gfo-flaps-wrap>span{font-size:8.5px;letter-spacing:.1em;color:#9aa5ad}
  .gfo-flaps{display:flex;gap:3px}
  .gfo-det{all:unset;box-sizing:border-box;min-width:34px;height:24px;line-height:22px;text-align:center;cursor:pointer;border-radius:3px;border:1px solid #0b0d0f;background:linear-gradient(#4a5056,#33383d);font-size:9px;color:#d7dde1;padding:0 4px;box-shadow:0 1px 0 #000a}
  .gfo-det.act{background:#5a3b05;color:#ffd470;box-shadow:0 0 8px #ffa31a77}
  .gfo-apf{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end}
  .gfo-fld{display:flex;flex-direction:column;gap:2px;position:relative}.gfo-fld span{font-size:8.5px;letter-spacing:.1em;color:#9aa5ad}
  .gfo-fld em{position:absolute;right:5px;bottom:4px;font-style:normal;font-size:7.5px;color:#3f7a58;pointer-events:none}
  .gfo-lcd{all:unset;box-sizing:border-box;width:68px;padding:4px 20px 4px 4px;border-radius:3px;background:#07140c;border:1px solid #000;color:#6dff9b;font:700 13px Consolas,monospace;text-align:right;box-shadow:inset 0 1px 4px #000;-moz-appearance:textfield;user-select:text;-webkit-user-select:text}
  .gfo-lcd:focus{outline:2px solid #7cc4ff}.gfo-lcd::-webkit-inner-spin-button{display:none}
  .gfo-annun{display:flex;flex-wrap:wrap;gap:5px;margin-top:12px;padding-top:9px;border-top:1px solid #00000055;box-shadow:0 -1px 0 #ffffff10}
  .gfo-an{padding:5px 8px;border-radius:2px;background:#15181b;border:1px solid #000;font-size:9px;letter-spacing:.08em;color:#2e353b;box-shadow:inset 0 1px 3px #000}
  .gfo-an.lit[data-c=g]{background:#0f4a2e;color:#7dffb4;box-shadow:0 0 9px #27e58b88}.gfo-an.lit[data-c=a]{background:#5a3b05;color:#ffd470;box-shadow:0 0 9px #ffa31a88}
  .gfo-an.lit[data-c=r]{background:#661410;color:#ffb1a8;box-shadow:0 0 9px #ff463a99}.gfo-an.lit[data-c=b]{background:#0d3f66;color:#a9deff;box-shadow:0 0 9px #3aa7ff88}.gfo-an.lit[data-c=w]{background:#6d757c;color:#fff}
  .gfo-mc,.gfo-mw{all:unset;cursor:pointer;padding:5px 10px;border-radius:2px;background:#15181b;border:1px solid #000;font-size:9px;letter-spacing:.08em;color:#2e353b;box-shadow:inset 0 1px 3px #000;margin-right:6px}
  .gfo-mc.lit{background:#7a4d05;color:#fff0c8;box-shadow:0 0 12px #ffa31acc;animation:gfo-bl 1s steps(2) infinite}
  .gfo-mw.lit{background:#8a1a12;color:#fff;box-shadow:0 0 12px #ff3b2eee;animation:gfo-bl .6s steps(2) infinite}
  @keyframes gfo-bl{50%{filter:brightness(.55)}}
  #gfo-tint{position:fixed;inset:0;z-index:99980;pointer-events:none;opacity:0;transition:opacity .5s;mix-blend-mode:screen;
    background:radial-gradient(ellipse 80% 55% at 50% -8%,rgba(255,196,120,.55),rgba(255,170,90,.12) 55%,transparent 80%)}
  #gfo-tint[data-emer="1"]{background:radial-gradient(ellipse 90% 60% at 50% -8%,rgba(255,240,225,.7),rgba(255,220,190,.18) 60%,transparent 85%)}
  @media (prefers-reduced-motion:reduce){#gfo-root,.gfo-rot .knob,#gfo-tint{transition:none}.gfo-mc.lit,.gfo-mw.lit{animation:none}}
  .gfo-step{display:none;flex-direction:column;gap:2px}.gfo-step button{all:unset;cursor:pointer;width:34px;height:20px;text-align:center;line-height:20px;border-radius:3px;background:linear-gradient(#4b5157,#353a3f);border:1px solid #0d0f11;color:#dfe5e9;font-size:12px}
  .gfo-apf .row{display:flex;gap:4px;align-items:flex-end}
  @media (max-width:700px){.gfo-pb{width:54px}.gfo-grp{flex:1 1 100%}}
  /* touch / iPad (Orion, Safari): bigger targets, steppers instead of wheel, 16px inputs so iOS doesn't zoom */
  @media (pointer:coarse),(hover:none){
    .gfo-pb{width:76px;height:70px;padding:4px}.gfo-pb i{height:17px;font-size:9.5px;line-height:17px}.gfo-pb .lbl{font-size:9.5px}
    .gfo-rot{width:88px;padding:4px 0}.gfo-rot .knob{width:44px;height:44px}.gfo-rot .lbl{font-size:10px}.gfo-rot .opts{font-size:8.5px}
    .gfo-det{min-width:48px;height:40px;line-height:38px;font-size:12px}
    .gfo-btn,.gfo-mini{padding:11px 13px;font-size:11px}
    .gfo-lcd{font-size:16px;width:86px;height:40px;padding:6px 22px 6px 6px}.gfo-fld em{bottom:12px}
    .gfo-step{display:flex}.gfo-step button{width:44px;height:19px;line-height:19px;font-size:14px}
    .gfo-an{padding:8px 10px;font-size:10px}.gfo-mc,.gfo-mw{padding:10px 14px;font-size:10px}
    #gfo-tab{width:150px;margin-left:-75px;height:34px;line-height:34px;font-size:12px}
    .gfo-tools input[type=range]{width:110px;height:28px}.gfo-grid{gap:18px 10px}.gfo-grp{padding-top:18px}
    .gfo-scenes{gap:8px}.gfo-body{padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}
  }
  `;

  let root = null;
  const pbHtml = (id, label, guard) => `<button class="gfo-pb${guard ? ' guard' : ''}" data-id="${id}" aria-label="${label}"><i class="t"></i><span class="lbl">${label}</span><i class="b"></i></button>`;
  function renderGroup(g) {
    const items = DEFS.filter(d => d.g === g.id).map(d => d.t === 'rot'
      ? `<button class="gfo-rot" data-id="${d.id}" aria-label="${d.label}"><div class="lbl">${d.label}</div><div class="knob"><b></b></div><div class="opts">${d.opts.map((o, i) => `<u data-o="${i}">${o}</u>`).join('')}</div></button>`
      : pbHtml(d.id, d.label, d.guard)).join('');
    return `<section class="gfo-grp" data-g="${g.id}"><h4>${g.title}</h4>${items}${g.extra || ''}</section>`;
  }

  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const tint = document.createElement('div'); tint.id = 'gfo-tint'; document.body.appendChild(tint);
    root = document.createElement('div'); root.id = 'gfo-root';
    root.innerHTML = `
    <div class="gfo-body">
      <div class="gfo-head">
        <div class="gfo-title">777-300ER OVERHEAD <small>v${VERSION}</small></div>
        <div class="gfo-lcds">
          <div class="gfo-rd"><span>BUS</span><b id="gfo-v">0.0 V</b></div>
          <div class="gfo-rd" id="gfo-batw"><span>BATT</span><b id="gfo-bat">100%</b></div>
          <div class="gfo-rd"><span>APU</span><b id="gfo-apu">0%</b></div>
          <div class="gfo-rd" id="gfo-cabw"><span>CAB ALT</span><b id="gfo-cab">0</b></div>
          <div class="gfo-rd"><span>DIFF P</span><b id="gfo-dp">0.0</b></div>
          <div class="gfo-rd chr" data-act="chr" title="Click: start/stop. Shift+click: reset"><span>CHR</span><b id="gfo-chr">00:00</b></div>
        </div>
        <div class="gfo-msg" id="gfo-msg" role="status">READY</div>
        <div class="gfo-tools">
          <label>BRT <input type="range" min="40" max="130" id="gfo-brt" aria-label="Panel brightness"></label>
          <button class="gfo-btn" data-act="strict" title="When on, lights, engine start and the autopilot need electrical power">STRICT ELEC</button>
          <button class="gfo-btn" data-act="sound">SOUND</button>
          <button class="gfo-btn" data-act="probe" title="Report which GeoFS APIs were found">API CHECK</button>
          <button class="gfo-btn" data-act="selftest" title="Test that gear/brakes/flaps/lights really respond (on the ground)">SELF-TEST</button>
          <button class="gfo-btn" data-act="close" aria-label="Close panel">CLOSE</button>
        </div>
      </div>
      <div class="gfo-scenes"><span>SCENES</span>${Object.entries(SCENES).map(([k, s]) => `<button class="gfo-btn" data-scene="${k}">${s.label}</button>`).join('')}</div>
      <div class="gfo-grid">${GROUPS.map(renderGroup).join('')}</div>
      <div class="gfo-annun" id="gfo-annun"><button class="gfo-mw" data-act="mw">MASTER WARNING</button><button class="gfo-mc" data-act="mc">MASTER CAUTION</button>
        ${ANN.map(([k, t, c]) => `<div class="gfo-an" data-an="${k}" data-c="${c}">${t}</div>`).join('')}
        <button class="gfo-btn" data-act="test" style="margin-left:auto">ANN TEST</button></div>
    </div>
    <button id="gfo-tab" aria-label="Toggle overhead panel (Alt+O)">▼ OVERHEAD</button>`;
    document.body.appendChild(root);
    // keep taps/drags on the panel from reaching GeoFS (its on-screen flight controls / canvas)
    ['pointerdown', 'mousedown', 'touchstart', 'touchmove'].forEach(ev => root.addEventListener(ev, e => e.stopPropagation(), { passive: true }));
    // iOS/iPadOS only lets WebAudio start from a user gesture: unlock it on the first touch
    const unlock = () => { audio(); document.removeEventListener('pointerdown', unlock, true); };
    document.addEventListener('pointerdown', unlock, true);
    buildFlaps();
    bind();
    root.style.setProperty('--gfo-b', S.bright);
    $('#gfo-brt').value = Math.round(S.bright * 100);
    applyOpen();
  }

  let flapsN = -1;
  function buildFlaps() {
    const box = $('#gfo-flaps'); if (!box) return;
    const { n } = Flaps.info(); if (n === flapsN) return; flapsN = n;
    box.innerHTML = Array.from({ length: n + 1 }, (_, i) => `<button class="gfo-det" data-flap="${i}">${i === 0 ? 'UP' : i === n ? 'FULL' : i}</button>`).join('');
  }

  function bind() {
    root.addEventListener('click', e => {
      const t = e.target;
      const pbn = t.closest('.gfo-pb'); if (pbn) return press(pbn.dataset.id);
      const nd = t.closest('[data-nudge]'); if (nd) { const [k, dr] = nd.dataset.nudge.split(','); return setAP(k, (S.ap[k] || 0) + (+dr) * AP_STEP[k]); }
      const rt = t.closest('.gfo-rot');
      if (rt) { // touch/pen: tap left half of a knob = previous position, right half = next (mouse: click = next, right-click = previous)
        const r = rt.getBoundingClientRect(), touch = e.pointerType === 'touch' || e.pointerType === 'pen';
        return press(rt.dataset.id, touch && e.clientX < r.left + r.width / 2 ? -1 : 1);
      }
      const fl = t.closest('.gfo-det'); if (fl) { Flaps.set(+fl.dataset.flap); sfx.click(); return setTimeout(render, 200); }
      const sc = t.closest('[data-scene]'); if (sc) return scene(sc.dataset.scene);
      const act = t.closest('[data-act]'); if (!act) return;
      switch (act.dataset.act) {
        case 'close': return toggle(false);
        case 'strict': S.strict = !S.strict; say(S.strict ? 'STRICT ELEC: SYSTEMS NEED POWER' : 'STRICT ELEC OFF'); sfx.click(); return commit();
        case 'sound': S.sound = !S.sound; if (S.sound) sfx.click(); return commit();
        case 'probe': return probe();
        case 'selftest': return selfTest();
        case 'test': sim.testUntil = performance.now() + 3000; sfx.caution(); return render();
        case 'mc': sim.mcLit = false; sfx.click(); return render();
        case 'mw': sim.mwLit = false; sfx.click(); return render();
        case 'apsync': return AP.sync();
        case 'chr': if (e.shiftKey) { sim.chr.t = 0; sim.chr.run = false; } else sim.chr.run = !sim.chr.run; sfx.click(); return render();
      }
    });
    root.addEventListener('contextmenu', e => { const r = e.target.closest('.gfo-rot'); if (r) { e.preventDefault(); press(r.dataset.id, -1); } });
    root.addEventListener('wheel', e => {
      const r = e.target.closest('.gfo-rot'); if (r) { e.preventDefault(); press(r.dataset.id, e.deltaY < 0 ? 1 : -1); return; }
      const inp = e.target.closest('[data-ap]'); if (inp) { e.preventDefault(); setAP(inp.dataset.ap, (+inp.value || 0) + (e.deltaY < 0 ? 1 : -1) * AP_STEP[inp.dataset.ap]); }
    }, { passive: false });
    $$('[data-ap]', root).forEach(inp => {
      inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
      inp.addEventListener('keyup', e => e.stopPropagation());
      inp.addEventListener('change', () => setAP(inp.dataset.ap, +inp.value));
    });
    $('#gfo-brt').addEventListener('input', e => { S.bright = +e.target.value / 100; root.style.setProperty('--gfo-b', S.bright); save(); });
    $('#gfo-tab').addEventListener('click', () => toggle());
  }
  function setAP(k, val, silent) {
    if (!isFinite(val) || !AP_LIM[k]) return;
    const lim = AP_LIM[k];
    S.ap[k] = k === 'hdg' ? ((Math.round(val) % 360) + 360) % 360 : clamp(Math.round(val), lim[0], lim[1]);
    if (AP.on() && k !== 'ldg') AP.push(); if (!silent) sfx.knob(); commit();
  }

  function setLamp(el, c, txt) { el.className = (el.classList.contains('t') ? 't' : 'b') + (c ? ' l' + c : ''); el.textContent = txt; }
  const fmt = s => { s = Math.floor(s); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

  function render() {
    if (!root || !S.open) return;
    const now = performance.now(), test = now < sim.testUntil;
    $$('.gfo-pb', root).forEach(p => {
      const l = lampFor(p.dataset.id);
      setLamp($('.t', p), test ? 'w' : l.tc, test ? '88' : l.tt); setLamp($('.b', p), test ? 'a' : l.bc, test ? '88' : l.bt);
      if (p.classList.contains('guard')) p.classList.toggle('lift', now < (sim.guard[p.dataset.id] || 0));
    });
    $$('.gfo-rot', root).forEach(r => {
      const d = DEFMAP[r.dataset.id], i = S.sw[d.id], n = d.opts.length;
      $('.knob', r).style.transform = `rotate(${-52 + i * (104 / (n - 1))}deg)`;
      $$('u', r).forEach((u, k) => u.classList.toggle('sel', k === i));
    });
    const fi = Flaps.info(); $$('.gfo-det', root).forEach(b => b.classList.toggle('act', +b.dataset.flap === fi.idx));
    $$('[data-ap]', root).forEach(inp => { if (document.activeElement !== inp) inp.value = S.ap[inp.dataset.ap]; });
    $('#gfo-v').textContent = sim.busV.toFixed(1) + ' V';
    $('#gfo-bat').textContent = Math.round(sim.batt) + '%';
    $('#gfo-batw').classList.toggle('warn', sim.batt < 20);
    $('#gfo-apu').textContent = Math.round(sim.apu) + '%';
    $('#gfo-cab').textContent = Math.round((sim.cabAlt || 0) / 10) * 10;
    $('#gfo-cabw').classList.toggle('bad', sim.cabAlt > 10000);
    $('#gfo-dp').textContent = sim.dP.toFixed(1);
    $('#gfo-chr').textContent = fmt(sim.chr.t);
    $('[data-act=strict]', root).classList.toggle('on', S.strict);
    $('[data-act=sound]', root).classList.toggle('on', S.sound);
    $('.gfo-mc', root).classList.toggle('lit', sim.mcLit || test);
    $('.gfo-mw', root).classList.toggle('lit', sim.mwLit || test);
    const w = sim.warns, e = sim.eff;
    const lit = {
      gear: w.gear, cab: w.cab, fire: w.fire, oxy: w.oxy, spd: w.spd, ldg10: w.ldg10, taxiAir: w.taxiAir, batt: w.batt, bus: w.bus, hyd: w.hyd, fuel: w.fuel,
      fcpc: w.fcpc, rat: w.rat, park: !!S.sw.pbrk, apu: sim.apuState === 'AVAIL', ext: !!(S.sw.ext || S.sw.ext2), engr: sim.engRun, ap: !!S.sw.apm, ab: sim.ab || S.sw.abrk >= 2,
      belts: e.belts, nosmk: e.nosmk, emer: e.emer,
    };
    $$('.gfo-an', root).forEach(a => a.classList.toggle('lit', test || !!lit[a.dataset.an]));
    const msg = $('#gfo-msg'); if (now > sim.msgUntil && msg.textContent !== 'READY') { msg.textContent = 'READY'; msg.dataset.c = ''; }
  }

  function applyOpen() {
    root.classList.toggle('open', S.open);
    $('#gfo-tab').textContent = S.open ? '▲ STOW' : '▼ OVERHEAD';
    if (S.open) render();
  }
  function toggle(force) { S.open = typeof force === 'boolean' ? force : !S.open; sfx.click(); save(); applyOpen(); }

  function probe() {
    const r = {
      geofs: !!window.geofs, aircraftInstance: !!inst(), animationValues: Object.keys(V()).length + ' values',
      setters: Object.keys(safe(() => controls.setters, {})), nativeLightState: LightBridge.read(),
      startEngine: typeof safe(() => inst().startEngine, null) === 'function', engineOn: safe(() => inst().engine.on, 'n/a'),
      flaps: Flaps.info(), autopilot: !!AP.api(), autopilotOn: AP.on(), autopilotMode: safe(() => geofs.autopilot.mode, 'n/a'),
      parkingBrake: parkingSet(), gearPosition: gearPos(), brakesWritable: typeof safe(() => controls.brakes, null) === 'number',
    };
    console.log('[GeoFS Overhead] API probe', r);
    const missing = [!r.aircraftInstance && 'aircraft', !r.startEngine && 'startEngine', !r.autopilot && 'autopilot', r.nativeLightState === undefined && 'light-state', !r.brakesWritable && 'brakes'].filter(Boolean);
    say(missing.length ? 'API CHECK: MISSING ' + missing.join(', ').toUpperCase() + ' (SEE CONSOLE)' : 'API CHECK: ALL BRIDGES FOUND', missing.length ? 'a' : '');
    return r;
  }

  /* ───────────────────────── input hooks ───────────────────────── */
  document.addEventListener('keydown', e => {
    if (e.altKey && e.code === 'KeyO') { e.preventDefault(); toggle(); return; }
    // user pressed GeoFS's own lights key: mirror it onto the panel (our synthetic presses are untrusted and ignored)
    if (e.isTrusted && e.code === 'KeyL' && !e.altKey && !e.ctrlKey && !e.metaKey && !typing(e)) {
      setTimeout(() => {
        const r = LightBridge.read(), now = r !== undefined ? r : !sim.nativeAssumed;
        sim.nativeAssumed = now; sim.wantNative = now;
        if (now) { ['ldgL', 'ldgR', 'nav', 'beacon'].forEach(k => { S.sw[k] = S.sw[k] || 1; }); S.sw.strobe = S.sw.strobe || 1; }
        else LIGHT_IDS.forEach(k => { S.sw[k] = 0; });
        commit();
      }, 80);
    }
  }, true);

  /* ───────────────────────── boot ───────────────────────── */
  function boot() {
    if (!document.body) return setTimeout(boot, 200);
    build();
    setInterval(tick, 200);
    window.GeoFSOverhead = {
      version: VERSION, press, pressTo, refresh: () => { try { render(); save(); } catch (e) { /* ignore */ } }, open: () => toggle(true), close: () => toggle(false), toggle, probe, selfTest, scene, state: S, sim, KEYS,
      setAP: (k, v) => setAP(k, v, true), // used by the lower-panel script (CDU LNAV)
      busPowered: () => sim.bus || !S.strict,
    };
    console.log('[GeoFS Overhead] loaded. Alt+O toggles the panel.');
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
GeoFSDock.add('#gfo-tab', 1);
