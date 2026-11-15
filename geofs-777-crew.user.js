// ==UserScript==
// @name         GeoFS 777-300ER Crew Voice, Cabin PA, Sound Pack + Cockpit Clock
// @namespace    https://github.com/geofs-overhead
// @version      1.0.0
// @description  Spoken challenge-and-response checklists, automatic callouts (80 knots, V1, rotate, positive rate, 1000/500/minimums/50-10, rollout, basic GPWS), timed cabin crew announcements tied to flight phase, a synthesised cabin chime sound pack, and a Boeing-style cockpit clock with UTC / date / elapsed time / chronometer.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * INSTALL: Tampermonkey/Violentmonkey -> Create new script -> paste -> save -> reload GeoFS.
 * USE:     Alt+V = crew panel, Alt+K = clock, Alt+Y = "respond" to the current checklist challenge.
 *          Tap the VOICE / CLOCK tabs on the left edge. First tap anywhere unlocks speech + sound on iPad/Safari/Orion.
 *
 * HONESTY NOTE
 *   Speech uses your browser's built-in text-to-speech (speechSynthesis), so voices, accents and speed depend on the
 *   device. Speech takes a few hundred ms to start, so "V1" and "Rotate" are spoken slightly EARLY (LEAD setting, kt).
 *   If speech is unavailable the same text still shows in the on-screen log.
 *   REAL      -> everything measured from the sim: speed, radio height, vertical speed, gear, flaps, speedbrake, roll.
 *   FROM CDU  -> V1/VR/V2 come from the Lower Panel script's CDU if installed (those are APPROXIMATE estimates there);
 *                otherwise type them in. Set them to 0 for "auto from CDU".
 *   SIM ONLY  -> the GPWS-style alerts (sink rate, pull up, too low gear, overspeed, bank angle) are simple threshold
 *                checks, NOT a certified GPWS. Cabin announcements are generic scripts, not any airline's.
 *   Checklists are generic sim checklists (not Boeing FCOM). Items are auto-verified against the Overhead / Lower
 *   panel scripts when installed. Voice recognition ("checked"/"set") is OPTIONAL and experimental: it needs a browser
 *   with SpeechRecognition + microphone permission, and may hear the TTS voice.
 */
(function () {
  'use strict';
  if (window.GeoFSCrew) return;

  const VERSION = '1.0.0';
  const STORE = 'geofsCrew.v1';

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
  const sw = k => safe(() => OV().state.sw[k], undefined);
  const fmc = () => safe(() => LO().fmc, null);
  const agl = v => (typeof v.haglFeet === 'number' ? v.haglFeet : Math.max(0, (v.altitude || 0) - (v.groundElevationFeet || 0)));
  const onGround = v => { const g = safe(() => inst().groundContact, undefined); return g !== undefined ? !!g : agl(v) < 8; };
  const gsKt = v => (typeof v.groundSpeedKnt === 'number' ? v.groundSpeedKnt : (v.groundSpeed || 0) * 1.944);
  const gearPos = () => { const v = V().gearPosition; return typeof v === 'number' ? v : safe(() => controls.gear.position, 0); };
  const sbPos = () => { const v = V().airbrakesPosition; return typeof v === 'number' ? v : safe(() => controls.airbrakes.position, 0); };
  const parkSet = () => !!safe(() => controls.parkingBrake, false);
  const engRun = () => { const on = safe(() => inst().engine.on, undefined); return on !== undefined ? !!on : (V().rpm || 0) > 300; };
  const flapN = () => { const d = safe(() => inst().definition.flapsSteps, null); const n = typeof d === 'number' ? d : Array.isArray(d) ? d.length : safe(() => controls.flaps.maxPosition, 0); return clamp(Math.round(n || 4), 1, 10); };
  const flapIdx = () => { const t = safe(() => controls.flaps.target, undefined); return clamp(Math.round(typeof t === 'number' ? t : (V().flapsValue || 0) * flapN()), 0, 10); };
  const throttle = () => { const t = safe(() => controls.throttle, undefined); return typeof t === 'number' ? t : 0; };
  const apOn = () => !!safe(() => geofs.autopilot.on, false);
  const digits = s => String(s).split('').join(' ');
  const getp = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const setp = (o, p, v) => { const ks = p.split('.'), l = ks.pop(); ks.reduce((a, k) => a[k], o)[l] = v; };

  /* ───────────────────────── settings / state ───────────────────────── */
  const DEF = () => ({
    open: false, x: 12, y: 70, tab: 'CHK',
    clock: { open: false, x: Math.max(8, (window.innerWidth || 1000) - 250), y: 70, utc: true, etAuto: true },
    voiceOn: true, pm: '', crew: '', rate: 1, vol: { call: 1, pa: 1, snd: .6 }, sound: true, amb: false, ambVol: .5,
    co: { takeoff: true, alt: true, appr: true, roll: true, gpws: true }, autoGear: false, lead: 2, v: { v1: 0, vr: 0, v2: 0 },
    sia: true, custom: { pa: '', signOn: '', signOff: '', call: '', interphone: '', alt10k: '', done: '' }, min: 200, ta: 18000, dest: '', sterile: true, paAuto: true, turb: true, autoRespond: true, listen: false,
  });
  const S = DEF();
  try { const o = JSON.parse(localStorage.getItem(STORE) || 'null'); if (o) Object.keys(S).forEach(k => { if (o[k] !== undefined) S[k] = (S[k] && typeof S[k] === 'object') ? Object.assign(S[k], o[k]) : o[k]; }); } catch (e) { /* ignore */ }
  S.open = false; S.listen = false;
  let saveT = 0; const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } }, 400); };
  const logLines = [];
  function log(who, text) { logLines.unshift({ who, text, t: Date.now() }); if (logLines.length > 40) logLines.pop(); drawLog(); }

  /* ───────────────────────── audio: sound pack ───────────────────────── */
  let ac = null;
  function actx() { if (!S.sound && !S.amb) return null; try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; } catch (e) { return null; } }
  function bell(f, t0, d, v) {
    const a = actx(); if (!a || !S.sound) return; const t = a.currentTime + t0;
    [[1, 1], [2.01, .28], [3.02, .1]].forEach(([m, g]) => {
      const o = a.createOscillator(), gn = a.createGain(); o.type = 'sine'; o.frequency.value = f * m;
      gn.gain.setValueAtTime(0.0001, t); gn.gain.linearRampToValueAtTime((v || .12) * g * S.vol.snd, t + .008); gn.gain.exponentialRampToValueAtTime(.0001, t + d);
      o.connect(gn); gn.connect(a.destination); o.start(t); o.stop(t + d + .05);
    });
  }
  // Real recordings: paste a URL (or data: URI) to an audio file you own into the panel and it replaces the synthesised chime.
  const custom = {};
  function playCustom(k) {
    const u = (S.custom && S.custom[k] || '').trim(); if (!u || !S.sound) return false;
    try { const a = custom[k] && custom[k].src === u ? custom[k] : (custom[k] = new Audio(u)); a.volume = clamp(S.vol.snd * 1.4, 0, 1); a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => { synth[k](); }); return true; } catch (e) { return false; }
  }
  // Synthesised approximations. SIA-style = soft, warm, rising three-note PA tone with a long decay; single low "bing" for belts.
  const synth = {
    pa: () => { if (S.sia) { bell(784, 0, 1.1, .1); bell(988, .3, 1.1, .1); bell(1319, .6, 1.6, .1); } else { bell(988, 0, .5); bell(784, .32, .9); } },
    signOn: () => bell(S.sia ? 1047 : 1175, 0, S.sia ? 1.1 : .9),
    signOff: () => bell(S.sia ? 1047 : 1175, 0, S.sia ? 1.1 : .9),
    call: () => { if (S.sia) { bell(1047, 0, .5); bell(1047, .3, .8); } else { bell(880, 0, .4); bell(1175, .22, .6); } },
    interphone: () => [0, .35, .7].forEach(t => bell(1397, t, .25)),
    alt10k: () => { bell(1047, 0, .25); bell(1047, .22, .35); },
    done: () => { bell(1047, 0, .3); bell(1319, .15, .5); },
  };
  const SND = {}; Object.keys(synth).forEach(k => { SND[k] = () => { if (!playCustom(k)) synth[k](); }; });
  let amb = null;
  function ambience() {
    const a = actx();
    if (!S.amb || !a) { if (amb) { try { amb.src.stop(); } catch (e) { /* ignore */ } amb = null; } return; }
    if (!amb) {
      const len = a.sampleRate * 2, buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0); let l = 0;
      for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; l = (l + .02 * w) / 1.02; d[i] = l * 3.5; }
      const src = a.createBufferSource(); src.buffer = buf; src.loop = true;
      const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; const g = a.createGain(); g.gain.value = 0;
      src.connect(lp); lp.connect(g); g.connect(a.destination); src.start(); amb = { src, g };
    }
    const run = engRun(), k = V().kias || 0, tgt = run ? (.25 + clamp(k / 450, 0, 1) * .75) * .16 * S.ambVol : 0;
    amb.g.gain.value += (tgt - amb.g.gain.value) * .1;
  }

  /* ───────────────────────── speech ───────────────────────── */
  const TTS = { ok: 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined', voices: [] };
  function loadVoices() { if (!TTS.ok) return; TTS.voices = speechSynthesis.getVoices() || []; if (S.tab === 'VOICE') drawTab(); }
  if (TTS.ok) { loadVoices(); try { speechSynthesis.addEventListener('voiceschanged', loadVoices); } catch (e) { speechSynthesis.onvoiceschanged = loadVoices; } }
  function pickVoice(who) {
    const want = who === 'crew' ? S.crew : S.pm, vs = TTS.voices; if (!vs.length) return null;
    let v = vs.find(x => x.voiceURI === want); if (v) return v;
    const en = vs.filter(x => /^en/i.test(x.lang)); const pool = en.length ? en : vs;
    const fem = /female|samantha|karen|zira|susan|serena|moira|tessa|victoria|fiona|google uk english female|hazel/i, mal = /male|daniel|alex|david|mark|fred|oliver|arthur|google uk english male|george/i;
    return (who === 'crew' ? pool.find(x => fem.test(x.name)) : pool.find(x => mal.test(x.name))) || pool[0];
  }
  let speaking = 0;
  function speak(text, o = {}) {
    const who = o.who || 'pm'; log(who === 'crew' ? 'PA' : o.gpws ? 'GPWS' : who === 'pf' ? 'PF' : 'PM', text);
    if (!S.voiceOn || !TTS.ok) return Promise.resolve();
    return new Promise(res => {
      const u = new SpeechSynthesisUtterance(text); const v = pickVoice(who === 'crew' ? 'crew' : 'pm'); if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = clamp(S.rate * (o.rate || 1), .6, 1.8); u.pitch = who === 'crew' ? 1.08 : o.gpws ? .85 : who === 'pf' ? .9 : 1; u.volume = clamp((who === 'crew' ? S.vol.pa : S.vol.call) * (o.gpws ? 1 : 1), 0, 1);
      let done = false; const fin = () => { if (!done) { done = true; speaking = Math.max(0, speaking - 1); res(); } };
      u.onend = fin; u.onerror = fin; setTimeout(fin, 20000);
      const go = () => { speaking++; try { speechSynthesis.speak(u); } catch (e) { fin(); } };
      if (o.urgent) { try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } speaking = 0; PA.abort = true; setTimeout(go, 40); } else go();
    });
  }
  let unlocked = false;
  function unlock() { if (unlocked) return; unlocked = true; actx(); if (TTS.ok) { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) { /* ignore */ } } }
  document.addEventListener('pointerdown', unlock, true); document.addEventListener('keydown', unlock, true);

  /* ───────────────────────── flight phase ───────────────────────── */
  const F = { phase: 'PARKED', everAir: false, landed: false, wasAir: false, maxAlt: 0, cruised: 0, descT: 0, vsBuf: [], lastTurb: 0, beltsPrev: null, fired: {}, t: {} };
  function phaseOf(v) {
    const g = onGround(v), gs = gsKt(v), vs = v.verticalSpeed || 0, alt = v.altitude || 0, a = agl(v);
    if (g) { if (F.landed && gs > 30) return 'LANDING ROLL'; if (!F.everAir && gs > 40 && throttle() > .6) return 'TAKEOFF ROLL'; return gs < 2 ? 'PARKED' : 'TAXI'; }
    if (a < 3000 && (gearPos() > .5 || flapIdx() > 1) && vs < 0) return 'APPROACH';
    if (vs > 300) return a < 1500 ? 'INITIAL CLIMB' : 'CLIMB';
    if (vs < -300) return 'DESCENT';
    return alt > 15000 ? 'CRUISE' : (F.everAir ? 'LEVEL' : 'TAXI');
  }

  /* ───────────────────────── callouts ───────────────────────── */
  const CO = { prev: {}, fired: {}, cool: {} };
  function vSpeeds() {
    const f = fmc(), s = S.v; let v1 = s.v1, vr = s.vr, v2 = s.v2;
    if ((!v1 || !vr || !v2) && f) { const gw = f.zfw + f.fuel, r = Math.round(140 + (gw - 250) * .25 + (f.flaps === 5 ? 8 : f.flaps === 20 ? -4 : 0)); v1 = v1 || (f.v1 != null ? f.v1 : r - 6); vr = vr || (f.vr != null ? f.vr : r); v2 = v2 || (f.v2 != null ? f.v2 : r + 7); }
    return { v1, vr, v2 };
  }
  const cool = (k, ms) => { const n = performance.now(); if (CO.cool[k] && n - CO.cool[k] < ms) return false; CO.cool[k] = n; return true; };
  function gearUp() { if (window.GeoFSReal) { GeoFSReal.gear(false); return; } const s = safe(() => (typeof controls.setters.setGear.set === 'function' ? controls.setters.setGear : null), null); if (s) safe(() => s.set()); else ['keydown', 'keyup'].forEach(t => document.body.dispatchEvent(new KeyboardEvent(t, { key: 'g', code: 'KeyG', keyCode: 71, which: 71, bubbles: true }))); }
  function calloutTick() {
    const v = V(), g = onGround(v), kias = v.kias || 0, a = agl(v), vs = v.verticalSpeed || 0, alt = v.altitude || 0, P = CO.prev, gs = gsKt(v), co = S.co;
    const air = !g, p = F.phase;
    const cross = (key, val, lvl, dir) => { const pv = P[key]; return pv != null && (dir === 'dn' ? (pv > lvl && val <= lvl) : (pv < lvl && val >= lvl)); };
    // reset latches when on the ground slowly / new flight segment
    if (g && gs < 20 && !F.landed) ['k80', 'k100', 'v1', 'vr', 'pos'].forEach(k => { CO.fired[k] = false; });
    if (g && gs < 5) { ['r80', 'sbr'].forEach(k => { CO.fired[k] = false; }); }
    if (air && a > 1500) ['1000', '500', 'min', 'amin', '50', '40', '30', '20', '10'].forEach(k => { CO.fired[k] = false; });
    if (air && a > 3000) { CO.fired.sink = false; }
    // takeoff
    if (co.takeoff) {
      const sp = vSpeeds();
      if (g && !F.everAir && throttle() > .6) {
        if (kias >= 100 && !CO.fired.k100) { CO.fired.k100 = true; speak('One hundred knots', { who: 'pm' }); }
        if (kias >= 80 && !CO.fired.k80) { CO.fired.k80 = true; speak('Eighty knots', { who: 'pm' }); }
        if (sp.v1 && kias >= sp.v1 - S.lead && kias > 100 && !CO.fired.v1) { CO.fired.v1 = true; speak('V one', { who: 'pm', urgent: true }); }
        if (sp.vr && kias >= sp.vr - S.lead && kias > 100 && !CO.fired.vr) { CO.fired.vr = true; speak('Rotate', { who: 'pm', urgent: true }); }
      }
      if (air && CO.fired.vr && vs > 200 && a > 5 && a < 800 && !CO.fired.pos) { CO.fired.pos = true; speak('Positive rate', { who: 'pm', urgent: true }).then(() => { if (S.autoGear) { speak('Gear up', { who: 'pf' }); gearUp(); } else speak('Gear up', { who: 'pf' }); }); }
    }
    // altitude
    if (co.alt && air) {
      if (cross('alt', alt, S.ta, 'up') && vs > 0) speak('Transition altitude, set standard', { who: 'pm' });
      if (cross('alt', alt, S.ta, 'dn') && vs < 0) speak('Transition level, set Q N H', { who: 'pm' });
      if (cross('alt', alt, 10000, vs > 0 ? 'up' : 'dn')) { SND.alt10k(); if (cool('t10', 20000)) speak('Passing ten thousand', { who: 'pm' }); }
    }
    // approach
    if (co.appr && air && vs < -100 && (gearPos() > .5 || flapIdx() > 0)) {
      if (cross('agl', a, 1000, 'dn')) speak('One thousand', { who: 'pm' });
      if (cross('agl', a, 500, 'dn')) speak('Five hundred', { who: 'pm' });
      if (S.min > 0) {
        if (cross('agl', a, S.min + 100, 'dn')) speak('Approaching minimums', { who: 'pm' });
        if (cross('agl', a, S.min, 'dn')) speak('Minimums', { who: 'pm', urgent: true });
      }
      [50, 40, 30, 20, 10].forEach(h => { if (cross('agl', a, h, 'dn')) speak(String(h), { who: 'pm', urgent: true, rate: 1.1 }); });
    }
    // rollout
    if (co.roll && g && F.landed) {
      if (sbPos() > .5 && !CO.fired.sbr) { CO.fired.sbr = true; speak('Speedbrake up', { who: 'pm' }); }
      if (kias <= 80 && P.kias > 80 && !CO.fired.r80) { CO.fired.r80 = true; speak('Eighty knots', { who: 'pm' }); }
    }
    // GPWS-style
    if (co.gpws && air) {
      if (a > 50 && a < 2500 && vs < (a < 1000 ? -1800 : -2400) && cool('sink', 4500)) speak('Sink rate', { who: 'pm', gpws: true, urgent: true });
      if (a > 50 && a < 1500 && vs < -3500 && cool('pull', 3000)) speak('Pull up', { who: 'pm', gpws: true, urgent: true });
      if (gearPos() < .3 && a > 50 && a < 500 && kias < 230 && vs < 0 && flapIdx() > 0 && cool('lowgear', 6000)) speak('Too low, gear', { who: 'pm', gpws: true, urgent: true });
      if (kias > 335 && cool('ovs', 5000)) speak('Overspeed', { who: 'pm', gpws: true, urgent: true });
      if (Math.abs(safe(() => geofs.animation.values.aroll, 0) || 0) > 38 && a > 100 && cool('bank', 5000)) speak('Bank angle', { who: 'pm', gpws: true, urgent: true });
    }
    P.kias = kias; P.agl = a; P.alt = alt; P.vs = vs; if (air) P.a = a; CO.prev = P; P.agl = a;
  }

  /* ───────────────────────── checklist (challenge / response) ───────────────────────── */
  const eq = (a, b) => (a === undefined ? undefined : a === b);
  const allOn = ks => { const v = ks.map(sw); return v.some(x => x === undefined) ? undefined : v.every(x => x); };
  const LX = () => safe(() => LO().state, null);
  const PUMPS = ['fLF', 'fLA', 'fRF', 'fRA', 'fCL', 'fCR'];
  const CHK = {
    'PREFLIGHT': [['Battery', 'On', () => eq(sw('batt'), 1)], ['Standby power', 'Auto', () => eq(sw('stby'), 1)], ['Fuel pumps', 'On', () => allOn(PUMPS)], ['Hydraulic demand pumps', 'Auto', () => (sw('hydC1') >= 1 && sw('hydC2') >= 1)], ['Fire panel', 'Normal', () => (!sw('fireL') && !sw('fireR') && !sw('fireA'))], ['Parking brake', 'Set', () => parkSet()], ['F M C route', 'Programmed', () => !!(fmc() && fmc().rteActive)], ['Altimeters', 'Set', null]],
    'BEFORE START': [['Flight deck door', 'Closed and locked', null], ['Seat belt sign', 'On', () => eq(sw('belts'), 2)], ['Beacon', 'On', () => eq(sw('beacon'), 1)], ['Fuel pumps', 'On', () => allOn(PUMPS)], ['Takeoff speeds', 'Set', () => !!vSpeeds().v1], ['Parking brake', 'Set', () => parkSet()]],
    'AFTER START': [['Engines', 'Running', () => engRun()], ['Generators', 'On', () => allOn(['genL', 'genR'])], ['Packs', 'On', () => allOn(['packL', 'packR'])], ['Anti ice', 'As required', null], ['Ground equipment', 'Clear', null]],
    'BEFORE TAXI': [['Flaps', 'Set for takeoff', () => flapIdx() > 0], ['Autobrake', 'R T O', () => eq(sw('abrk'), 0)], ['Taxi light', 'On', () => eq(sw('taxi'), 1)], ['Parking brake', 'Released', () => !parkSet()], ['Flight controls', 'Checked', null]],
    'BEFORE TAKEOFF': [['Landing lights', 'On', () => allOn(['ldgL', 'ldgR', 'nose'])], ['Strobes', 'On', () => eq(sw('strobe'), 2)], ['Transponder', 'T A R A', () => { const l = LX(); return l ? l.xp.mode === 4 : undefined; }], ['Speedbrake', 'Armed', () => { const l = LX(); return l ? !!l.sbArm : undefined; }], ['Flaps', 'Set', () => flapIdx() > 0], ['Takeoff briefing', 'Complete', null]],
    'AFTER TAKEOFF': [['Landing gear', 'Up', () => gearPos() < .03], ['Flaps', 'Up', () => flapIdx() === 0], ['Autopilot', 'Engaged', () => apOn()], ['Altimeters', 'Standard', () => { const l = LX(); return l ? !!l.baro.std : undefined; }]],
    'DESCENT': [['Altimeters', 'Q N H set', () => { const l = LX(); return l ? !l.baro.std : undefined; }], ['Autobrake', 'Set', () => (sw('abrk') >= 2)], ['Seat belt sign', 'On', () => eq(sw('belts'), 2)], ['Landing data', 'Set', null], ['Approach briefing', 'Complete', null]],
    'LANDING': [['Landing gear', 'Down', () => gearPos() > .97], ['Speedbrake', 'Armed', () => { const l = LX(); return l ? !!l.sbArm || sbPos() > .5 : undefined; }], ['Flaps', 'Set for landing', () => flapIdx() > 0], ['Autobrake', 'Set', () => (sw('abrk') >= 2)], ['Landing lights', 'On', () => allOn(['ldgL', 'ldgR', 'nose'])]],
    'SHUTDOWN': [['Parking brake', 'Set', () => parkSet()], ['Fuel control switches', 'Cutoff', () => (sw('fctlL') === 0 && sw('fctlR') === 0)], ['Seat belt sign', 'Off', () => eq(sw('belts'), 0)], ['Beacon', 'Off', () => eq(sw('beacon'), 0)], ['Packs', 'Off', () => (!sw('packL') && !sw('packR'))]],
    'SECURE': [['A P U', 'Off', () => !sw('apu')], ['Fuel pumps', 'Off', () => !PUMPS.some(k => sw(k))], ['Battery', 'Off', () => eq(sw('batt'), 0)]],
  };
  const autoOf = it => { if (!it[2]) return undefined; const src = it[2].toString(); if (/sw\(|allOn\(/.test(src) && !OV()) return undefined; return safe(it[2], undefined); };
  const SUGGEST = { PARKED: () => (engRun() ? 'AFTER START' : F.landed ? 'SHUTDOWN' : (OV() && !safe(() => OV().sim.bus, false) ? 'PREFLIGHT' : 'BEFORE START')), TAXI: () => (flapIdx() > 0 ? 'BEFORE TAKEOFF' : 'BEFORE TAXI'), 'TAKEOFF ROLL': () => null, 'INITIAL CLIMB': () => 'AFTER TAKEOFF', CLIMB: () => 'AFTER TAKEOFF', CRUISE: () => 'DESCENT', DESCENT: () => 'DESCENT', APPROACH: () => 'LANDING', LEVEL: () => null, 'LANDING ROLL': () => null };
  const CL = { tok: 0, name: null, i: -1, state: 'idle', respond: null };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function respond() { if (CL.respond) { const r = CL.respond; CL.respond = null; r('user'); } }
  async function runList(name) {
    const items = CHK[name]; if (!items) return; const tok = ++CL.tok; CL.name = name; CL.i = -1; CL.state = 'running'; drawTab();
    try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    await speak(name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) + ' checklist', { who: 'pm' }); if (tok !== CL.tok) return;
    for (let i = 0; i < items.length; i++) {
      CL.i = i; drawTab(); const it = items[i];
      await speak(it[0], { who: 'pm' }); if (tok !== CL.tok) return;
      const how = await new Promise(res => {
        let told = false, t0 = Date.now(); CL.respond = res; const iv = setInterval(() => {
          if (tok !== CL.tok) { clearInterval(iv); return res('abort'); }
          const a = autoOf(it);
          if (S.autoRespond && a === true && Date.now() - t0 > 900) { clearInterval(iv); CL.respond = null; res('auto'); }
          if (a === false && !told && Date.now() - t0 > 8000) { told = true; speak(it[0] + ', not set', { who: 'pm' }); }
          drawTab();
        }, 300);
        const r0 = res; CL.respond = v => { clearInterval(iv); r0(v); };
      });
      if (tok !== CL.tok || how === 'abort') return;
      if (how === 'auto') await speak(it[1], { who: 'pf' });
      if (how === 'skip') log('PM', it[0] + ' - skipped');
      CL.done = CL.done || {}; (CL.done[name] = CL.done[name] || {})[i] = true;
    }
    CL.state = 'done'; CL.i = items.length; drawTab(); SND.done(); await speak(name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) + ' checklist complete', { who: 'pm' });
  }
  function stopList() { CL.tok++; CL.state = 'idle'; CL.respond = null; CL.i = -1; try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } drawTab(); }
  function skipItem() { if (CL.respond) { const r = CL.respond; CL.respond = null; r('skip'); } }
  // optional voice recognition
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; let rec = null;
  function listen(on) {
    S.listen = on; if (!SR) return;
    if (!on) { if (rec) { rec.onend = null; try { rec.stop(); } catch (e) { /* ignore */ } rec = null; } return; }
    try {
      rec = new SR(); rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
      rec.onresult = e => { const t = Array.from(e.results).slice(e.resultIndex).map(r => r[0].transcript).join(' ').toLowerCase(); if (speaking === 0 && /\b(checked|check|set|on|off|down|up|armed|released|complete|normal|running|auto|closed|standard|cutoff|clear)\b/.test(t)) respond(); };
      rec.onend = () => { if (S.listen) { try { rec.start(); } catch (e) { /* ignore */ } } };
      rec.start();
    } catch (e) { S.listen = false; log('SYS', 'Voice recognition unavailable'); }
  }

  /* ───────────────────────── cabin announcements ───────────────────────── */
  const PA = { q: [], busy: false, abort: false, done: {} };
  const destName = () => S.dest.trim() || '';
  const route = () => { const f = fmc(); if (!f || !f.legs || !f.legs.length) return null; const l = safe(() => geofs.aircraft.instance.llaLocation, null); if (!l) return null; let d = 0, p = { lat: l[0], lon: l[1] }; for (let i = f.active || 0; i < f.legs.length; i++) { const w = f.legs[i], dl = (w.lat - p.lat) * RAD, dn = (w.lon - p.lon) * RAD, x = Math.sin(dl / 2) ** 2 + Math.cos(p.lat * RAD) * Math.cos(w.lat * RAD) * Math.sin(dn / 2) ** 2; d += 2 * 3440.065 * Math.asin(Math.sqrt(x)); p = w; } return d; };
  const EV = [
    { id: 'welcome', label: 'Welcome aboard', when: c => c.g && !F.everAir && c.gs < 2 && (c.beacon || c.run), text: c => ['Ladies and gentlemen, welcome aboard' + (c.flt ? ' flight ' + digits(c.flt) : '') + (c.dest ? ' to ' + c.dest : '') + '. This is your cabin crew speaking. Please make sure your seat belt is fastened, your seat back is upright, and your tray table is stowed. Thank you.'] },
    { id: 'safety', label: 'Safety demonstration', after: 'welcome', delay: 9000, when: c => c.g && !F.everAir && c.gs < 5, text: () => ['Ladies and gentlemen, please direct your attention to the safety demonstration.', 'In the event of a loss of cabin pressure, oxygen masks will drop from above your seat. Pull the mask towards you, place it over your nose and mouth, and breathe normally. Please fasten your own mask before helping others.', 'There are exits at the front, over the wings, and at the rear of the aircraft. Floor path lighting will guide you to the nearest exit. Your life vest is under your seat. Please read the safety card in your seat pocket. Electronic devices must be in flight mode. Thank you.'] },
    { id: 'prepTO', label: 'Cabin crew prepare for takeoff', crit: true, when: c => c.g && !F.everAir && !c.park && c.gs > 3 && c.flaps > 0, text: () => ['Cabin crew, prepare for takeoff.'] },
    { id: 'takeoff', label: 'Cabin crew seats for takeoff', crit: true, when: c => c.g && !F.everAir && c.thr > .85 && c.gs < 40, text: () => ['Cabin crew, take your seats for takeoff.'] },
    { id: 'beltsOff', label: 'Seat belt sign off', when: c => c.air && F.everAir && ((c.beltsChangedOff) || (!OV() && c.alt > 10000)), text: () => ['Ladies and gentlemen, the captain has switched off the seat belt sign. You may now move about the cabin. For your safety, we recommend you keep your seat belt fastened while seated. Thank you.'] },
    { id: 'captain', label: 'Captain cruise announcement', when: c => c.air && c.cruiseSteady, text: c => ['Ladies and gentlemen, this is your captain speaking. We are now cruising at flight level ' + digits(Math.round(c.alt / 100)) + ', at a ground speed of ' + Math.round(c.gs) + ' knots.' + (c.eteMin ? ' We expect to arrive in approximately ' + Math.floor(c.eteMin / 60) + ' hours and ' + (c.eteMin % 60) + ' minutes.' : '') + ' Please enjoy the rest of your flight. Thank you.'] },
    { id: 'descent', label: 'Beginning descent', when: c => c.air && F.cruised > 0 && c.descending && c.alt < F.maxAlt - 2000 && c.alt > 12000, text: c => ['Ladies and gentlemen, we have begun our descent' + (c.dest ? ' into ' + c.dest : '') + '. Please return to your seats and fasten your seat belts. Cabin crew, please prepare the cabin for arrival.'] },
    { id: 'prepLand', label: 'Cabin crew prepare for landing', crit: true, when: c => c.air && F.cruised > 0 && c.descending && c.alt < 10500, text: () => ['Cabin crew, prepare the cabin for landing.'] },
    { id: 'seatsLand', label: 'Cabin crew seats for landing', crit: true, when: c => c.air && F.cruised > 0 && c.agl < 3500 && (c.gear > .5 || c.flaps > 1) && c.descending, text: () => ['Cabin crew, take your seats for landing.'] },
    { id: 'arrival', label: 'Welcome / arrival', when: c => c.g && F.landed && c.gs < 25 && c.run, text: c => ['Ladies and gentlemen, welcome to ' + (c.dest || 'our destination') + '. For your safety, please remain seated with your seat belt fastened until the aircraft has come to a complete stop and the seat belt sign has been switched off. Please take care when opening the overhead lockers. Thank you for flying with us.'] },
    { id: 'doors', label: 'Doors disarm and cross-check', when: c => c.g && F.landed && c.park && !c.run, text: () => ['Cabin crew, disarm doors and cross-check.'] },
    { id: 'turb', label: 'Turbulence announcement', manualOnly: true, text: () => ['Ladies and gentlemen, we are experiencing some turbulence. Please return to your seats and fasten your seat belts. Cabin crew, please be seated.'] },
  ];
  // Singapore Airlines-style wording (my own paraphrase of the typical service tone, not a transcript of real announcements).
  const SIA = {
    welcome: c => ['Ladies and gentlemen, good ' + (new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening') + '. On behalf of Captain and crew, welcome aboard Singapore Airlines' + (c.flt ? ' flight ' + digits(c.flt) : '') + (c.dest ? ' to ' + c.dest : '') + '. Please stow your baggage in the overhead compartments or under the seat in front of you, and keep the aisles clear. Please switch off all electronic devices or set them to flight mode. We wish you a pleasant flight.'],
    safety: (c, l) => ['Ladies and gentlemen, we will now show you the safety features of this aircraft. Please direct your attention to the video screens.'].concat(l.slice(1)),
    beltsOff: () => ['Ladies and gentlemen, the Captain has switched off the seat belt sign. You may move about the cabin, but we recommend that you keep your seat belt fastened whenever you are seated. Thank you.'],
    descent: (c, l) => ['Ladies and gentlemen, we have started our descent' + (c.dest ? ' into ' + c.dest : '') + '. Please return to your seat, fasten your seat belt, stow your tray table and bring your seat to the upright position. Thank you.'],
    arrival: c => ['Ladies and gentlemen, welcome to ' + (c.dest || 'our destination') + '. Please remain seated with your seat belt fastened until the aircraft has come to a complete stop and the seat belt sign has been switched off. Please take care when opening the overhead compartments. On behalf of Singapore Airlines, thank you for flying with us, and we hope to see you again soon.'],
  };
  const evById = Object.fromEntries(EV.map(e => [e.id, e]));
  const sterile = c => (c.g && c.gs > 35) || (c.air && c.alt < 10000 && c.agl < 10000 && F.everAir);
  async function playEv(ev, ctx, force) {
    if (PA.busy) { PA.q.push([ev, ctx, force]); return; }
    PA.busy = true; PA.abort = false; PA.done[ev.id] = 'playing'; drawTab();
    SND.pa(); await sleep(1500);
    let lines = ev.text(ctx || context()); if (S.sia && SIA[ev.id]) lines = SIA[ev.id](ctx || context(), lines);
    for (const ln of lines) { if (PA.abort && !force) break; await speak(ln, { who: 'crew' }); await sleep(500); }
    if (PA.abort && !force) { PA.done[ev.id] = 'retry'; PA.retryAt = Date.now() + 15000; } else PA.done[ev.id] = 'done';
    PA.busy = false; F.t[ev.id + '_d'] = Date.now(); drawTab();
    if (PA.q.length) { const [e, c, f] = PA.q.shift(); playEv(e, c, f); }
  }
  function context() {
    const v = V(), g = onGround(v), vs = v.verticalSpeed || 0, d = route(), f = fmc() || {}, gs = gsKt(v);
    const o = safe(() => OV().sim.eff, null);
    return { g, air: !g, gs, alt: v.altitude || 0, agl: agl(v), vs, run: engRun(), park: parkSet(), thr: throttle(), flaps: flapIdx(), gear: gearPos(),
      beacon: sw('beacon') === 1, descending: F.descT > 20, cruiseSteady: F.cruised > 90, flt: f.flt || '', dest: destName() || '', eteMin: d && gs > 150 ? Math.round(d / gs * 60) : 0, belts: o ? !!o.belts : null };
  }
  function cabinTick(dt) {
    const v = V(), c = context(), now = Date.now();
    // flight-state bookkeeping
    if (c.air && !F.wasAir) { F.everAir = true; F.landed = false; }
    if (c.g && F.wasAir) { F.landed = true; }
    F.wasAir = c.air; F.maxAlt = c.air ? Math.max(F.maxAlt, c.alt) : F.maxAlt;
    F.cruised = (c.air && Math.abs(c.vs) < 400 && c.alt > 20000) ? F.cruised + dt : (c.air && c.alt > 20000 ? F.cruised : (c.g ? 0 : Math.max(0, F.cruised - dt)));
    F.descT = c.air && c.vs < -500 ? F.descT + dt : 0;
    if (c.g && F.landed && c.park && !c.run && !F.reset) F.reset = now + 90000;
    if (F.reset && now > F.reset) newFlight();
    // seat belt sign changes -> chime (+ "sign off" trigger)
    c.beltsChangedOff = false;
    if (c.belts !== null) { if (F.beltsPrev !== null && c.belts !== F.beltsPrev) { (c.belts ? SND.signOn : SND.signOff)(); if (!c.belts) c.beltsChangedOff = true; } F.beltsPrev = c.belts; }
    // turbulence detector (vertical speed variance)
    F.vsBuf.push(c.vs); if (F.vsBuf.length > 24) F.vsBuf.shift();
    if (S.turb && c.air && c.alt > 8000 && F.vsBuf.length === 24 && now - F.lastTurb > 600000) {
      const m = F.vsBuf.reduce((a, b) => a + b, 0) / 24, sd = Math.sqrt(F.vsBuf.reduce((a, b) => a + (b - m) ** 2, 0) / 24);
      if (sd > 550) { F.lastTurb = now; log('SYS', 'Turbulence detected'); playEv(evById.turb, c); if (S.paAuto && true) { const st = safe(() => OV().state, null); if (st) st.sw.belts = 2; } }
    }
    if (!S.paAuto) return;
    EV.forEach(ev => {
      if (ev.manualOnly || PA.done[ev.id] === 'done' || PA.done[ev.id] === 'playing' || PA.busy) return;
      if (PA.done[ev.id] === 'retry' && now < (PA.retryAt || 0)) return;
      if (ev.after) { const t = F.t[ev.after + '_d']; if (PA.done[ev.after] !== 'done' || !t || now - t < ev.delay) return; }
      if (!ev.when(c)) return;
      if (S.sterile && sterile(c) && !ev.crit) return;
      PA.done[ev.id] = 'queued'; F.t[ev.id] = now; playEv(ev, c);
    });
  }
  function newFlight() { Object.keys(PA.done).forEach(k => delete PA.done[k]); Object.assign(F, { everAir: false, landed: false, wasAir: false, maxAlt: 0, cruised: 0, descT: 0, fired: {}, t: {}, reset: 0 }); CO.fired = {}; log('SYS', 'New flight - announcements reset'); drawTab(); }

  /* ───────────────────────── clock ───────────────────────── */
  const CK = { chr: { run: false, acc: 0, t0: 0 }, et: { run: false, acc: 0, t0: 0 } };
  const cval = o => o.acc + (o.run ? (Date.now() - o.t0) / 1000 : 0);
  const cstart = o => { if (!o.run) { o.run = true; o.t0 = Date.now(); } };
  const cstop = o => { if (o.run) { o.acc += (Date.now() - o.t0) / 1000; o.run = false; } };
  const creset = o => { o.run = false; o.acc = 0; };
  let etWasAir = false;
  function clockLogic() {
    if (!S.clock.etAuto) return; const air = !onGround(V());
    if (air && !etWasAir) { creset(CK.et); cstart(CK.et); } if (!air && etWasAir) cstop(CK.et); etWasAir = air;
  }
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  function clockSvg() {
    let s = '<circle cx="100" cy="100" r="98" fill="#111418" stroke="#000" stroke-width="2"/><circle cx="100" cy="100" r="90" fill="#050607" stroke="#2a2f35" stroke-width="2"/>';
    for (let i = 0; i < 60; i++) { const a = i * 6 * RAD, big = i % 5 === 0, r1 = big ? 78 : 84, r2 = 88; s += `<line x1="${100 + r1 * Math.sin(a)}" y1="${100 - r1 * Math.cos(a)}" x2="${100 + r2 * Math.sin(a)}" y2="${100 - r2 * Math.cos(a)}" stroke="#e9eef0" stroke-width="${big ? 3 : 1}"/>`; }
    for (let h = 1; h <= 12; h++) { const a = h * 30 * RAD; s += `<text x="${100 + 64 * Math.sin(a)}" y="${100 - 64 * Math.cos(a) + 6}" fill="#e9eef0" font-size="${h % 3 === 0 ? 19 : 15}" font-weight="700" text-anchor="middle" font-family="system-ui,sans-serif">${h}</text>`; }
    s += '<text x="100" y="62" fill="#8fb4d4" font-size="9" text-anchor="middle" letter-spacing="2" font-family="system-ui">GMT</text>';
    s += '<g id="gfk-h"><line x1="100" y1="106" x2="100" y2="58" stroke="#f1f4f6" stroke-width="6" stroke-linecap="round"/><line x1="100" y1="92" x2="100" y2="68" stroke="#9fffc0" stroke-width="2.5"/></g>';
    s += '<g id="gfk-m"><line x1="100" y1="110" x2="100" y2="26" stroke="#f1f4f6" stroke-width="4" stroke-linecap="round"/><line x1="100" y1="96" x2="100" y2="40" stroke="#9fffc0" stroke-width="1.6"/></g>';
    s += '<g id="gfk-s"><line x1="100" y1="118" x2="100" y2="16" stroke="#ffd24a" stroke-width="1.6"/></g>';
    s += '<g id="gfk-c"><line x1="100" y1="116" x2="100" y2="14" stroke="#ff4a3d" stroke-width="2.2"/><circle cx="100" cy="100" r="4" fill="#ff4a3d"/></g><circle cx="100" cy="100" r="3" fill="#050607"/>';
    return `<svg viewBox="0 0 200 200" width="100%" role="img" aria-label="Analog clock">${s}</svg>`;
  }
  function clockDraw() {
    const root = $('#gfk-root'); if (!root || !S.clock.open) return;
    const d = new Date(), utc = S.clock.utc, H = utc ? d.getUTCHours() : d.getHours(), M = utc ? d.getUTCMinutes() : d.getMinutes(), Sx = (utc ? d.getUTCSeconds() : d.getSeconds()) + d.getMilliseconds() / 1000;
    const rot = (id, a) => { const el = $('#' + id, root); if (el) el.setAttribute('transform', `rotate(${a} 100 100)`); };
    rot('gfk-h', ((H % 12) + M / 60) * 30); rot('gfk-m', (M + Sx / 60) * 6); rot('gfk-s', Sx * 6);
    const ch = cval(CK.chr); rot('gfk-c', (ch % 60) * 6);
    const set = (id, t) => { const el = $('#' + id, root); if (el && el.textContent !== t) el.textContent = t; };
    set('gfk-time', pad(H) + ':' + pad(M) + ':' + pad(Math.floor(Sx))); set('gfk-zone', utc ? 'GMT' : 'LCL');
    set('gfk-date', pad(utc ? d.getUTCDate() : d.getDate()) + ' ' + MON[utc ? d.getUTCMonth() : d.getMonth()] + ' ' + String(utc ? d.getUTCFullYear() : d.getFullYear()).slice(2));
    const et = cval(CK.et); set('gfk-et', pad(Math.floor(et / 3600)) + ':' + pad(Math.floor(et / 60) % 60) + ':' + pad(Math.floor(et % 60)));
    set('gfk-chr', pad(Math.floor(ch / 60) % 100) + ':' + pad(Math.floor(ch % 60)) + '.' + Math.floor((ch % 1) * 10));
    $('[data-k=chr]', root).classList.toggle('on', CK.chr.run); $('[data-k=et]', root).classList.toggle('on', CK.et.run); $('[data-k=auto]', root).classList.toggle('on', S.clock.etAuto);
  }

  /* ───────────────────────── UI ───────────────────────── */
  const CSS = `
  #gfv-root,#gfv-root *,#gfk-root,#gfk-root *{box-sizing:border-box}
  .gfw{position:fixed;font:600 11px system-ui,"Segoe UI",sans-serif;color:#dde4ea;background:#1d2125;border:2px solid #000;border-radius:10px;box-shadow:0 10px 36px #000c;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;display:none;overflow:hidden}
  .gfw.open{display:block}#gfv-root{z-index:99987;width:min(480px,98vw)}#gfk-root{z-index:99986;width:230px;background:#15181c}
  .gfb{display:flex;align-items:center;gap:6px;padding:5px 8px;background:linear-gradient(#3a3f44,#2a2e32);cursor:grab;touch-action:none;letter-spacing:.12em;font-size:10px}.gfb b{flex:1;color:#f1f4f6}
  .gfw button{all:unset;cursor:pointer;padding:6px 10px;border-radius:5px;background:#3b4046;border:1px solid #0d0f11;font-size:10px;letter-spacing:.05em;color:#dfe5e9;text-align:center;box-sizing:border-box}
  .gfw button:active{transform:translateY(1px)}.gfw button.on{background:#1f3b57;color:#fff}.gfw button.go{background:#1d4d2e;color:#bfffd2}.gfw button.stop{background:#5a2420;color:#ffd0ca}
  .gfw button:focus-visible{outline:2px solid #7cc4ff;outline-offset:1px}
  .gft{display:flex;gap:4px;padding:5px 8px;background:#14181c;flex-wrap:wrap}.gfbody{padding:10px;max-height:62vh;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
  .gfph{display:flex;gap:10px;align-items:center;padding:6px 10px;background:#0f1317;border-bottom:1px solid #000;font-size:10px;letter-spacing:.1em}.gfph b{color:#6dff9b}
  .gflog{height:84px;overflow:auto;padding:6px 10px;background:#07140c;border-top:1px solid #000;font:600 11px Consolas,monospace;color:#6dff9b;-webkit-user-select:text;user-select:text}.gflog div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gflog .w{color:#8fb4d4}.gflog .g{color:#ffbf47}.gflog .p{color:#ff9af6}
  .gfrow{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;align-items:center}.gfrow label{display:flex;gap:6px;align-items:center;font-size:11px;color:#c8d3db}
  .gfw h3{margin:12px 0 4px;font-size:10px;letter-spacing:.14em;color:#8fb4d4}.note{margin-top:8px;font-size:10px;color:#7d8c98;line-height:1.35}
  .gfw input[type=text],.gfw input[type=number],.gfw select{all:unset;box-sizing:border-box;background:#080b0e;border:1px solid #2a333b;border-radius:6px;padding:7px 9px;color:#ffd470;font:600 12px Consolas,monospace;-webkit-user-select:text;user-select:text;max-width:100%}
  .gfw select{cursor:pointer;color:#e6ecf0;font-family:inherit}.gfw input:focus,.gfw select:focus{outline:2px solid #7cc4ff}.gfw input[type=range]{width:120px;accent-color:#e6b84a}.gfw input[type=checkbox]{width:18px;height:18px;accent-color:#6dff9b}
  ul.cl{list-style:none;margin:6px 0;padding:0}ul.cl li{display:flex;align-items:center;gap:8px;padding:9px 6px;border-bottom:1px solid #20282f;min-height:40px}ul.cl li .bx{width:18px;height:18px;border:2px solid #52626f;border-radius:4px;color:#6dff9b;display:flex;align-items:center;justify-content:center;font-weight:900;flex:0 0 18px}
  ul.cl li.cur{background:#1f3b57}ul.cl li.ok .t{color:#7d8c98}ul.cl li .r{margin-left:auto;color:#6dff9b}.dot{width:10px;height:10px;border-radius:50%;flex:0 0 10px}.dot.g{background:#3dff7a;box-shadow:0 0 6px #3dff7a}.dot.a{background:#ffbf47;box-shadow:0 0 6px #ffbf47}
  .evl{list-style:none;margin:6px 0;padding:0}.evl li{display:flex;gap:8px;align-items:center;padding:7px 4px;border-bottom:1px solid #20282f}.evl li span{flex:1}.evl .st{flex:0 0 58px;font-size:9px;letter-spacing:.08em;color:#7d8c98}.evl .st.done{color:#6dff9b}.evl .st.retry{color:#ffbf47}
  .gfk-lcd{margin:0 10px 8px;padding:6px 10px;background:#07140c;border:1px solid #000;border-radius:5px;font:700 13px Consolas,monospace;color:#6dff9b;box-shadow:inset 0 1px 4px #000}.gfk-lcd div{display:flex;justify-content:space-between;align-items:baseline}.gfk-lcd .big{font-size:24px;letter-spacing:.06em}.gfk-lcd small{font-size:9px;color:#4a8d63;letter-spacing:.1em}
  .gfk-bt{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;padding:0 10px 10px}
  .gfedge{all:unset;position:fixed;left:0;z-index:99985;width:34px;height:84px;cursor:pointer;background:linear-gradient(#3a3f44,#2a2e32);border:1px solid #0d0f11;border-left:none;border-radius:0 9px 9px 0;color:#cfd6db;font:700 10px system-ui;letter-spacing:.16em;writing-mode:vertical-rl;text-align:center;line-height:34px;box-shadow:0 0 8px #0008}
  .gfedge:focus-visible{outline:2px solid #7cc4ff}
  @media (pointer:coarse),(hover:none){.gfw button{padding:12px 13px;font-size:11px}.gfw input[type=text],.gfw input[type=number],.gfw select{font-size:16px;padding:10px 11px}.gfw input[type=checkbox]{width:24px;height:24px}.gfedge{width:42px;height:96px;line-height:42px}ul.cl li{min-height:48px}#gfk-root{width:250px}}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
  `;
  const TABS = ['CHK', 'CABIN', 'CALLS', 'VOICE'];
  let root = null, kroot = null;
  function drag(bar, widget, pos, after) {
    let d = null;
    bar.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; d = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }; bar.setPointerCapture(e.pointerId); bar.style.cursor = 'grabbing'; e.stopPropagation(); });
    bar.addEventListener('pointermove', e => { if (!d) return; pos.x = clamp(e.clientX - d.dx, -widget.offsetWidth + 100, innerWidth - 100); pos.y = clamp(e.clientY - d.dy, 0, innerHeight - 50); widget.style.left = pos.x + 'px'; widget.style.top = pos.y + 'px'; });
    const end = () => { if (d) { d = null; bar.style.cursor = 'grab'; save(); } }; bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
  }
  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'gfv-root'; root.className = 'gfw';
    root.innerHTML = `<div class="gfb" id="gfv-bar"><b>CREW VOICE · CABIN <small style="opacity:.6">v${VERSION}</small></b><button data-a="clock">CLOCK</button><button data-a="close">HIDE</button></div>
      <div class="gfph"><span>PHASE <b id="gfv-ph">PARKED</b></span><span id="gfv-sug"></span><span style="margin-left:auto">${TTS.ok ? 'TTS OK' : 'NO TTS'}</span></div>
      <div class="gft">${TABS.map(t => `<button data-t="${t}">${t === 'CHK' ? 'CHECKLISTS' : t === 'CALLS' ? 'CALLOUTS' : t}</button>`).join('')}</div>
      <div class="gfbody" id="gfv-body"></div><div class="gflog" id="gfv-log" aria-live="polite"></div>`;
    document.body.appendChild(root);
    kroot = document.createElement('div'); kroot.id = 'gfk-root'; kroot.className = 'gfw';
    kroot.innerHTML = `<div class="gfb" id="gfk-bar"><b>CLOCK</b><button data-k="zone">GMT/LCL</button><button data-k="x">✕</button></div>${clockSvg()}
      <div class="gfk-lcd"><div><small id="gfk-zone">GMT</small><span class="big" id="gfk-time">--:--:--</span></div><div><small>DATE</small><span id="gfk-date">--</span></div><div><small>ET</small><span id="gfk-et">00:00:00</span></div><div><small>CHR</small><span id="gfk-chr">00:00.0</span></div></div>
      <div class="gfk-bt"><button data-k="chr">CHR</button><button data-k="chrr">CHR RST</button><button data-k="auto">ET AUTO</button><button data-k="et">ET RUN</button><button data-k="etr">ET RST</button><span></span></div>`;
    document.body.appendChild(kroot);
    [['Crew', 'VOICE', 'v'], ['Clock', 'CLOCK', 'k']].forEach(([n, t, k], i) => { const b = document.createElement('button'); b.className = 'gfedge'; b.textContent = t; b.style.bottom = (210 + i * 96) + 'px'; b.setAttribute('aria-label', 'Toggle ' + n); b.addEventListener('click', () => (k === 'v' ? togglePanel() : toggleClock())); document.body.appendChild(b); });
    [root, kroot].forEach(w => ['pointerdown', 'mousedown', 'touchstart', 'touchmove'].forEach(ev => w.addEventListener(ev, e => { if (!e.target.closest('.gfb')) e.stopPropagation(); }, { passive: true })));
    [root, kroot].forEach(w => w.addEventListener('keydown', e => { if (e.target.matches('input,select')) e.stopPropagation(); }, true));
    root.addEventListener('keyup', e => { if (e.target.matches('input,select')) e.stopPropagation(); }, true);
    root.addEventListener('click', onClick); root.addEventListener('change', onChange); root.addEventListener('input', e => { if (e.target.type === 'range') onChange(e); });
    kroot.addEventListener('click', e => {
      const b = e.target.closest('[data-k]'); if (!b) return; const k = b.dataset.k;
      if (k === 'x') toggleClock(false); if (k === 'zone') S.clock.utc = !S.clock.utc;
      if (k === 'chr') (CK.chr.run ? cstop : cstart)(CK.chr); if (k === 'chrr') creset(CK.chr);
      if (k === 'et') (CK.et.run ? cstop : cstart)(CK.et); if (k === 'etr') creset(CK.et); if (k === 'auto') S.clock.etAuto = !S.clock.etAuto;
      save(); clockDraw();
    });
    drag($('#gfv-bar'), root, S, save); drag($('#gfk-bar'), kroot, S.clock, save);
    place(); applyOpen(); drawTab(); drawLog();
  }
  function place() { root.style.left = clamp(S.x, -200, innerWidth - 100) + 'px'; root.style.top = clamp(S.y, 0, innerHeight - 60) + 'px'; kroot.style.left = clamp(S.clock.x, 0, innerWidth - 100) + 'px'; kroot.style.top = clamp(S.clock.y, 0, innerHeight - 60) + 'px'; }
  function applyOpen() { root.classList.toggle('open', S.open); kroot.classList.toggle('open', S.clock.open); if (S.open) drawTab(); }
  function togglePanel(f) { S.open = typeof f === 'boolean' ? f : !S.open; save(); applyOpen(); unlock(); }
  function toggleClock(f) { S.clock.open = typeof f === 'boolean' ? f : !S.clock.open; save(); applyOpen(); clockDraw(); unlock(); }
  function drawLog() {
    const el = $('#gfv-log'); if (!el) return;
    el.innerHTML = logLines.slice(0, 12).map(l => `<div class="${l.who === 'PA' ? 'p' : l.who === 'GPWS' ? 'g' : l.who === 'SYS' ? 'w' : ''}">${pad(new Date(l.t).getUTCHours())}${pad(new Date(l.t).getUTCMinutes())}Z [${l.who}] ${esc(l.text)}</div>`).join('') || '<div class="w">Speech log — nothing yet. Tap anywhere once to unlock audio.</div>';
  }
  const sel = (path, opts, cur) => `<select data-s="${path}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const chk = (path, label) => `<label><input type="checkbox" data-s="${path}"${getp(S, path) ? ' checked' : ''}> ${label}</label>`;
  const rng = (path, label, min, max, step) => `<label>${label} <input type="range" data-s="${path}" min="${min}" max="${max}" step="${step}" value="${getp(S, path)}"></label>`;
  const numf = (path, label, w) => `<label>${label} <input type="number" data-s="${path}" value="${getp(S, path)}" style="width:${w || 80}px" inputmode="numeric"></label>`;
  function drawTab() {
    if (!root || !S.open) return; const body = $('#gfv-body'); if (!body) return;
    $$('.gft button', root).forEach(b => b.classList.toggle('on', b.dataset.t === S.tab));
    if (document.activeElement && body.contains(document.activeElement) && document.activeElement.matches('input[type=text],input[type=number]')) return; // don't clobber typing
    let h = '';
    if (S.tab === 'CHK') {
      const names = Object.keys(CHK), items = CL.name ? CHK[CL.name] : null, sug = (SUGGEST[F.phase] || (() => null))();
      h += `<div class="gfrow">${names.map(n => `<button data-l="${n}" class="${CL.name === n && CL.state !== 'idle' ? 'on' : ''}${sug === n ? ' go' : ''}">${n}</button>`).join('')}</div>`;
      if (items) {
        h += `<h3>${esc(CL.name)} — ${CL.state === 'done' ? 'COMPLETE' : CL.state === 'running' ? 'RUNNING' : 'STOPPED'}</h3><ul class="cl">${items.map((it, i) => { const a = autoOf(it), done = (CL.done && CL.done[CL.name] && CL.done[CL.name][i]); return `<li class="${i === CL.i ? 'cur' : ''}${done ? ' ok' : ''}"><span class="bx">${done ? '✓' : ''}</span><span class="t">${esc(it[0].replace(/\b([A-Z]) (?=[A-Z]\b)/g, '$1'))}</span><span class="r">${esc(it[1])}</span><span class="dot ${a === true ? 'g' : a === false ? 'a' : ''}"></span></li>`; }).join('')}</ul>`;
        h += `<div class="gfrow"><button class="go" data-a="respond">RESPOND ✓ (Alt+Y)</button><button data-a="skip">SKIP ITEM</button><button class="stop" data-a="stop">STOP</button></div>`;
      } else h += `<p class="note">Tap a checklist: the pilot monitoring reads each challenge aloud and waits for your response. ${sug ? 'Suggested for this phase: <b>' + esc(sug) + '</b> (green).' : ''}</p>`;
      h += `<div class="gfrow">${chk('autoRespond', 'Crew responds automatically when the system matches')}${SR ? chk('listen', 'Listen for “checked / set” (experimental)') : ''}</div><p class="note">● green = matches the Overhead/Lower panel · ● amber = doesn't · none = manual. Generic sim checklists, not Boeing FCOM.</p>`;
    } else if (S.tab === 'CABIN') {
      h += `<div class="gfrow">${chk('paAuto', 'Automatic announcements')}${chk('sterile', 'Sterile cockpit (hold non-critical PAs below 10,000 ft / during roll)')}${chk('turb', 'Turbulence detection')}</div>
        <div class="gfrow"><label>DESTINATION NAME <input type="text" data-s="dest" value="${esc(S.dest)}" placeholder="e.g. Singapore" style="width:170px" autocapitalize="words"></label><button data-a="newflight">NEW FLIGHT</button></div>
        <ul class="evl">${EV.map(ev => { const st = PA.done[ev.id] || 'pending'; return `<li><span>${esc(ev.label)}${ev.crit ? ' <small style="color:#ffbf47">crit</small>' : ''}</span><span class="st ${st}">${st.toUpperCase()}</span><button data-ev="${ev.id}">PLAY</button></li>`; }).join('')}</ul>
        <p class="note">Generic announcements. Chimes: two-tone PA, single seat-belt chime when the Overhead panel's sign changes. Set the destination name so PAs can say it (ICAO codes aren't spoken).</p>`;
    } else if (S.tab === 'CALLS') {
      const sp = vSpeeds();
      h += `<div class="gfrow">${chk('co.takeoff', 'Takeoff (80 kt, 100 kt, V1, rotate, positive rate)')}${chk('co.alt', 'Altitude (TA/TL, 10,000)')}${chk('co.appr', 'Approach (1000, 500, minimums, 50-10)')}${chk('co.roll', 'Rollout (speedbrake, 80 kt)')}${chk('co.gpws', 'GPWS-style alerts (sim only)')}${chk('autoGear', 'Raise gear automatically after “positive rate”')}</div>
        <h3>SPEEDS (0 = AUTO FROM CDU)</h3><div class="gfrow">${numf('v.v1', 'V1')}${numf('v.vr', 'VR')}${numf('v.v2', 'V2')}${numf('lead', 'LEAD kt', 60)}</div><p class="note">Currently using V1 ${sp.v1 || '—'} · VR ${sp.vr || '—'} · V2 ${sp.v2 || '—'} (CDU values are approximate).</p>
        <h3>LIMITS</h3><div class="gfrow">${numf('min', 'MINIMUMS ft AGL (0=off)', 80)}${numf('ta', 'TRANSITION ALT ft', 90)}</div>
        <div class="gfrow"><button data-a="test-v1">TEST “V ONE”</button><button data-a="test-gp">TEST “SINK RATE”</button></div>`;
    } else {
      const vs = TTS.voices, opts = [['', 'Auto']].concat(vs.map(v => [v.voiceURI, v.name + ' (' + v.lang + ')']));
      h += `<div class="gfrow">${chk('voiceOn', 'Voice on')}${chk('sound', 'Sound pack (chimes)')}${chk('amb', 'Cabin ambience (engine-linked)')}${chk('sia', 'Singapore Airlines style (chimes + wording)')}</div>
        <div class="gfrow"><label>PILOT MONITORING ${sel('pm', opts, S.pm)}</label></div><div class="gfrow"><label>CABIN CREW ${sel('crew', opts, S.crew)}</label></div>
        <div class="gfrow">${rng('rate', 'SPEED', .7, 1.5, .05)}${rng('vol.call', 'CALLOUT VOL', 0, 1, .05)}${rng('vol.pa', 'PA VOL', 0, 1, .05)}${rng('vol.snd', 'CHIME VOL', 0, 1, .05)}${rng('ambVol', 'AMBIENCE', 0, 1, .05)}</div>
        <div class="gfrow"><button data-a="test-pa">TEST PA CHIME</button><button data-a="test-sign">TEST SIGN CHIME</button><button data-a="test-call">TEST CALL CHIME</button><button data-a="test-voice">TEST VOICE</button></div>
        <details><summary style="cursor:pointer;padding:6px 0">REAL SOUNDS — your own audio files (URL or data: link)</summary>${['pa', 'signOn', 'signOff', 'call', 'interphone', 'alt10k', 'done'].map(k => `<div class="gfrow"><label>${k.toUpperCase()} <input type="text" data-s="custom.${k}" value="${esc(S.custom[k] || '')}" placeholder="https://…/chime.mp3" style="width:230px" autocapitalize="off" autocorrect="off"></label></div>`).join('')}<p class="note">Leave blank for the built-in synthesised sound. The host must allow cross-origin audio (e.g. GitHub raw, your own server).</p></details>
        <p class="note">${TTS.ok ? vs.length + ' voices found.' : 'Speech synthesis is not available in this browser — text is shown in the log only.'} iPad: voices come from Settings ▸ Accessibility ▸ Spoken Content; sound may be muted by the silent switch.</p>`;
    }
    body.innerHTML = h;
  }
  function onClick(e) {
    const t = e.target, b = t.closest('button'); if (!b) return;
    if (b.dataset.t) { S.tab = b.dataset.t; save(); return drawTab(); }
    if (b.dataset.l) return runList(b.dataset.l);
    if (b.dataset.ev) { const ev = evById[b.dataset.ev]; PA.done[ev.id] = undefined; return playEv(ev, context(), true); }
    switch (b.dataset.a) {
      case 'close': return togglePanel(false); case 'clock': return toggleClock();
      case 'respond': return respond(); case 'skip': return skipItem(); case 'stop': return stopList();
      case 'newflight': return newFlight();
      case 'test-v1': return speak('V one', { who: 'pm', urgent: true }); case 'test-gp': return speak('Sink rate', { who: 'pm', gpws: true, urgent: true });
      case 'test-pa': return SND.pa(); case 'test-sign': return SND.signOn(); case 'test-call': return SND.call();
      case 'test-voice': return speak('Cabin crew, prepare for takeoff.', { who: 'crew' }).then(() => speak('Eighty knots', { who: 'pm' }));
    }
  }
  function onChange(e) {
    const el = e.target.closest('[data-s]'); if (!el) return; const p = el.dataset.s;
    let v = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? parseFloat(el.value) : el.value; if ((el.type === 'number' || el.type === 'range') && !isFinite(v)) return;
    setp(S, p, v); save();
    if (p === 'listen') listen(v); if (p === 'amb' && v) { unlock(); actx(); }
  }

  document.addEventListener('keydown', e => {
    if (!e.altKey) return;
    if (e.code === 'KeyV') { e.preventDefault(); togglePanel(); } else if (e.code === 'KeyK') { e.preventDefault(); toggleClock(); } else if (e.code === 'KeyY') { e.preventDefault(); respond(); }
  }, true);

  /* ───────────────────────── main loop ───────────────────────── */
  let lastCab = Date.now();
  function boot() {
    if (!document.body) return setTimeout(boot, 200);
    build();
    setInterval(() => { const v = V(); F.phase = phaseOf(v); try { calloutTick(); } catch (e) { /* ignore */ } }, 100);
    setInterval(() => { const n = Date.now(), dt = (n - lastCab) / 1000; lastCab = n; try { cabinTick(dt); } catch (e) { /* ignore */ } clockLogic(); ambience(); if (S.open) { const ph = $('#gfv-ph'); if (ph) ph.textContent = F.phase; const sg = $('#gfv-sug'); if (sg) { const s = (SUGGEST[F.phase] || (() => null))(); sg.textContent = s ? 'SUGGEST: ' + s : ''; } if (S.tab === 'CHK' || S.tab === 'CABIN') drawTab(); } }, 500);
    setInterval(clockDraw, 100);
    window.GeoFSCrew = { version: VERSION, ownsSignChime: true, open: () => togglePanel(true), close: () => togglePanel(false), clock: toggleClock, speak, runList, stopList, respond, newFlight, state: S, flight: F };
    console.log('[GeoFS Crew] loaded. Alt+V crew panel, Alt+K clock, Alt+Y respond.');
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
GeoFSDock.add(() => [...document.querySelectorAll('button.gfedge')].find(b => b.textContent === 'VOICE'), 6); GeoFSDock.add(() => [...document.querySelectorAll('button.gfedge')].find(b => b.textContent === 'CLOCK'), 7);
