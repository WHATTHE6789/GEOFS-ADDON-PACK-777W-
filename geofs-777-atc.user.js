// ==UserScript==
// @name         GeoFS 777-300ER ATC Controller (IFR/VFR, VHF, CPDLC on the CDU, TCAS, gate spawner)
// @namespace    https://github.com/geofs-overhead
// @version      2.0.0
// @description  A phase-by-phase simulated ATC: ATIS, clearance, ground (taxi routes from OpenStreetMap), tower with line-up/take-off/landing and go-arounds, departure/centre/approach with vectors, speed and altitude monitoring, VHF tuning (uses the pedestal radios), squawk handling (VFR 1200/7000, 7700/7600), CPDLC messages on the CDU, TCAS from GeoFS multiplayer traffic, emergencies, and a gate spawner. Install AFTER the Nav Data, Lower Panel and Overhead scripts.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * INSTALL: after geofs-777-navatc.user.js (v1.1+), geofs-777-lower-panel.user.js and geofs-777-overhead.user.js. Reload GeoFS.
 * USE:     Alt+T or the ATC tab (top-left stack). Set ORIGIN / DEST / FLT NO / CRZ ALT on the CDU first. Tune the pedestal VHF radio
 *          (MIC on that radio) to the frequency shown in the ATC panel - or tap TUNE. CDU: press the ATC key for CPDLC.
 *
 * WHAT IS REAL AND WHAT IS SIMULATED  (please read)
 *   REAL DATA   Airports, runways and frequencies (OurAirports), METAR (aviationweather.gov), taxiway names and gate positions
 *               (OpenStreetMap), and your own aircraft's telemetry from GeoFS.
 *   SIMULATED   The controllers are a scripted state machine with browser text-to-speech. They do not see real airspace, sectors,
 *               NOTAMs or other traffic (other than multiplayer aircraft used by TCAS). En-route "Control" frequencies are made up
 *               (marked SIM). Taxi routes name the taxiways nearest to you and to the runway - they are NOT checked for connectivity.
 *               The CPDLC link is simulated, not a real datalink. TCAS is a simplified tau model, not certified logic.
 *   GEOFS API   Several GeoFS internals vary by version (multiplayer user objects, teleport). Each has fallbacks; PROBE buttons
 *               report what was found. NOT FOR REAL-WORLD USE.
 */
(function () {
  'use strict';
  if (window.GeoFSATC) return;
  const VERSION = '2.0.0', STORE = 'geofsATC.v2';

  /* ═══════════════ helpers ═══════════════ */
  const safe = (f, d) => { try { const r = f(); return r === undefined ? d : r; } catch (e) { return d; } };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const RAD = Math.PI / 180, now = () => Date.now();
  const V = () => safe(() => geofs.animation.values, {}) || {};
  const inst = () => safe(() => geofs.aircraft.instance, null);
  const LO = () => safe(() => window.GeoFSLower, null), OV = () => safe(() => window.GeoFSOverhead, null), NAV = () => safe(() => window.GeoFSNavATC, null);
  const F = () => safe(() => LO().fmc, {}) || {};
  const gcd = (a, b) => { const dl = (b.lat - a.lat) * RAD, dn = (b.lon - a.lon) * RAD, x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dn / 2) ** 2; return 2 * 3440.065 * Math.asin(Math.sqrt(x)); };
  const brg = (a, b) => { const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD), x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD); return (Math.atan2(y, x) / RAD + 360) % 360; };
  const dest = (p, b, nm) => { const d = nm / 3440.065, t = b * RAD, la = p.lat * RAD, lo = p.lon * RAD, la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(t)), lo2 = lo + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2)); return { lat: la2 / RAD, lon: ((lo2 / RAD + 540) % 360) - 180 }; };
  const angd = (a, b) => ((a - b + 540) % 360) - 180;
  const getp = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const setp = (o, p, v) => { const ks = p.split('.'), l = ks.pop(); ks.reduce((a, k) => a[k], o)[l] = v; };
  const num = (o, k) => { const v = safe(() => o[k], undefined); return typeof v === 'number' ? v : undefined; };
  const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

  /* ═══════════════ settings ═══════════════ */
  const DEF = () => ({ open: false, x: 120, y: 52, tab: 'COMMS', callsign: '', voiceOn: true, rate: 1, vol: 1, auto: false, readback: true, radioFx: true, needTune: true, lineup: true, cpdlc: true, autoAP: false, followXp: true, vfrCodes: '1200,7000', autoSq: true, tcas: true, tcasAlerts: true, souls: '250', fuelH: '4', fuelM: '30', listen: false, gateHdg: '', gateFilter: '', tcasRange: 10, spawnAlt: 0, manualRb: false, firHF: {}, selcal: '', firFreq: {}, needCs: true, min: false });
  const S = DEF();
  try { const o = JSON.parse(localStorage.getItem(STORE) || 'null'); if (o) Object.keys(S).forEach(k => { if (o[k] !== undefined) S[k] = o[k]; }); } catch (e) { /* ignore */ }
  S.open = false;
  let saveT = 0; const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } }, 400); };
  const autoRb = () => S.readback && !S.manualRb;
  const LOGS = []; const log = (who, text) => { LOGS.unshift({ who, text, t: now() }); if (LOGS.length > 80) LOGS.pop(); drawLog(); };

  /* ═══════════════ telemetry ═══════════════ */
  const pos = () => { const l = safe(() => inst().llaLocation, null) || safe(() => geofs.camera.lla, null); return l && isFinite(l[0]) && isFinite(l[1]) ? { lat: l[0], lon: l[1] } : null; };
  const agl = v => (typeof v.haglFeet === 'number' ? v.haglFeet : Math.max(0, (v.altitude || 0) - (v.groundElevationFeet || 0)));
  function T() {
    const v = V(), g = safe(() => inst().groundContact, undefined), p = pos();
    return { p, alt: v.altitude || 0, a: agl(v), ias: v.kias || 0, gs: typeof v.groundSpeedKnt === 'number' ? v.groundSpeedKnt : (v.groundSpeed || 0) * 1.944, vs: v.verticalSpeed || 0, hdg: ((v.heading360 != null ? v.heading360 : v.heading) || 0 + 360) % 360,
      g: g !== undefined ? !!g : agl(v) < 8, gear: typeof v.gearPosition === 'number' ? v.gearPosition : (safe(() => controls.gear.position, 1)), flaps: safe(() => controls.flaps.target, 0), thr: safe(() => controls.throttle, 0), park: !!safe(() => controls.parkingBrake, false), eng: !!safe(() => inst().engine.on, false) };
  }
  let C = null; // latest telemetry snapshot

  /* ═══════════════ voice + radio effects ═══════════════ */
  const TTS = { ok: 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined', voices: [] };
  const loadVoices = () => { if (TTS.ok) TTS.voices = speechSynthesis.getVoices() || []; };
  if (TTS.ok) { loadVoices(); try { speechSynthesis.addEventListener('voiceschanged', loadVoices); } catch (e) { speechSynthesis.onvoiceschanged = loadVoices; } }
  const voiceFor = key => { const en = TTS.voices.filter(v => /^en/i.test(v.lang)), pool = en.length ? en : TTS.voices; if (!pool.length) return null; return pool[hash(key) % pool.length]; }; // a different voice per unit/sector
  let ac = null; const actx = () => { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; } catch (e) { return null; } };
  function click(open) { const a = S.radioFx && actx(); if (!a) return; const t = a.currentTime, len = Math.floor(a.sampleRate * (open ? .06 : .09)), b = a.createBuffer(1, len, a.sampleRate), d = b.getChannelData(0); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) * .5; const s = a.createBufferSource(), g = a.createGain(), f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200; s.buffer = b; g.gain.value = .12 * S.vol; s.connect(f); f.connect(g); g.connect(a.destination); s.start(t); }
  function chime(kind) { try { const a = actx(); if (!a || !S.voiceOn) return; const seq = kind === 'cpdlc' ? [[1568, 0], [1175, .18]] : kind === 'ra' ? [[880, 0], [880, .2], [880, .4]] : [[1047, 0]]; seq.forEach(([f, t0]) => { const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + t0; o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.2 * S.vol, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + .35); o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + .4); }); } catch (e) { /* audio unavailable */ } }
  let q = Promise.resolve();
  function speak(text, o = {}) { // o: key (voice), pitch, rate, who
    if (!S.voiceOn || !TTS.ok) return Promise.resolve();
    q = q.then(() => new Promise(res => { click(true); const u = new SpeechSynthesisUtterance(text), v = voiceFor(o.key || 'atc'); if (v) { u.voice = v; u.lang = v.lang; } u.rate = clamp(S.rate * (o.rate || 1.05), .6, 1.8); u.pitch = o.pitch || (o.who === 'pilot' ? 1.08 : .92); u.volume = clamp(S.vol, 0, 1); let done = false; const fin = () => { if (!done) { done = true; click(false); setTimeout(res, 220); } }; u.onend = fin; u.onerror = fin; setTimeout(fin, 25000); try { setTimeout(() => speechSynthesis.speak(u), 100); } catch (e) { fin(); } }));
    return q;
  }
  let unlocked = false; const unlock = () => { if (unlocked) return; unlocked = true; actx(); if (TTS.ok) { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) { /* ignore */ } } };
  document.addEventListener('pointerdown', unlock, true); document.addEventListener('keydown', unlock, true);

  /* ═══════════════ phraseology ═══════════════ */
  const W = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const dg = s => String(s).replace(/\D/g, '').split('').map(c => W[+c]).join(' ');
  const PH = { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', J: 'Juliet', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu', I: 'India', O: 'Oscar' };
  const phon = ref => String(ref).toUpperCase().replace(/[^A-Z0-9]/g, '').split('').map(c => (/\d/.test(c) ? W[+c] : PH[c] || c)).join(' ');
  const rwyS = id => { const m = /^(\d+)([LRC]?)$/.exec(id || ''); return m ? dg(m[1]) + ({ L: ' left', R: ' right', C: ' centre', '': '' })[m[2]] : String(id || ''); };
  const freqS = f => (f ? f.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0').split('').map(c => (c === '.' ? 'decimal' : W[+c])).join(' ') : '');
  const altS = ft => { ft = Math.round(ft / 100) * 100; if (ft >= 18000) return 'flight level ' + dg(ft / 100); const th = Math.floor(ft / 1000), h = (ft % 1000) / 100; return ((th ? dg(th) + ' thousand' : '') + (h ? ' ' + dg(h) + ' hundred' : '')).trim() || 'zero'; };
  const altT = ft => (ft >= 18000 ? 'FL' + Math.round(ft / 100) : Math.round(ft) + ' FT');
  const hdgS = h => dg(pad(Math.round(((h % 360) + 360) % 360 / 5) * 5 % 360 || 360, 3));
  const TEL = { SIA: 'Singapore', BAW: 'Speedbird', UAE: 'Emirates', QFA: 'Qantas', DLH: 'Lufthansa', AFR: 'Air France', KLM: 'K L M', CPA: 'Cathay', ANA: 'All Nippon', JAL: 'Japan Air', SWR: 'Swiss', THA: 'Thai', MAS: 'Malaysian', QTR: 'Qatari', ETD: 'Etihad', AAL: 'American', DAL: 'Delta', UAL: 'United', SQC: 'Singapore Cargo', AIC: 'Air India', KAL: 'Korean Air', EVA: 'Eva', CES: 'China Eastern', CCA: 'Air China', CSN: 'China Southern', VIR: 'Virgin', ACA: 'Air Canada', TUR: 'Turkish', ETH: 'Ethiopian', GIA: 'Indonesia', PAL: 'Philippine' };
  const csRaw = () => (S.callsign || F().flt || 'GEOFS1').toUpperCase().replace(/\s+/g, '');
  const cs = () => { const c = csRaw(), m = /^([A-Z]{3})(\d{1,4}[A-Z]?)$/.exec(c); if (m && TEL[m[1]]) return TEL[m[1]] + ' ' + dg(m[2].replace(/[A-Z]/g, '')) + ' heavy'; return c.split('').map(ch => (/\d/.test(ch) ? W[+ch] : PH[ch] || ch)).join(' ') + ' heavy'; };
  const windS = wx => (!wx || wx.dir == null || !wx.spd ? 'wind calm' : 'wind ' + dg(pad(wx.dir, 3)) + ' degrees ' + dg(wx.spd) + ' knots' + (wx.gust ? ', gusting ' + dg(wx.gust) : ''));
  const qnhS = wx => 'Q N H ' + dg(wx ? wx.qnh : 1013);
  const spk = n => String(n).split('').join(' ');

  /* ═══════════════ airports ═══════════════ */
  const AP = icao => { const n = NAV(); return n && n.apt ? n.apt[(icao || '').toUpperCase()] || null : null; };
  const WXs = icao => { const n = NAV(); return (n && n.wx && n.wx[(icao || '').toUpperCase()]) || { dir: null, spd: 0, qnh: 1013, gust: null, raw: '' }; };
  const short = a => (NAV() && a ? NAV().shortName(a) : '');
  const oIcao = () => (F().orig || A.origNear || '').toUpperCase();
  const dIcao = () => (A.divert || F().dest || A.destNear || '').toUpperCase();
  const oApt = () => AP(oIcao()), dApt = () => AP(dIcao());
  async function ensure(icao) { if (!/^[A-Z0-9]{4}$/.test(icao || '') || AP(icao) || A.loading[icao]) return; A.loading[icao] = true; try { await NAV().loadAirport(icao); await NAV().metar(icao); log('SYS', 'Loaded ' + icao); } catch (e) { log('SYS', icao + ': ' + e.message); } A.loading[icao] = false; drawTab(); }
  // nearest-airport index (large + medium airports from OurAirports, cached)
  let AIDX = null;
  async function loadIndex() {
    try { const c = JSON.parse(localStorage.getItem('geofsATC.aidx') || 'null'); if (c && c.length > 500) return (AIDX = c); } catch (e) { /* ignore */ }
    try { const r = await fetch('https://davidmegginson.github.io/ourairports-data/airports.csv', { cache: 'force-cache' }); if (!r.ok) throw new Error('HTTP ' + r.status); const t = await r.text(), out = []; const re = /^\d+,"([A-Z0-9]{3,4})",(large_airport|medium_airport),"((?:[^"]|"")*)",(-?[\d.]+),(-?[\d.]+),(-?[\d.]*)/gm; let m; while ((m = re.exec(t))) out.push([m[1], m[3].replace(/""/g, '"'), +m[4], +m[5], +m[6] || 0, m[2][0] === 'l' ? 1 : 0]);
      AIDX = out; try { localStorage.setItem('geofsATC.aidx', JSON.stringify(out)); } catch (e) { /* ignore */ } log('SYS', 'Airport index loaded (' + out.length + ')'); return out; } catch (e) { log('SYS', 'Airport index unavailable: ' + e.message); return (AIDX = []); }
  }
  function nearest(p, n = 1, bigOnly = false) { if (!AIDX || !p) return []; return AIDX.filter(a => !bigOnly || a[5]).map(a => ({ i: a[0], n: a[1], d: gcd(p, { lat: a[2], lon: a[3] }), b: brg(p, { lat: a[2], lon: a[3] }), e: a[4], big: a[5], la: a[2], lo: a[3] })).sort((x, y) => x.d - y.d).slice(0, n); }

  /* ═══════════════ radios / transponder (the pedestal) ═══════════════ */
  const radios = () => safe(() => LO().state.vhf, []) || [];
  const micIdx = () => { const m = /^vhf(\d)$/.exec(safe(() => LO().state.mic, 'vhf0') || ''); return m ? +m[1] : -1; };
  const tunedIdx = mhz => radios().findIndex(r => r && r.on && Math.abs(r.act - Math.round(mhz * 1000)) <= 5);
  const hfs = () => safe(() => LO().state.hf, []) || [];
  const hfMic = () => { const m = /^hf(\d)$/.exec(safe(() => LO().state.mic, '') || ''); return m ? +m[1] : -1; };
  const hfIdx = mhz => hfs().findIndex(r => r && r.on && Math.abs(r.act - Math.round(mhz * 1000)) <= 1); // HF radios store kHz
  function tuneHF(mhz) { const L = LO(); if (!L || !L.state || !L.state.hf) return false; const i = hfMic() >= 0 ? hfMic() : 0, r = L.state.hf[i]; if (!r) return false; r.stby = r.act; r.act = Math.round(mhz * 1000); r.on = 1; L.state.mic = 'hf' + i; safe(() => L.refresh()); log('SYS', 'Tuned HF ' + (i + 1) + ' to ' + mhz.toFixed(3) + ' MHz'); return true; }
  function reach(stn, forTx) { // can we hear (and be heard by) this station?
    if (!S.needTune || !stn || stn.freq == null) return true;
    if (stn.hf) { const j = hfIdx(stn.freq); return j < 0 ? false : forTx ? hfMic() === j : true; }
    const i = tunedIdx(stn.freq); if (i < 0) return false; return forTx ? micIdx() === i : true;
  }
  function tune(mhz) { const L = LO(); if (!L || !L.state) return false; const i = micIdx() >= 0 ? micIdx() : 0, r = L.state.vhf[i]; if (!r) return false; r.stby = r.act; r.act = Math.round(mhz * 1000); r.on = 1; L.state.mic = 'vhf' + i; safe(() => L.refresh()); log('SYS', 'Tuned VHF ' + (i + 1) + ' to ' + mhz.toFixed(3)); return true; }
  const xp = () => safe(() => LO().state.xp, null);
  const sq = () => (xp() ? String(xp().code) : '2000');
  const XMODES = [['STBY', 0], ['ALT RPTG', 2], ['TA', 3], ['TA/RA', 4]];
  const vfrList = () => String(S.vfrCodes || '').split(/[\s,;]+/).filter(Boolean);
  const mode = () => (S.followXp && vfrList().includes(sq()) ? 'VFR' : 'IFR');

  /* ═══════════════ ATC state ═══════════════ */
  const UN = { CLD: 'Delivery', GND: 'Ground', TWR: 'Tower', DEP: 'Departure', APP: 'Approach', CTR: 'Control' };
  const UF = { CLD: ['CLD', 'GND', 'TWR', 'A/D'], GND: ['GND', 'A/D', 'TWR'], TWR: ['TWR', 'A/D', 'ATF', 'CTAF'], DEP: ['DEP', 'APP', 'TWR', 'A/D'], APP: ['APP', 'DEP', 'TWR', 'A/D'] };
  const A = { ph: 'cd', stn: null, as: { alt: null, hdg: null, spd: null, sq: '', rwy: '', sid: '' }, checked: false, t: {}, busy: false, everAir: false, landed: false, maxAlt: 0, loading: {}, push: false, taxi: false, lined: false, cleared: false, ldgClr: false, atis: {}, vec: 0, go: 0, warn: {}, divert: '', origNear: '', destNear: '', emg: null, gate: '', lastSq: '', unheard: 0, lastCall: 0, tcasT: {} };
  const ctrFreq = () => { const p = pos() || { lat: 0, lon: 0 }; return 124 + ((Math.abs(Math.floor(p.lat / 6) * 7 + Math.floor(p.lon / 8) * 13) % 47) * 0.2); }; // SIM sector frequency (not real)
  function station(unit, key) {
    const a = key === 'd' ? dApt() : oApt(), f = unit === 'CTR' ? null : (NAV() && a ? NAV().freqOf(a, ...(UF[unit] || ['TWR'])) : null), ci = unit === 'CTR' ? ctrInfo() : null, freq = ci ? ci.freq : (f ? f.mhz : null);
    return { unit, key, icao: a ? a.icao : '', freq, name: ci ? ci.name : (a ? short(a) + ' ' : '') + UN[unit], sim: !!(ci && ci.sim), hf: !!(ci && ci.hf) };
  }
  const stnHeard = s => reach(s, false), stnTx = s => reach(s, true);
  const setStn = (unit, key) => { A.stn = station(unit, key); A.checked = false; A.t.stn = now(); drawTab(); return A.stn; };
  const clsFor = s => (s ? s.name + (s.freq ? ' ' + s.freq.toFixed(3) + (s.sim ? ' (SIM)' : '') : '') : '—');

  const RBKEY = /climb|descend|heading|squawk|contact|taxi|hold|cleared|line up|maintain|speed|proceed|turn|expect|report|vacate|go around/;
  async function atcTx(stn, text) { // controller transmits
    if (!stn) return false; const heard = stnHeard(stn); log(heard ? 'ATC' : 'ATC·', (stn.name + ': ') + text + (heard ? '' : '  [not heard - tune ' + (stn.freq ? stn.freq.toFixed(3) : '') + ']'));
    if (heard) { A.lastAtc = { stn, text }; await speak(stn.name + ', ' + text, { key: stn.unit + (stn.icao || 'SIM') }); if (S.manualRb && RBKEY.test(text) && !/readback correct|say again|unable/.test(text)) { const toks = (norm(text.split(cs()).join(' ').replace(/[^.]*\bwind\b[^.]*\./g, ' ').replace(/information \w+/g, ' ')).match(/\d+(?:\.\d+)?/g) || []).filter(t => t.length >= 3 || t.includes('.')); A.rb = { toks, text, stn, t: now(), tries: 0, nag: false }; } }
    return heard;
  }
  async function pilotTx(stn, text) { // we transmit
    let spoken = false; if (A.custom) { text = A.custom.t; spoken = !!A.custom.spoken; A.custom = null; }
    if (!stnTx(stn)) { const i = stn && stn.freq != null ? tunedIdx(stn.freq) : -1; log('SYS', i >= 0 ? 'Select MIC on VHF ' + (i + 1) + ' (' + stn.freq.toFixed(3) + ') to transmit' : 'Not on frequency - tune ' + (stn && stn.freq ? stn.freq.toFixed(3) : '') + ' first'); return false; }
    log('ME', text); if (!spoken) await speak(text, { who: 'pilot', key: 'pilot' }); return true;
  }
  async function exchange(stn, pilotText, atcText, rbText) { if (!(await pilotTx(stn, pilotText))) return false; await atcTx(stn, atcText); if (autoRb() && rbText) await pilotTx(stn, rbText); return true; }

  /* ═══════════════ context helpers ═══════════════ */
  const rwyList = a => (a ? a.rwys.filter(r => r.lat != null) : []);
  function pickRwy(a, pref) { const n = NAV(); if (!a || !n) return null; return n.bestRwy(a, WXs(a.icao), pref); }
  const depRwy = () => { const a = oApt(); return a ? (F().rwy && NAV().rwy(a, F().rwy)) || pickRwy(a, A.as.rwy) : null; };
  const arrRwy = () => { const a = dApt(); return a ? pickRwy(a, A.arrRwy || F().rwyArr || undefined) : null; };
  const thr = r => ({ lat: r.lat, lon: r.lon });
  const xtrack = (r, p) => { const t = thr(r), b = brg(t, p), d = gcd(t, p); return { along: -d * Math.cos(angd(b, r.hdg) * RAD), cross: d * Math.sin(angd(b, r.hdg) * RAD) }; }; // along: nm before the threshold (positive = on final); cross: + right of the centreline
  function onRunway(a, p) { // rectangle from threshold to far end, 35 m half-width
    if (!a || !p) return null; for (const r of rwyList(a)) { const t = thr(r), len = (r.len || 8000) * .3048 / 1852, b = brg(t, p), d = gcd(t, p), al = d * Math.cos(angd(b, r.hdg) * RAD), cr = Math.abs(d * Math.sin(angd(b, r.hdg) * RAD)); if (al > -0.03 && al < len + .03 && cr < 0.019) return r; } return null;
  }
  const sidName = () => { const f = F(); if (f.sidName) return f.sidName; const l = (f.legs || []).find(x => x._p === 'SID'), n = NAV(); if (!l || !n) return ''; const p = n.procList(oIcao(), 'SID').find(x => x.legs[0] && x.legs[0].id === l.id); return p && p.src !== 'GEN' ? p.name : ''; };
  const cruise = () => F().crz || 35000;
  const toD = () => { const a = dApt(), p = C && C.p; return a && p ? gcd(p, { lat: a.lat, lon: a.lon }) : null; };
  const toO = () => { const a = oApt(), p = C && C.p; return a && p ? gcd(p, { lat: a.lat, lon: a.lon }) : null; };
  // taxi routes from OpenStreetMap taxiway names (see GATE tab data)
  function nearestTwy(p, maxM = 250) { const g = GD[oIcao()] || GD[dIcao()]; if (!g || !p) return ''; let best = '', bd = 1e9; g.twys.forEach(w => { w.p.forEach(q => { const d = gcd(p, { lat: q[0], lon: q[1] }) * 1852; if (d < bd && w.ref) { bd = d; best = w.ref; } }); }); return bd <= maxM ? best : ''; }
  // taxiway graph from OpenStreetMap: points of each named taxiway are linked in order, and different taxiways that pass within 25 m are joined.
  function twyGraph(g) {
    if (g._G) return g._G; const nodes = [], adj = [], own = [], grid = new Map(), K = (la, lo) => Math.round(la / .0003) + ',' + Math.round(lo / .0003);
    const link = (a, b, ref) => { const d = gcd({ lat: nodes[a][0], lon: nodes[a][1] }, { lat: nodes[b][0], lon: nodes[b][1] }) * 1852; adj[a].push([b, d, ref]); adj[b].push([a, d, ref]); };
    g.twys.forEach((w, wi) => { let prev = -1; w.p.forEach(q => { const i = nodes.length; nodes.push(q); adj.push([]); own.push(wi); const k = K(q[0], q[1]); (grid.get(k) || grid.set(k, []).get(k)).push(i); if (prev >= 0) link(prev, i, w.ref || ''); prev = i; }); });
    nodes.forEach((q, i) => { const cx = Math.round(q[0] / .0003), cy = Math.round(q[1] / .0003); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) (grid.get((cx + dx) + ',' + (cy + dy)) || []).forEach(j => { if (j > i && own[j] !== own[i] && gcd({ lat: q[0], lon: q[1] }, { lat: nodes[j][0], lon: nodes[j][1] }) * 1852 < 25) link(i, j, ''); }); });
    return (g._G = { nodes, adj });
  }
  function nodeNear(G, p, maxM) { let best = -1, bd = maxM / 1852; G.nodes.forEach((q, i) => { const d = gcd(p, { lat: q[0], lon: q[1] }); if (d < bd) { bd = d; best = i; } }); return best; }
  function twyPath(G, from, goal, goalR) { // Dijkstra; stops at the first node within goalR metres of goal
    const dist = new Float64Array(G.nodes.length).fill(1e18), prev = new Int32Array(G.nodes.length).fill(-1), pe = new Array(G.nodes.length), done = new Uint8Array(G.nodes.length), H = [[0, from]]; dist[from] = 0;
    const push = x => { H.push(x); let i = H.length - 1; while (i > 0) { const pa = (i - 1) >> 1; if (H[pa][0] <= H[i][0]) break; [H[pa], H[i]] = [H[i], H[pa]]; i = pa; } }, pop = () => { const top = H[0], l = H.pop(); if (H.length) { H[0] = l; let i = 0; for (;;) { let m = i; const a = 2 * i + 1, b = a + 1; if (a < H.length && H[a][0] < H[m][0]) m = a; if (b < H.length && H[b][0] < H[m][0]) m = b; if (m === i) break; [H[m], H[i]] = [H[i], H[m]]; i = m; } } return top; };
    while (H.length) { const [d, u] = pop(); if (done[u]) continue; done[u] = 1; if (gcd({ lat: G.nodes[u][0], lon: G.nodes[u][1] }, goal) * 1852 <= goalR) { const refs = []; let x = u; while (prev[x] >= 0) { const r = pe[x]; if (r && refs[refs.length - 1] !== r) refs.push(r); x = prev[x]; } return refs.reverse(); } G.adj[u].forEach(([v, w, ref]) => { if (d + w < dist[v]) { dist[v] = d + w; prev[v] = u; pe[v] = ref; push([d + w, v]); } }); }
    return null;
  }
  function taxiRoute(toRwy, key) {
    const a = key === 'd' ? dApt() : oApt(), g = GD[a ? a.icao : ''];
    if (!g || !g.twys.length || !C || !C.p) return 'via the taxiways';
    try { const G = twyGraph(g), s0 = nodeNear(G, C.p, 400); let goal = null, rad = 120; if (key === 'd') { const gt = g.gates.find(x => x.ref === A.gate) || (g.gates.length ? { lat: g.gates.reduce((q, x) => q + x.lat, 0) / g.gates.length, lon: g.gates.reduce((q, x) => q + x.lon, 0) / g.gates.length } : null); goal = gt && { lat: gt.lat, lon: gt.lon }; rad = 150; } else if (toRwy) { goal = thr(toRwy); rad = 160; }
      if (s0 >= 0 && goal) { const refs = twyPath(G, s0, goal, rad); if (refs && refs.length) { A.taxiPath = refs; return 'via ' + refs.slice(0, 7).map(phon).join(', '); } } } catch (e) { /* fall through */ }
    const t1 = nearestTwy(C.p, 400), t2 = toRwy ? nearestTwy(thr(toRwy), 400) : '', list = [t1, t2].filter((x, i, ar) => x && ar.indexOf(x) === i); return list.length ? 'via ' + list.map(phon).join(', ') : 'via the taxiways';
  }

  /* ═══════════════ the flow (phases) ═══════════════ */
  const REQ = {}; // id -> {label, show(c), run(c)}
  const atisLetter = icao => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[(new Date().getUTCHours() * 3 + hash(icao)) % 26];
  async function atis(icao) {
    icao = (icao || '').toUpperCase(); try { await ensure(icao); const a = AP(icao); if (!a) return; const wx = (await NAV().metar(icao)) || WXs(icao), r = pickRwy(a), d = new Date(), t = pad(d.getUTCHours()) + pad(d.getUTCMinutes()), L = atisLetter(icao), f = NAV().freqOf(a, 'ATIS');
      A.atis[icao] = L; const txt = short(a) + ' information ' + L + ', time ' + dg(t) + ' Zulu. ' + (r ? 'Runway in use ' + rwyS(r.id) + '. ' : '') + windS(wx) + '. ' + (wx.vis ? 'Visibility ' + (wx.vis >= 9999 ? 'ten kilometres or more' : dg(wx.vis) + ' metres') + '. ' : '') + qnhS(wx) + '. Advise on first contact you have information ' + L + '.';
      const st = { unit: 'ATIS', icao, freq: f ? f.mhz : null, name: short(a) + ' ATIS' }; if (S.needTune && f && !stnHeard(st)) { log('SYS', 'Tune ' + f.mhz.toFixed(3) + ' to hear the ATIS'); } else { log('ATIS', txt); await speak(txt, { key: 'ATIS' + icao }); }
      try { const s = LO().state; if (s && wx.qnh) { s.baro.qnh = wx.qnh; } } catch (e) { /* ignore */ } drawTab(); } catch (e) { log('SYS', 'ATIS: ' + e.message); }
  }
  const infoTxt = icao => (A.atis[icao] ? 'with information ' + A.atis[icao] + ', ' : '');

  REQ.cd = { label: 'Request IFR clearance', ph: 'cd', show: () => mode() === 'IFR', async run() {
    const o = oApt(), d = dApt(), r = depRwy(), stn = A.stn, sid = sidName(), alt = Math.min(cruise(), 5000), dep = o && NAV().freqOf(o, 'DEP', 'APP', 'A/D'), code = A.as.sq || (A.as.sq = String(1 + Math.floor(Math.random() * 6)) + [0, 0, 0].map(() => Math.floor(Math.random() * 8)).join(''));
    A.as.rwy = r ? r.id : ''; A.as.sid = sid; A.as.alt = alt;
    const at = csT() + ' cleared to ' + (d ? short(d) : dIcao() || 'destination') + ' via ' + (sid ? sid + ' departure' : 'runway heading, then radar vectors') + ', flight planned route. Climb initially ' + altS(alt) + (dep ? ', departure frequency ' + freqS(dep.mhz) : '') + ', squawk ' + dg(code) + '.' + (A.atis[oIcao()] ? '' : ' Advise when you have the ATIS.');
    const rb = 'Cleared to ' + (d ? short(d) : 'destination') + ' via ' + (sid ? sid + ' departure' : 'runway heading') + ', climb ' + altS(alt) + ', squawk ' + dg(code) + ', ' + cs() + '.';
    const fin = async () => { if (S.autoSq && xp()) { xp().code = code; safe(() => LO().refresh()); } await atcTx(stn, 'Readback correct. Contact Ground ' + (station('GND', 'o').freq ? freqS(station('GND', 'o').freq) : '') + ' when ready for pushback.'); A.cdDone = true; setStn('GND', 'o'); };
    const ok = await exchange(stn, 'Delivery, ' + cs() + ', ' + infoTxt(oIcao()) + 'stand ' + (A.gate || 'ready') + ', request I F R clearance to ' + (dIcao() ? spk(dIcao()) : 'destination') + '.', at, rb); if (!ok) return;
    if (S.manualRb && A.rb) { A.rb.onOk = fin; return; } await fin();
  } };
  const csT = () => cs() + ',';
  REQ.push = { label: 'Request pushback & start', ph: 'gnd', show: () => !A.push && !A.taxi, async run() { const stn = A.stn, wx = WXs(oIcao()); const ok = await exchange(stn, 'Ground, ' + cs() + ', ' + (A.gate ? 'at stand ' + A.gate + ', ' : '') + infoTxt(oIcao()) + 'request pushback and start up.', csT() + ' pushback and start up approved, ' + qnhS(wx) + '.', 'Pushback and start up approved, ' + cs() + '.'); if (ok) A.push = true; } };
  REQ.taxi = { label: 'Request taxi', ph: 'gnd', show: () => !A.taxi, async run() {
    try { await loadGates(oIcao()); } catch (e) { /* use fallback routing */ }
    const stn = A.stn, r = depRwy(), route = taxiRoute(r, 'o'), vfr = mode() === 'VFR', wx = WXs(oIcao());
    const at = csT() + (vfr ? ' VFR departure approved, ' : ' ') + 'taxi to holding point runway ' + (r ? rwyS(r.id) : 'in use') + ' ' + route + ', ' + qnhS(wx) + (vfr ? ', squawk VFR.' : '.') + ' Hold short of the runway.';
    const ok = await exchange(stn, 'Ground, ' + cs() + ', ' + infoTxt(oIcao()) + (vfr ? 'VFR departure, ' : '') + 'ready to taxi.', at, 'Taxi to holding point runway ' + (r ? rwyS(r.id) : '') + ' ' + route + ', hold short, ' + cs() + '.'); if (ok) { A.taxi = true; A.as.rwy = r ? r.id : ''; } } };
  REQ.rdy = { label: 'Ready for departure', ph: 'twr', show: () => !A.lined && !A.cleared, async run() {
    const stn = A.stn, r = depRwy(), wx = WXs(oIcao()), ok0 = await pilotTx(stn, 'Tower, ' + cs() + ', holding short runway ' + (r ? rwyS(r.id) : '') + ', ready for departure.'); if (!ok0) return;
    if (S.lineup && mode() === 'IFR') { await atcTx(stn, csT() + ' runway ' + (r ? rwyS(r.id) : '') + ', line up and wait.'); if (autoRb()) await pilotTx(stn, 'Line up and wait runway ' + (r ? rwyS(r.id) : '') + ', ' + cs() + '.'); A.lined = true; A.t.lined = now(); }
    else await clearTakeoff();
  } };
  async function clearTakeoff() {
    const stn = A.stn, r = depRwy(), wx = WXs(oIcao()), x = xp(), warn = [];
    if (x && x.mode < 2) warn.push('Check your transponder, it appears to be on standby.'); else if (mode() === 'IFR' && A.as.sq && sq() !== A.as.sq) warn.push('Confirm squawk ' + dg(A.as.sq) + '.');
    A.cleared = true; A.t.cleared = now();
    await atcTx(stn, csT() + ' ' + (warn.length ? warn.join(' ') + ' ' : '') + windS(wx) + ', runway ' + (r ? rwyS(r.id) : '') + ', cleared for takeoff' + (mode() === 'VFR' ? ', report leaving the zone.' : '.'));
    if (autoRb()) await pilotTx(stn, 'Runway ' + (r ? rwyS(r.id) : '') + ', cleared for takeoff, ' + cs() + '.');
  }
  REQ.checkin = { label: 'Check in on frequency', ph: ['dep', 'ctr', 'app', 'twr2', 'gnd2', 'gnd', 'twr'], show: () => !A.checked && !!A.stn && !['cd'].includes(A.ph), async run() {
    const stn = A.stn, c = C; let pt, at, rb; const nm = UN[stn.unit];
    if (A.ph === 'dep') { const first = (F().legs || [])[0]; A.as.alt = Math.min(cruise(), 12000); A.as.spd = 250; at = csT() + ' radar contact. Climb ' + altS(A.as.alt) + (first && A.as.sid ? ', proceed on the ' + A.as.sid + ' departure' : first ? ', proceed direct ' + phon(first.id) : ', turn left heading ' + hdgS(depRwy() ? depRwy().hdg : c.hdg)) + ', speed two five zero knots below one zero thousand.'; pt = 'Departure, ' + cs() + ', passing ' + altS(c.alt) + ' climbing ' + altS(A.as.alt) + (A.as.sid ? ', ' + A.as.sid + ' departure' : '') + '.'; rb = 'Climb ' + altS(A.as.alt) + ', speed two five zero below ten thousand, ' + cs() + '.'; }
    else if (A.ph === 'ctr') { A.as.alt = cruise(); A.as.spd = null; pt = 'Control, ' + cs() + ', passing ' + altS(c.alt) + ' climbing ' + altS(A.as.alt) + '.'; at = csT() + ' radar contact, climb ' + altS(A.as.alt) + '. Datalink: logon ' + (stn.name || 'Control') + '.'; rb = 'Climb ' + altS(A.as.alt) + ', ' + cs() + '.'; if (!curOc()) cpLogon(stn); else log('SYS', 'Oceanic: log on with the centre code on the CDU first.'); }
    else if (A.ph === 'app') { pt = 'Approach, ' + cs() + ', ' + altS(c.alt) + ', ' + infoTxt(dIcao()) + 'inbound.'; const r = arrRwy(); A.as.alt = Math.min(Math.max(6000, Math.round((c.alt - 4000) / 1000) * 1000), 10000); A.as.spd = 250; A.vec = 1; at = csT() + ' radar contact, ' + qnhS(WXs(dIcao())) + (r ? ', expect I L S runway ' + rwyS(r.id) : '') + '. Descend ' + altS(A.as.alt) + (r ? ', ' + vecText(r) : '') + '.'; rb = 'Descend ' + altS(A.as.alt) + ', ' + cs() + '.'; }
    else if (A.ph === 'twr2') { const r = arrRwy(); pt = 'Tower, ' + cs() + ', ' + (mode() === 'VFR' ? 'inbound' : 'established I L S') + ' runway ' + (r ? rwyS(r.id) : '') + '.'; at = csT() + ' continue approach, ' + windS(WXs(dIcao())) + '.'; rb = 'Continue approach, ' + cs() + '.'; }
    else if (A.ph === 'gnd2') { try { await loadGates(dIcao()); } catch (e) { /* fallback */ } const r = arrRwy(); pt = 'Ground, ' + cs() + ', runway vacated.'; at = csT() + ' taxi to the gate ' + taxiRoute(r, 'd') + '.'; rb = 'Taxi to the gate, ' + cs() + '.'; A.t.gnd2 = now(); }
    else { pt = nm + ', ' + cs() + ', on frequency.'; at = csT() + ' roger, go ahead.'; rb = null; }
    const ok = await exchange(stn, pt, at, rb); if (ok) { A.checked = true; A.t.checked = now(); }
  } };
  REQ.desc = { label: 'Request descent', ph: 'ctr', show: () => A.checked, async run() { const alt = A.as.alt > 24000 ? 24000 : 10000; A.as.alt = alt; await exchange(A.stn, 'Control, ' + cs() + ', request descent.', csT() + ' descend ' + altS(alt) + '.', 'Descend ' + altS(alt) + ', ' + cs() + '.'); } };
  REQ.fl = { label: 'Request higher / lower FL', ph: 'ctr', show: () => A.checked && cpOK(), run() { cpRequest('alt', cruise() + 2000); } };
  REQ.dct = { label: 'Request direct next waypoint', ph: 'ctr', show: () => A.checked && cpOK(), run() { const f = F(), l = (f.legs || [])[(f.active || 0) + 1]; if (l) cpRequest('dct', l.id); else log('SYS', 'No second waypoint in the CDU route to request'); } };
  REQ.vfrin = { label: 'Request join (VFR inbound)', ph: 'vfr', show: () => mode() === 'VFR', async run() { /* handled by tick */ } };

  // radar vectors to final
  const vecText = r => { const t = thr(r), j = dest(t, (r.hdg + 180) % 360, 14); A.joinPt = j; A.as.hdg = Math.round(brg(C.p, j) / 5) * 5 % 360; A.t.vec = now(); return 'fly heading ' + hdgS(A.as.hdg) + ', vectors for the approach'; };
  const PHASES = {
    async cd() { if (mode() === 'VFR') setStn('GND', 'o'), A.ph = 'gnd'; },
    async gnd(c) {
      const r = depRwy(), a = oApt(); if (!A.taxi || !r || !a) return; const d = gcd(c.p, thr(r));
      if (c.g && d < 0.45 && c.gs < 12 && !A.t.hoGnd && !onRunway(a, c.p)) { A.t.hoGnd = now(); const t = station('TWR', 'o'); if (await atcTx(A.stn, csT() + ' hold short runway ' + rwyS(r.id) + ', contact Tower ' + (t.freq ? freqS(t.freq) : '') + '.')) { if (autoRb()) await pilotTx(A.stn, 'Hold short runway ' + rwyS(r.id) + ', Tower ' + (t.freq ? freqS(t.freq) : '') + ', ' + cs() + '.'); A.ph = 'twr'; setStn('TWR', 'o'); } else A.t.hoGnd = 0; }
    },
    async twr(c) {
      if (A.lined && !A.cleared && now() - A.t.lined > 7000) return clearTakeoff();
      if (A.cleared && !c.g && c.a > 300 && c.vs > 200 && !A.t.hoTwr) { A.t.hoTwr = now(); if (mode() === 'VFR') { A.ph = 'vfr'; A.stn = null; await atcTx(station('TWR', 'o'), csT() + ' airborne, squawk VFR, report leaving the zone.'); return; } const d = station('DEP', 'o'); if (await atcTx(A.stn, csT() + ' airborne, contact Departure ' + (d.freq ? freqS(d.freq) : '') + '.')) { if (autoRb()) await pilotTx(A.stn, 'Contact Departure ' + (d.freq ? freqS(d.freq) : '') + ', ' + cs() + '.'); A.ph = 'dep'; setStn('DEP', 'o'); } else A.t.hoTwr = 0; }
    },
    async dep(c) {
      if (!A.checked) return;
      if (A.as.alt && A.as.alt < cruise() && c.alt > A.as.alt - 1500 && now() - (A.t.step || 0) > 30000) { A.t.step = now(); A.as.alt = Math.min(cruise(), A.as.alt + 6000); await atcTx(A.stn, csT() + ' climb ' + altS(A.as.alt) + '.'); }
      if (c.alt > 10300 && A.as.spd === 250) { A.as.spd = null; await atcTx(A.stn, csT() + ' speed your discretion.'); }
      if (c.alt > 12000 || (toO() || 0) > 60) { if (!A.t.hoDep) { A.t.hoDep = now(); const t = station('CTR', 'o'); if (await atcTx(A.stn, csT() + ' contact Control ' + freqS(t.freq) + '.')) { if (autoRb()) await pilotTx(A.stn, 'Control ' + freqS(t.freq) + ', ' + cs() + '.'); A.ph = 'ctr'; setStn('CTR', 'o'); } else A.t.hoDep = 0; } }
    },
    async ctr(c) {
      if (!A.checked) return; const d = toD(), f = F();
      if (A.cpLogged && A.as.alt === cruise() && c.alt > cruise() - 600 && !A.t.dctOffer && now() - A.t.checked > 150000) { A.t.dctOffer = now(); const l = (f.legs || [])[(f.active || 0) + 1]; if (l && S.cpdlc) cpUplink('PROCEED DIRECT TO ' + l.id, { type: 'dct', v: l.id }, 'WU'); }
      const tod = d != null && c.alt > 12000 ? (c.alt - 10000) / 1000 * 3 + 12 : null;
      if (tod != null && d < tod && !A.t.desc1) { A.t.desc1 = now(); A.as.alt = 24000 < c.alt ? 24000 : 10000; if (S.cpdlc && A.cpLogged) { cpUplink('DESCEND TO ' + altT(A.as.alt), { type: 'alt', v: A.as.alt }, 'WU'); await atcTx(A.stn, csT() + ' descent clearance sent by datalink.'); } else await atcTx(A.stn, csT() + ' descend ' + altS(A.as.alt) + '.'); }
      else if (A.t.desc1 && c.alt < A.as.alt + 1500 && A.as.alt > 10000 && now() - A.t.desc1 > 40000 && !A.t.desc2) { A.t.desc2 = now(); A.as.alt = 10000; A.as.spd = 250; await atcTx(A.stn, csT() + ' descend ' + altS(10000) + ', speed two five zero knots.'); }
      if (d != null && d < 55 && c.alt < 25000 && !A.t.hoCtr) { A.t.hoCtr = now(); const t = station('APP', 'd'); if (await atcTx(A.stn, csT() + ' contact Approach ' + (t.freq ? freqS(t.freq) : '') + '.')) { if (autoRb()) await pilotTx(A.stn, 'Approach ' + (t.freq ? freqS(t.freq) : '') + ', ' + cs() + '.'); A.ph = 'app'; setStn('APP', 'd'); A.vec = 0; } else A.t.hoCtr = 0; }
    },
    async app(c) {
      if (!A.checked) return; const r = arrRwy(); if (!r) return; const j = A.joinPt || dest(thr(r), (r.hdg + 180) % 360, 14), xt = xtrack(r, c.p), dj = gcd(c.p, j);
      if (A.vec === 1 && dj < 5) { A.vec = 2; const side = xt.cross > 0 ? -1 : 1, h = (r.hdg + side * 30 + 360) % 360; A.as.hdg = Math.round(h / 5) * 5 % 360; A.as.alt = Math.min(A.as.alt, 4000); A.as.spd = 180; A.t.vec = now(); await atcTx(A.stn, csT() + ' turn ' + (side < 0 ? 'left' : 'right') + ' heading ' + hdgS(A.as.hdg) + ', descend ' + altS(A.as.alt) + ', reduce speed one eight zero, cleared I L S approach runway ' + rwyS(r.id) + ', report established.'); if (autoRb()) await pilotTx(A.stn, 'Heading ' + hdgS(A.as.hdg) + ', ' + altS(A.as.alt) + ', cleared I L S runway ' + rwyS(r.id) + ', ' + cs() + '.'); }
      else if (A.vec === 1 && now() - (A.t.vec || 0) > 75000) { const nb = Math.round(brg(c.p, j) / 5) * 5 % 360; if (Math.abs(angd(nb, A.as.hdg || nb)) > 12) { A.as.hdg = nb; A.t.vec = now(); await atcTx(A.stn, csT() + ' turn ' + (angd(nb, c.hdg) < 0 ? 'left' : 'right') + ' heading ' + hdgS(nb) + '.'); } else A.t.vec = now(); }
      if (A.vec === 2 && Math.abs(xt.cross) < 1.2 && Math.abs(angd(c.hdg, r.hdg)) < 35 && xt.along < 11 && xt.along > 0 && !A.t.hoApp) { A.as.hdg = null; A.as.spd = null; A.vec = 3; A.t.hoApp = now(); const t = station('TWR', 'd'); if (await atcTx(A.stn, csT() + ' contact Tower ' + (t.freq ? freqS(t.freq) : '') + '.')) { if (autoRb()) await pilotTx(A.stn, 'Tower ' + (t.freq ? freqS(t.freq) : '') + ', ' + cs() + '.'); A.ph = 'twr2'; setStn('TWR', 'd'); } else A.t.hoApp = 0; }
    },
    async twr2(c) {
      const r = arrRwy(), a = dApt(); if (!r) return; const xt = xtrack(r, c.p);
      if (!c.g && A.checked && !A.ldgClr && xt.along < 5.5 && xt.along > 0 && c.a < 3000) { A.ldgClr = true; await atcTx(A.stn, csT() + ' ' + windS(WXs(dIcao())) + ', runway ' + rwyS(r.id) + ', cleared to land.'); if (autoRb()) await pilotTx(A.stn, 'Runway ' + rwyS(r.id) + ', cleared to land, ' + cs() + '.'); }
      // go-around: gear not down / badly misaligned / very high sink close in
      if (!c.g && xt.along < 2.2 && xt.along > 0 && c.a < 900 && c.a > 80 && !A.t.ga) { const bad = c.gear < .9 ? 'gear not down' : Math.abs(xt.cross) > .5 ? 'unstable, not aligned' : c.vs < -2200 ? 'excessive sink rate' : ''; if (bad) { A.t.ga = now(); A.go++; A.ldgClr = false; A.vec = 0; A.t.hoApp = 0; A.t.hoCtr = 1; const ap = station('APP', 'd'); log('ATC', 'Go-around instruction (' + bad + ')'); if (await atcTx(A.stn, csT() + ' go around, I say again, go around, ' + bad + '. Fly runway heading, climb ' + altS(3000) + ', contact Approach ' + (ap.freq ? freqS(ap.freq) : '') + '.')) { A.ph = 'app'; setStn('APP', 'd'); A.as.alt = 3000; A.as.hdg = null; } } }
      if (c.g && A.everAir && A.maxAlt > 1500) A.landed = true;
      if (A.landed && c.g && c.gs < 40 && !A.t.vac) { A.t.vac = now(); const g = station('GND', 'd'); if (await atcTx(A.stn, csT() + ' vacate the runway when able, contact Ground ' + (g.freq ? freqS(g.freq) : '') + '.')) { if (autoRb()) await pilotTx(A.stn, 'Vacate, Ground ' + (g.freq ? freqS(g.freq) : '') + ', ' + cs() + '.'); A.ph = 'gnd2'; setStn('GND', 'd'); } else A.t.vac = 0; }
    },
    async gnd2(c) { if (A.checked && c.g && c.gs < 1 && C.park && !A.t.park) { A.t.park = now(); await atcTx(A.stn, csT() + ' thank you, good day.'); A.ph = 'done'; } },
    async vfr(c) { // VFR: free after the zone; inbound handled at arrival
      const d = toD(); if (A.t.vfrIn) return; if (!c.g && d != null && d < 22 && c.alt < 9000) { A.t.vfrIn = now(); const t = station('APP', 'd'), st = t.freq ? t : station('TWR', 'd'); A.ph = 'twr2'; A.stn = st; A.checked = false; A.vec = 3; log('ATC', 'VFR inbound - call ' + clsFor(st)); drawTab(); }
    },
  };
  // runway incursion / transponder / altitude / heading / speed monitoring
  async function monitor(c) {
    const a = A.stn; const cool = (k, ms) => { if (A.warn[k] && now() - A.warn[k] < ms) return false; A.warn[k] = now(); return true; };
    if (!a) return; const ud = ['dep', 'ctr', 'app'].includes(A.ph);
    const oa = oApt(); if (oa && ['cd', 'gnd', 'twr'].includes(A.ph) && c.g && c.p && !A.cleared) { const r = onRunway(oa, c.p); if (r && c.gs > 3 && cool('inc', 30000)) await atcTx(a, csT() + ' hold position, you are on runway ' + rwyS(r.id) + ' without a clearance.'); }
    if (A.cleared && c.g && c.gs > 40 && c.thr < .3 && cool('stop', 60000) && false) { /* reserved */ }
    if (!c.g && ud) {
      if (A.as.alt != null) { const hi = c.alt - A.as.alt, climbing = A.as.alt >= C.alt - 100; if (A.as.alt && ((A.ph === 'dep' || A.ph === 'ctr') && hi > 400 && c.vs > 200 && cool('altHi', 45000)) || ((A.ph === 'app' || (A.ph === 'ctr' && A.t.desc1)) && hi < -500 && c.vs < -200 && cool('altLo', 45000))) await atcTx(a, csT() + ' check your altitude, you were ' + (A.ph === 'dep' || (A.ph === 'ctr' && !A.t.desc1) ? 'cleared to maintain ' : 'cleared to ') + altS(A.as.alt) + '.'); void climbing; }
      if (A.as.hdg != null && A.ph === 'app' && Math.abs(angd(c.hdg, A.as.hdg)) > 25 && now() - (A.t.vec || 0) > 30000 && cool('hdg', 45000)) await atcTx(a, csT() + ' fly heading ' + hdgS(A.as.hdg) + '.');
      if (c.alt < 10000 && c.ias > 258 && c.a > 500 && cool('spd', 60000)) await atcTx(a, csT() + ' reduce speed, maximum two five zero knots below ten thousand.');
    }
  }

  /* ═══════════════ emergencies ═══════════════ */
  async function declare(kind) {
    if (A.emg) return; const c = C, o = AIDX && c && c.p ? nearest(c.p, 3, true) : [], n = o[0]; A.emg = { kind, t: now(), st: 0 }; log('ME', kind + ' ' + kind + ' ' + kind);
    const stn = A.stn || station('CTR', 'o'); if (xp() && S.followXp) { xp().code = '7700'; safe(() => LO().refresh()); }
    await speak(kind + ', ' + kind + ', ' + kind + ', ' + cs() + '.', { who: 'pilot', key: 'pilot', rate: 1.1 });
    await atcTx(stn, csT() + ' roger ' + kind + ', squawk seven seven zero zero. All stations stand by, ' + UN[stn.unit] + ' is handling an emergency. Say souls on board, fuel remaining and your intentions.');
    A.emg.st = 1; drawTab();
    if (n) { A.emg.apt = n; await ensure(n.i); }
  }
  async function emgReport() {
    if (!A.emg) return; const stn = A.stn || station('CTR', 'o'), n = A.emg.apt, c = C; await pilotTx(stn, 'Souls on board ' + spk(S.souls) + ', fuel ' + spk(S.fuelH) + ' hours ' + spk(S.fuelM) + ' minutes, ' + (A.emg.kind === 'MAYDAY' ? 'request vectors to the nearest suitable airport.' : 'request return.')); A.emg.st = 2;
    if (n) { A.divert = n.i; const a = AP(n.i), r = a ? pickRwy(a) : null, b = Math.round(brg(c.p, { lat: n.la, lon: n.lo }) / 5) * 5 % 360; A.as.hdg = b; A.as.alt = Math.max(3000, Math.min(c.alt, 10000)); A.vec = 1; if (r) A.arrRwy = r.id; A.ph = 'app'; A.checked = true; A.stn = station('APP', 'd'); A.as.spd = null; A.t.vec = now();
      await atcTx(A.stn, csT() + ' roger, nearest suitable is ' + short(a || { name: n.n, city: n.n }) + ', ' + Math.round(n.d) + ' miles, bearing ' + dg(pad(Math.round(n.b), 3)) + (r ? ', expect runway ' + rwyS(r.id) + ' priority landing' : '') + '. Turn ' + (angd(b, c.hdg) < 0 ? 'left' : 'right') + ' heading ' + hdgS(b) + ', descend ' + altS(A.as.alt) + ', cleared direct, report ready for approach.'); }
    else await atcTx(stn, csT() + ' roger, say again your intentions; no suitable airport data available.');
    drawTab();
  }
  function endEmergency() { A.emg = null; A.divert = ''; if (xp() && S.followXp && sq() === '7700') { xp().code = A.as.sq || '2000'; safe(() => LO().refresh()); } log('SYS', 'Emergency cancelled'); drawTab(); }

  /* ═══════════════ oceanic: SELCAL, position reports ═══════════════ */
  const SELL = 'ABCDEFGHJKLMPQRS';
  const selcal = () => { if (!/^[A-S]{2}-[A-S]{2}$/.test(S.selcal || '')) { const pick = () => { const a = SELL[Math.floor(Math.random() * 16)]; let b = SELL[Math.floor(Math.random() * 16)]; while (b === a) b = SELL[Math.floor(Math.random() * 16)]; return [a, b].sort().join(''); }; S.selcal = pick() + '-' + pick(); save(); } return S.selcal; };
  function selcalTone() { const a = actx(); if (!a || !S.voiceOn) return; [[1209, 0], [1633, .02], [1209, .9], [1633, .92]].forEach(([f, t0]) => { const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + t0; o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.15 * S.vol, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + .7); o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + .75); }); }
  const hhmm = ms => { const d = new Date(ms); return pad(d.getUTCHours()) + pad(d.getUTCMinutes()); };
  function posData() {
    const c = C, f = F(), legs = (f.legs || []).filter(l => isFinite(l.lat)), act = Math.max(0, f.active || 0), here = A.posAt || null, gs = Math.max(300, c.gs || 450), nx = legs[act], n2 = legs[act + 1];
    const eta = l => (l && c.p ? hhmm(now() + gcd(c.p, l) / gs * 3600000) : '----');
    return { id: here ? here.id : 'PPOS', t: here ? hhmm(here.t) : hhmm(now()), alt: c.alt, next: nx ? nx.id : '-----', nextEta: eta(nx), next2: n2 ? n2.id : '-----', lat: c.p ? c.p.lat : 0, lon: c.p ? c.p.lon : 0 };
  }
  const posText = d => 'POSITION ' + d.id + ' ' + d.t + 'Z ' + altT(d.alt) + ' ESTIMATING ' + d.next + ' ' + d.nextEta + 'Z NEXT ' + d.next2;
  async function sendPos() {
    const d = posData(), stn = A.stn; A.posAt = null; A.posDue = null;
    if (cpOK()) { cpDown(posText(d)); cdMsg('POSITION REPORT SENT'); setTimeout(() => cpUplink('ROGER POSITION REPORT', null, 'R'), 4000 + Math.random() * 4000); return; }
    if (!stn) return log('SYS', 'No station selected'); const spoken = 'Position ' + phon(d.id) + ' at ' + dg(d.t) + ', ' + altS(d.alt) + ', estimating ' + phon(d.next) + ' at ' + dg(d.nextEta) + ', next ' + phon(d.next2) + '.';
    if (await pilotTx(stn, cs().replace(/ heavy$/, '') + ' heavy, ' + spoken)) await atcTx(stn, csT() + ' roger.');
  }
  function posWatch(c) { // pass-a-waypoint detection while in oceanic airspace
    if (!curOc()) { A.posDue = null; return; } const f = F(), legs = f.legs || [], act = Math.max(0, f.active || 0), l = legs[act]; if (!l || !c.p || !isFinite(l.lat)) return;
    if (gcd(c.p, l) < 4 && A.posKey !== act + ':' + l.id) { A.posKey = act + ':' + l.id; A.posAt = { id: l.id, t: now() }; A.posDue = { t: now() }; chime('cpdlc'); cdMsg('POS REPORT DUE'); log('SYS', 'Over ' + l.id + ': position report due (CDU ATC > POS REPORT, or the button on the COMMS tab).'); }
    if (A.posDue && !A.posNag && now() - A.posDue.t > 360000 && A.stn && A.stn.hf) { A.posNag = true; selcalTone(); cdMsg('SELCAL'); log('ATC', 'SELCAL ' + selcal() + ' - ' + (A.stn.name || 'Control') + ' calling: send your position report'); } if (!A.posDue) A.posNag = false;
  }
  async function selcalCheck() { const stn = A.stn; if (!stn) return; if (!(await pilotTx(stn, cs().replace(/ heavy$/, '') + ' heavy, SELCAL check, ' + selcal().split('').filter(x => x !== '-').join(' ') + '.'))) return; selcalTone(); await atcTx(stn, csT() + ' SELCAL check OK.'); }
  /* ═══════════════ CPDLC ═══════════════ */
  const CP = { msgs: [], id: 0, unit: '' };
  const cpOK = () => !!A.cpLogged && S.cpdlc;
  function cpLogon(stn) { A.cpLogged = true; CP.unit = (stn && stn.name) || 'CONTROL'; chime('cpdlc'); log('CPDLC', 'ATC COMM ESTABLISHED - ' + CP.unit); cdMsg('ATC COMM ESTABLISHED'); }
  function cpUplink(txt, act, resp) { const m = { id: ++CP.id, dir: 'UP', txt, act, resp: resp || 'R', st: 'NEW', t: now() }; CP.msgs.unshift(m); chime('cpdlc'); cdMsg('ATC UPLINK'); log('CPDLC', 'UPLINK: ' + txt); drawTab(); return m; }
  function cpDown(txt) { const m = { id: ++CP.id, dir: 'DN', txt, st: 'SENT', t: now() }; CP.msgs.unshift(m); log('CPDLC', 'DOWNLINK: ' + txt); return m; }
  const cdMsg = t => safe(() => LO().cdus.forEach(c => { c.msg = t; })); // flashes in the CDU scratchpad line
  function cpRespond(id, how) {
    const m = CP.msgs.find(x => x.id === id && x.dir === 'UP'); if (!m || m.st !== 'NEW' && m.st !== 'STANDBY') return; const map = { WILCO: 'ACCEPTED', ROGER: 'ACCEPTED', UNABLE: 'REJECTED', STANDBY: 'STANDBY' }; m.st = map[how] || 'ACCEPTED'; cpDown(how); const a = m.act;
    if (how === 'WILCO' && a) { if (a.type === 'alt') { A.as.alt = a.v; if (S.autoAP) safe(() => OV().setAP('alt', a.v)); } else if (a.type === 'dct') { const f = F(), i = (f.legs || []).findIndex(l => l.id === a.v); if (i >= 0) { f.active = i; f.lnav = true; safe(() => LO().save()); } } }
    cdMsg('ATC ' + how + ' SENT'); drawTab(); safe(() => LO().refresh());
  }
  function cpRequest(kind, v) {
    if (!cpOK()) return log('SYS', 'CPDLC not connected (you are connected after the Centre check-in)'); const txt = kind === 'alt' ? 'REQUEST ' + altT(v) : kind === 'dct' ? 'REQUEST DIRECT TO ' + v : 'REQUEST ' + String(v).toUpperCase(); cpDown(txt); cdMsg('REQUEST SENT'); drawTab();
    setTimeout(() => { const deny = Math.random() < .15; if (deny) cpUplink('UNABLE ' + txt.replace('REQUEST ', '') + ' DUE TO TRAFFIC', null, 'R'); else if (kind === 'alt') cpUplink((v > C.alt ? 'CLIMB TO ' : 'DESCEND TO ') + altT(v), { type: 'alt', v }, 'WU'); else if (kind === 'dct') cpUplink('PROCEED DIRECT TO ' + v, { type: 'dct', v }, 'WU'); else cpUplink('ROGER ' + txt, null, 'R'); }, 7000 + Math.random() * 9000);
  }
  // CDU pages (Lower Panel): ATC index, uplinks (ACCEPT / REJECT), requests, log
  function installPages() {
    const L = LO(); if (!L || !L.pages || !L.kit) return false; const { cell, fld, lk, act, info, rows6 } = L.kit, P = L.pages;
    const wrap = t => { const o = []; String(t).split(' ').forEach(w => { const l = o[o.length - 1]; if (l !== undefined && (l + ' ' + w).length <= 22) o[o.length - 1] = l + ' ' + w; else o.push(w); }); return o; };
    const sp = () => safe(() => L.cdus[L.state.cur].sp, '') || '';
    P.ATCIDX = () => ({ title: 'ATC INDEX', rows: rows6([[lk('<LOGON/STATUS', 'ATCSTAT'), lk('UPLINK>', 'ATCUPL')], [act('', '<REQUEST', () => { if (!cpOK()) return 'ATC NOT CONNECTED'; L.cdus[L.state.cur].page = 'ATCREQ'; return null; }), lk('LOG>', 'ATCLOG')], [lk('<POS REPORT', 'ATCPOS'), info('', CP.msgs.filter(m => m.dir === 'UP' && m.st === 'NEW').length + ' NEW UPLINK(S)', CP.msgs.some(m => m.dir === 'UP' && m.st === 'NEW') ? 'm' : '')], null, null, [lk('<INDEX', 'INITREF'), lk('', 'ATCIDX')]]) });
    P.ATCSTAT = () => { const nf = nextFir(), sp0 = sp(); return { title: 'ATC LOGON/STATUS', rows: rows6([[info('ATC COMM', cpOK() ? 'ESTABLISHED' : 'NOT CONNECTED', cpOK() ? 'g' : 'a'), info('FLT NO', F().flt || '-----')], [info('ACTIVE ATC', cpOK() ? (CP.unit || '').toUpperCase().slice(0, 14) : '------'), info('SELCAL', selcal())], [info('THIS FIR', curFir() || '----' + (curOc() ? ' OCEANIC' : '')), info('NEXT FIR', nf ? nf.id + (nf.oc ? ' OCEANIC' : '') : '----')], [info('ADS-C', cpOK() && curOc() ? 'ARMED' : 'OFF'), info('', S.cpdlc ? 'CPDLC ENABLED' : 'CPDLC DISABLED')], [info('', curOc() || (nf && nf.oc) ? 'TYPE CENTRE CODE, THEN LOGON' : ''), null], [lk('<ATC INDEX', 'ATCIDX'), act('', cpOK() ? 'LOGOFF>' : 'LOGON>', () => {
      if (cpOK()) { A.cpLogged = false; return 'ATC LOGOFF'; } if (C.g) return 'LOGON AFTER DEPARTURE';
      const oc = curOc() || (nf && nf.oc); if (oc) { const v = sp0.toUpperCase(); if (!v) return 'ENTER CENTRE CODE: ' + [curFir(), nf && nf.id].filter(Boolean).join(' OR '); if (![curFir(), nf && nf.id].includes(v)) return 'INVALID ATC CODE'; L.cdus[L.state.cur].sp = ''; cpLogon({ name: firName(v) }); return 'ATC COMM ESTABLISHED'; }
      if (A.stn) { cpLogon(A.stn); return 'ATC COMM ESTABLISHED'; } return 'NO ATC STATION'; })]]) }; };
    P.ATCPOS = () => { const d = posData(); return { title: 'POS REPORT', rows: rows6([[info('POSITION', d.id + '  ' + d.t + 'Z'), info('ALT', altT(d.alt))], [info('NEXT', d.next + '  ' + d.nextEta + 'Z'), null], [info('NEXT+1', d.next2), null], [info('', A.posDue ? 'REPORT DUE' : 'NOT DUE', A.posDue ? 'm' : ''), null], null, [lk('<ATC INDEX', 'ATCIDX'), act('', 'SEND>', () => { sendPos(); return cpOK() ? 'POSITION REPORT SENT' : 'REPORT SENT BY VOICE'; }, 'g')]]) }; };
    P.ATCUPL = c => {
      const ups = CP.msgs.filter(m => m.dir === 'UP'); const m = ups[c.pg] || null, rows = [];
      if (!m) return { title: 'ATC UPLINK', count: 1, rows: rows6([[info('', 'NO UPLINK MESSAGES'), null], null, null, null, null, [lk('<ATC INDEX', 'ATCIDX'), null]]) };
      const t = wrap(m.txt); for (let i = 0; i < 4; i++) rows.push([info(i === 0 ? m.st + ' ' + new Date(m.t).toISOString().slice(11, 16) + 'Z' : '', t[i] || '', i === 0 && m.st === 'NEW' ? 'm' : ''), null]); rows.push([null, null]);
      const open = m.st === 'NEW' || m.st === 'STANDBY'; rows.push([open ? act('', '<REJECT', () => { cpRespond(m.id, 'UNABLE'); return 'UNABLE SENT'; }) : lk('<ATC INDEX', 'ATCIDX'), open ? act('', m.resp === 'WU' ? 'ACCEPT>' : 'ROGER>', () => { cpRespond(m.id, m.resp === 'WU' ? 'WILCO' : 'ROGER'); return 'RESPONSE SENT'; }, 'g') : null]);
      if (open) rows[4] = [act('', 'STANDBY', () => { cpRespond(m.id, 'STANDBY'); return 'STANDBY SENT'; }), null]; return { title: 'ATC UPLINK ' + (c.pg + 1) + '/' + ups.length, count: ups.length, rows: rows6(rows) };
    };
    P.ATCREQ = () => ({ title: 'ATC REQUEST', rows: rows6([[act('ALTITUDE', '', () => { const v = sp(); const a = /^FL(\d{2,3})$/.test(v) ? +v.slice(2) * 100 : /^\d{4,5}$/.test(v) ? +v : 0; if (!a) return 'ENTER FLxxx OR ALTITUDE IN SCRATCHPAD'; L.cdus[L.state.cur].sp = ''; cpRequest('alt', a); return 'REQUEST SENT'; }), null], [act('DIRECT TO', '', () => { const v = sp().toUpperCase(); if (!v) return 'ENTER WAYPOINT IN SCRATCHPAD'; L.cdus[L.state.cur].sp = ''; cpRequest('dct', v); return 'REQUEST SENT'; }), null], [act('', '<WEATHER DEVIATION', () => { cpRequest('free', 'weather deviation'); return 'REQUEST SENT'; }), null], null, null, [lk('<ATC INDEX', 'ATCIDX'), lk('LOG>', 'ATCLOG')]]) });
    P.ATCLOG = c => { const all = CP.msgs, per = 4, m = all.slice(c.pg * per, c.pg * per + per), rows = []; m.forEach(x => rows.push([info((x.dir === 'UP' ? 'UPLINK ' : 'DOWNLINK ') + new Date(x.t).toISOString().slice(11, 16) + 'Z', (x.txt || '').slice(0, 24), x.dir === 'UP' ? 'g' : ''), info('', x.st || '')])); while (rows.length < 5) rows.push([null, null]); rows.push([lk('<ATC INDEX', 'ATCIDX'), null]); return { title: 'ATC LOG', count: Math.max(1, Math.ceil(all.length / per)), rows: rows6(rows) }; };
    L.keypage.atc = 'ATCIDX'; return true;
  }

  /* ═══════════════ airspace: which FIR am I in, and who is nearby ═══════════════ */
  // Boundaries: VATSpy FIR boundary data (public GitHub dataset). Frequencies for en-route sectors are NOT in any free dataset, so you save one per FIR; airport frequencies are real (OurAirports).
  const AIR = { fir: [], names: {}, ready: false, loading: false, tried: false, cur: [], prev: null, err: '', near: [], nearT: 0 };
  const BURL = 'https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/';
  const idb = (mode, fn) => new Promise((res, rej) => { const rq = indexedDB.open('geofsATC.air', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('k'); rq.onerror = () => rej(rq.error); rq.onsuccess = () => { const tx = rq.result.transaction('k', mode), r = fn(tx.objectStore('k')); tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); }; });
  async function loadAirspace(force) {
    if (AIR.loading || (AIR.ready && !force)) return; AIR.loading = true; AIR.tried = true; AIR.err = '';
    try {
      let c = null; if (!force) { try { c = await idb('readonly', st => st.get('v3')); } catch (e) { /* no cache */ } }
      if (c && c.fir && c.fir.length) { AIR.fir = c.fir; AIR.names = c.names || {}; }
      else {
        const [rb, rf] = await Promise.all([fetch(BURL + 'Boundaries.geojson'), fetch(BURL + 'FIRs.dat')]); if (!rb.ok) throw new Error('boundaries HTTP ' + rb.status);
        const gj = await rb.json(), names = {}; if (rf.ok) (await rf.text()).split(/\r?\n/).forEach(l => { if (!l || l[0] === ';' || l[0] === '[') return; const f = l.split('|'); if (f.length > 1 && /^[A-Z0-9]{2,5}$/.test(f[0])) names[f[0]] = f[1]; });
        const fir = []; (gj.features || []).forEach(ft => { const pr = ft.properties || {}, id = pr.id || pr.ICAO, g = ft.geometry; if (!id || !g) return; const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; const P = polys.map(poly => poly.map(r => { const o = r.map(q => [Math.round(q[1] * 1000) / 1000, Math.round(q[0] * 1000) / 1000]); for (let i = 1; i < o.length; i++) { while (o[i][1] - o[i - 1][1] > 180) o[i][1] -= 360; while (o[i][1] - o[i - 1][1] < -180) o[i][1] += 360; } return o; })); let b = [90, 180, -90, -180]; P.forEach(poly => poly[0].forEach(q => { b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])]; })); fir.push({ id, b, P, oc: pr.oceanic === true || String(pr.oceanic) === '1' }); });
        if (!fir.length) throw new Error('no boundaries in the file'); AIR.fir = fir; AIR.names = names; try { await idb('readwrite', st => st.put({ fir, names }, 'v3')); } catch (e) { /* cache optional */ }
      }
      AIR.ready = true; log('SYS', 'Airspace boundaries loaded (' + AIR.fir.length + ' regions)');
    } catch (e) { AIR.err = e.message; log('SYS', 'Airspace data: ' + e.message); }
    AIR.loading = false; drawTab();
  }
  const pip = (r, la, lo) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > lo) !== (b[1] > lo) && la < ((b[0] - a[0]) * (lo - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const firAt = p => AIR.fir.filter(f => [0, 360, -360].some(o => { const lo = p.lon + o; return p.lat >= f.b[0] && p.lat <= f.b[2] && lo >= f.b[1] && lo <= f.b[3] && f.P.some(poly => pip(poly[0], p.lat, lo) && !poly.slice(1).some(h => pip(h, p.lat, lo))); }));
  const firName = id => { const n = AIR.names[id]; return (n || id) + (n && !/control|radar|centre|center|info/i.test(n) ? ' Control' : ''); };
  const curFir = () => (AIR.cur[0] ? AIR.cur[0].id : '');
  function ctrInfo() { const id = curFir(), f = id && S.firFreq[id], h = id && S.firHF[id]; if (h && curOc()) return { freq: h, name: firName(id), sim: false, hf: true }; return f ? { freq: f, name: firName(id), sim: false } : { freq: Math.round(ctrFreq() * 40) / 40, name: id ? firName(id) : 'Control', sim: true }; }
  const curOc = () => AIR.cur.some(f => f.oc);
  function nextFir() { const c = C; if (!c || !c.p || !AIR.ready) return null; const q = dest(c.p, c.hdg, Math.max(120, c.gs) * 0.5); return firAt(q).find(x => x.id !== curFir()) || null; }
  function airTick(c) {
    if (c.p) { const L = MAPV.trail[MAPV.trail.length - 1]; if (!L || Math.abs(L[0] - c.p.lat) + Math.abs(L[1] - c.p.lon) > .002) { MAPV.trail.push([c.p.lat, c.p.lon]); if (MAPV.trail.length > 400) MAPV.trail.shift(); } }
    if (S.open && S.tab === 'AIRSPACE') mapDraw();
    if (!AIR.tried) loadAirspace(); if (!AIR.ready || !c.p) return; AIR.cur = firAt(c.p); const id = curFir();
    if (id !== AIR.prev) { const first = AIR.prev === null; AIR.prev = id; if (!first) { chime('cpdlc'); const f = id && S.firFreq[id]; log('SYS', id ? 'Entering ' + firName(id) + ' (' + id + ' FIR).' + (f ? ' Contact on ' + f.toFixed(3) + '.' : ' No frequency saved for it: open the AIRSPACE tab.') : 'Leaving all known FIRs.'); if (A.ph === 'ctr') { setStn('CTR', 'o'); } if (curOc()) log('SYS', 'OCEANIC AIRSPACE: log on by CPDLC with the centre code ' + id + ' (CDU ATC > LOGON/STATUS), make position reports at every waypoint, and tune HF' + (S.firHF[id] ? ' ' + S.firHF[id].toFixed(3) : ' (save the HF frequency on the AIRSPACE tab)') + '. Your SELCAL is ' + selcal() + '.'); } }
    if (AIDX && now() - AIR.nearT > 20000) { AIR.nearT = now(); AIR.near = nearest(c.p, 4).filter(n => n.d < 90); AIR.near.forEach(n => ensure(n.i)); }
  }
  /* ── live airspace map (canvas): FIR boundaries, route, airports, traffic, your aircraft ── */
  const MAPV = { k: 18, follow: true, lat: 0, lon: 0, trail: [], sel: '', raf: 0, cv: null, drag: null };
  function mapEnsure() {
    if (MAPV.cv) return MAPV.cv; const cv = document.createElement('canvas'); cv.style.cssText = 'width:100%;height:320px;display:block;border-radius:8px;background:#06090c;touch-action:none;cursor:grab'; MAPV.cv = cv;
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel'].forEach(t => cv.addEventListener(t, e => e.stopPropagation(), { passive: false }));
    cv.addEventListener('pointerdown', e => { MAPV.drag = { x: e.clientX, y: e.clientY, m: false, lat: MAPV.lat, lon: MAPV.lon }; try { cv.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
    cv.addEventListener('pointermove', e => { const d = MAPV.drag; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y; if (!d.m && Math.abs(dx) + Math.abs(dy) < 6) return; d.m = true; if (MAPV.follow) { MAPV.follow = false; const p = (C && C.p) || { lat: 0, lon: 0 }; d.lat = MAPV.lat = p.lat; d.lon = MAPV.lon = p.lon; } const lat0 = d.lat; MAPV.lon = d.lon - dx / (MAPV.k * Math.max(.2, Math.cos(lat0 * RAD))); MAPV.lat = clamp(d.lat + dy / MAPV.k, -85, 85); mapDraw(); });
    cv.addEventListener('pointerup', e => { const d = MAPV.drag; MAPV.drag = null; if (d && !d.m) mapTap(e); });
    cv.addEventListener('wheel', e => { e.preventDefault(); mapZoom(e.deltaY < 0 ? 1.25 : .8); }, { passive: false });
    return cv;
  }
  const mapZoom = f => { MAPV.k = clamp(MAPV.k * f, 2, 600); mapDraw(); };
  function mapProj() { const cv = MAPV.cv, r = cv.getBoundingClientRect(), w = Math.max(200, r.width), h = Math.max(150, r.height), c = C && C.p, lat0 = MAPV.follow && c ? c.lat : MAPV.lat, lon0 = MAPV.follow && c ? c.lon : MAPV.lon, kx = MAPV.k * Math.max(.2, Math.cos(lat0 * RAD)); return { w, h, lat0, lon0, X: lo => w / 2 + (((lo - lon0 + 540) % 360) - 180) * kx, Y: la => h / 2 - (la - lat0) * MAPV.k, inv: (x, y) => ({ lat: lat0 - (y - h / 2) / MAPV.k, lon: lon0 + (x - w / 2) / kx }) }; }
  function mapTap(e) { const cv = MAPV.cv, r = cv.getBoundingClientRect(), P = mapProj(), q = P.inv(e.clientX - r.left, e.clientY - r.top), f = AIR.ready ? firAt(q)[0] : null; MAPV.sel = f ? firName(f.id) + ' (' + f.id + ')' + (S.firFreq[f.id] ? ' - ' + S.firFreq[f.id].toFixed(3) : ' - no frequency saved') : ''; mapDraw(); }
  function mapDraw() {
    if (!MAPV.cv || !MAPV.cv.isConnected) return; if (MAPV.raf) return; MAPV.raf = requestAnimationFrame(() => { MAPV.raf = 0; try { mapPaint(); } catch (e) { /* never break the page */ } });
  }
  function mapPaint() {
    const cv = MAPV.cv, P = mapProj(), dpr = Math.min(2, window.devicePixelRatio || 1); if (cv.width !== Math.round(P.w * dpr) || cv.height !== Math.round(P.h * dpr)) { cv.width = Math.round(P.w * dpr); cv.height = Math.round(P.h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, P.w, P.h); g.font = '600 10px system-ui,sans-serif';
    const tl = P.inv(0, 0), br = P.inv(P.w, P.h), view = { s: br.lat, n: tl.lat, w: tl.lon, e: br.lon }, inView = (la, lo) => la >= view.s && la <= view.n && lo >= view.w && lo <= view.e;
    // graticule
    const step = MAPV.k > 60 ? 1 : MAPV.k > 20 ? 5 : 10; g.strokeStyle = '#13202b'; g.lineWidth = 1; g.beginPath(); for (let la = Math.ceil(view.s / step) * step; la <= view.n; la += step) { g.moveTo(0, P.Y(la)); g.lineTo(P.w, P.Y(la)); } for (let lo = Math.ceil(view.w / step) * step; lo <= view.e; lo += step) { g.moveTo(P.X(lo), 0); g.lineTo(P.X(lo), P.h); } g.stroke();
    const here = C && C.p ? curFir() : '';
    if (AIR.ready) {
      const kx = MAPV.k * Math.max(.2, Math.cos(P.lat0 * RAD)), Xu = (lo, off) => P.w / 2 + (lo + off - P.lon0) * kx;
      AIR.fir.forEach(f => { if (f.b[2] < view.s || f.b[0] > view.n) return; const mine = f.id === here; [-360, 0, 360].forEach(off => { if (f.b[3] + off < view.w || f.b[1] + off > view.e) return;
        g.beginPath(); f.P.forEach(poly => { const r = poly[0], st = Math.max(1, Math.floor(r.length / 600), MAPV.k < 8 ? 3 : 1); for (let i = 0; i < r.length; i += st) { const x = Xu(r[i][1], off), y = P.Y(r[i][0]); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); });
        if (mine) { g.fillStyle = 'rgba(76,208,240,.12)'; g.fill(); } g.setLineDash(f.oc ? [6, 4] : []); g.strokeStyle = mine ? '#4cd0f0' : f.oc ? '#8f7bd9' : '#3a6a85'; g.lineWidth = mine ? 2 : 1; g.stroke(); g.setLineDash([]);
        const cla = (f.b[0] + f.b[2]) / 2, x = Xu((f.b[1] + f.b[3]) / 2, off), y = P.Y(cla); if (x < 10 || y < 10 || x > P.w - 10 || y > P.h - 10 || (f.b[2] - f.b[0]) * MAPV.k < 26) return; g.textAlign = 'center'; g.fillStyle = mine ? '#9fe8ff' : f.oc ? '#b3a3f0' : '#7fa6bd'; g.fillText(f.id, x, y); if (MAPV.k > 26 && AIR.names[f.id]) { g.fillStyle = '#5d7d90'; g.fillText(AIR.names[f.id], x, y + 11); } }); }); }
    // airports
    if (AIDX && MAPV.k > 14) { g.textAlign = 'left'; AIDX.forEach(a => { if (!a[5] && MAPV.k < 70) return; if (!inView(a[2], a[3])) return; const x = P.X(a[3]), y = P.Y(a[2]); g.fillStyle = '#e8c36a'; g.fillRect(x - 2, y - 2, 4, 4); if (MAPV.k > 30) { g.fillText(a[0], x + 5, y + 3); } }); }
    // route
    const legs = (F().legs || []).filter(l => isFinite(l.lat) && isFinite(l.lon)); if (legs.length) { g.strokeStyle = '#d65cff'; g.lineWidth = 1.5; g.beginPath(); legs.forEach((l, i) => { const x = P.X(l.lon), y = P.Y(l.lat); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.fillStyle = '#d65cff'; legs.forEach(l => { const x = P.X(l.lon), y = P.Y(l.lat); g.fillRect(x - 2, y - 2, 4, 4); if (MAPV.k > 40) g.fillText(l.id, x + 4, y - 3); }); }
    // traffic
    if (C && C.p) TC.targets.forEach(t => { const q = dest(C.p, t.b, t.r), x = P.X(q.lon), y = P.Y(q.lat); g.fillStyle = t.ra ? '#ff3b30' : t.ta ? '#ffb020' : '#e6edf2'; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 4, y); g.lineTo(x, y + 5); g.lineTo(x - 4, y); g.closePath(); g.fill(); if (MAPV.k > 40) g.fillText(String(t.cs).slice(0, 8), x + 6, y + 3); });
    // trail + aircraft
    if (MAPV.trail.length > 1) { g.strokeStyle = '#6dff9d'; g.lineWidth = 1.5; g.beginPath(); MAPV.trail.forEach((q, i) => { const x = P.X(q[1]), y = P.Y(q[0]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); }
    if (C && C.p) { const x = P.X(C.p.lon), y = P.Y(C.p.lat); g.save(); g.translate(x, y); g.rotate(C.hdg * RAD); g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 8); g.lineTo(0, 4); g.lineTo(-6, 8); g.closePath(); g.fill(); g.stroke(); g.restore(); }
    g.textAlign = 'left'; g.fillStyle = '#9fb3c0'; g.fillText((MAPV.follow ? 'FOLLOWING' : 'PANNED') + '  ·  dashed purple = oceanic', 8, 14); g.fillText((111.2 / MAPV.k * 50).toFixed(0) + ' km ┣━━━┫', 8, P.h - 8);
    if (MAPV.sel) { g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(6, P.h - 44, Math.min(P.w - 12, g.measureText(MAPV.sel).width + 14), 20); g.fillStyle = '#fff'; g.fillText(MAPV.sel, 13, P.h - 30); }
  }
  function mapAttach() { const slot = $('#gfa-mapslot'); if (!slot) return; slot.appendChild(mapEnsure()); mapDraw(); }

  const oceanicList = () => { const seen = {}; AIR.fir.filter(f => f.oc).forEach(f => { seen[f.id] = AIR.names[f.id] || ''; }); return Object.keys(seen).sort().map(id => [id, seen[id]]); };
  const oceanicText = () => 'ICAO\tNAME\n' + oceanicList().map(r => r.join('\t')).join('\n') + '\n';
  function dlText(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800); }
  function setRadio(mhz, which) { const r = radios()[micIdx() >= 0 ? micIdx() : 0]; if (!r) return log('SYS', 'Lower Panel radios not found'); if (which === 'stby') { r.stby = Math.round(mhz * 1000); safe(() => LO().refresh()); log('SYS', mhz.toFixed(3) + ' set in standby (press XFER)'); } else tune(mhz); drawTab(); }
  function airHtml() {
    const c = C, id = curFir(); let h = '<div id="gfa-mapslot"></div><div class="gar"><button data-a="mapz+">＋ ZOOM</button><button data-a="mapz-">－ ZOOM</button><button data-a="mapfollow" class="' + (MAPV.follow ? 'on' : '') + '">FOLLOW ME</button><button data-a="maptrail">CLEAR TRAIL</button></div>';
    if (!AIR.ready) h += `<div class="gacard">${AIR.loading ? 'Loading airspace boundaries…' : esc(AIR.err ? 'Could not load airspace boundaries: ' + AIR.err : 'Airspace boundaries not loaded.')} <button data-a="airload">${AIR.err ? 'RETRY' : 'LOAD'}</button></div>`;
    else h += `<div class="gastn"><div class="gah" style="margin-top:0">YOU ARE IN</div><b style="font-size:15px">${id ? esc(firName(id)) : 'No FIR found here'}</b> ${id ? '(' + esc(id) + ')' : ''}${AIR.cur.length > 1 ? '<br><span class="gan">Also: ' + AIR.cur.slice(1).map(f => esc(f.id)).join(', ') + '</span>' : ''}<div class="gan">${c && c.p ? c.p.lat.toFixed(2) + '°, ' + c.p.lon.toFixed(2) + '°' : ''}</div>
      ${id ? `<div class="gar"><label>${esc(id)} FREQ <input type="text" id="gfa-ff" inputmode="decimal" size="8" maxlength="7" placeholder="1xx.xxx" value="${S.firFreq[id] ? S.firFreq[id].toFixed(3) : ''}"></label><button data-a="ffsave">SAVE</button>${S.firFreq[id] ? '<button class="go" data-a="ffact">TUNE NOW</button><button data-a="ffstby">TO STANDBY</button>' : ''}</div><div class="gan">En-route sector frequencies are not in any free dataset. Look it up once (charts or the EFB) and save it here. The frequency is remembered for this FIR, ATC uses it for Control, and you get an alert when you cross into a new FIR.</div><div class="gar"><label>HF MHz <input type="text" id="gfa-fh" inputmode="decimal" size="8" maxlength="7" placeholder="5.649" value="${S.firHF[id] ? S.firHF[id].toFixed(3) : ''}"></label><button data-a="ffhsave">SAVE HF</button>${S.firHF[id] ? '<button class="go" data-a="ffhact">TUNE HF</button>' : ''}</div><div class="gan">Oceanic centres are worked on HF. When this FIR is oceanic and an HF frequency is saved, Control uses it and you must tune an HF radio and select its mic.</div>` : ''}</div>`;
    h += '<div class="gah">NEARBY AIRPORTS (REAL FREQUENCIES)</div>';
    h += AIR.near.map(n => { const a = AP(n.i), fr = a ? a.freqs.filter(f => /^(ATIS|CLD|GND|TWR|DEP|APP|A\/D|ATF|CTAF|UNIC)$/.test(f.type)) : []; return `<div class="gacard"><b>${esc(n.i)}</b> ${esc(n.n)} · ${n.d.toFixed(0)} NM · BRG ${pad(Math.round(n.b), 3)}°<div class="gar">${fr.length ? fr.map(f => `<button data-tf="${f.mhz}:act" title="Tune">${esc(f.type)} ${f.mhz.toFixed(3)}</button>`).join('') : '<span class="gan">' + (a ? 'no frequencies listed' : 'loading…') + '</span>'}</div></div>`; }).join('') || '<div class="gan">No airport within 90 NM.</div>';
    { const ol = AIR.ready ? oceanicList() : []; h += '<div class="gah">OCEANIC CENTRES (' + ol.length + ')</div>' + (ol.length ? '<div class="gar"><button data-a="ocopy">COPY LIST</button><button data-a="odl">DOWNLOAD .TXT</button></div><div class="gacard" style="max-height:140px;overflow:auto">' + ol.map(r => '<b>' + esc(r[0]) + '</b> ' + esc(r[1])).join('<br>') + '</div>' : '<div class="gan">Load the airspace boundaries to list them.</div>'); }
    return h + '<div class="gan">Tap a frequency to tune it on the mic radio. Boundaries are public FIR data, so they follow real-world regions, not GeoFS.</div>';
  }

  /* ═══════════════ TCAS (multiplayer traffic) ═══════════════ */
  const TC = { targets: [], prev: {}, ra: null, ta: false, adv: '', probe: '' };
  function userLLA(u) {
    const cands = [() => u.referencePoint && u.referencePoint.lla, () => u.lastUpdate && u.lastUpdate.co, () => u.coordinates, () => u.lla, () => u.co];
    for (const f of cands) { const v = safe(f, null); if (Array.isArray(v) && isFinite(v[0]) && isFinite(v[1])) return { lat: v[0], lon: v[1], alt: (isFinite(v[2]) ? v[2] : 0) * 3.28084 }; } return null;
  }
  const usersList = () => { const m = safe(() => multiplayer.visibleUsers, null); if (Array.isArray(m)) return m; if (m && typeof m === 'object') return Object.values(m); const u = safe(() => multiplayer.users, null); return u ? Object.values(u) : []; };
  function tcasTick() {
    const c = C; if (!c || !c.p) return; const mode = xp() ? xp().mode : 0, t = now(), out = [];
    usersList().forEach((u, i) => { const l = userLLA(u); if (!l) return; const id = String(u.id || u.acid || u.callsign || i); if (u.id === safe(() => multiplayer.myId, -1)) return; const p = { lat: l.lat, lon: l.lon }, r = gcd(c.p, p), b = brg(c.p, p), rel = l.alt - c.alt; if (r > 40) return; const pv = TC.prev[id]; let cl = 0; if (pv && t - pv.t > 300) { cl = (pv.r - r) * 3600 / ((t - pv.t) / 1000); } if (!pv || t - pv.t > 900) TC.prev[id] = { r, t };
      const tau = cl > 20 ? r / cl * 3600 : 9999, ta = r < 6 && Math.abs(rel) < 1200 && tau < 48, ra = r < 3.5 && Math.abs(rel) < 800 && tau < 30; out.push({ id, cs: u.callsign || u.name || id, r, b, rel, tau, ta, ra, prox: r < 6 && Math.abs(rel) < 1200 }); });
    TC.targets = out; const armed = S.tcas && mode >= 3 && !c.g && c.a > 1000, ras = out.filter(x => x.ra), tas = out.filter(x => x.ta && !x.ra);
    if (armed && mode >= 4 && ras.length) { const x = ras.sort((a, b) => a.tau - b.tau)[0], adv = x.rel > 100 ? 'Descend, descend' : 'Climb, climb'; if (TC.ra !== adv) { TC.ra = adv; TC.adv = 'RA: ' + adv.toUpperCase(); chime('ra'); if (S.tcasAlerts) speak(adv, { key: 'TCAS', rate: 1.25, pitch: 1.1 }); log('TCAS', 'RESOLUTION ADVISORY - ' + adv); } }
    else if (TC.ra) { TC.ra = null; TC.adv = ''; if (S.tcasAlerts) speak('Clear of conflict', { key: 'TCAS', rate: 1.15 }); log('TCAS', 'Clear of conflict'); }
    if (armed && tas.length && !TC.ta && !TC.ra) { TC.ta = true; TC.adv = 'TA: TRAFFIC'; if (S.tcasAlerts) speak('Traffic, traffic', { key: 'TCAS', rate: 1.2 }); log('TCAS', 'TRAFFIC ADVISORY ' + tas[0].cs + ' ' + tas[0].r.toFixed(1) + ' NM'); } else if (!tas.length && TC.ta) { TC.ta = false; if (!TC.ra) TC.adv = ''; }
  }
  function tcasProbe() { const us = usersList(); const u = us[0]; TC.probe = 'users=' + us.length + (u ? ' keys=' + Object.keys(u).slice(0, 14).join(',') + ' lla=' + JSON.stringify(userLLA(u)) : '') + ' | multiplayer=' + typeof safe(() => multiplayer, undefined); log('SYS', 'TCAS probe: ' + TC.probe); console.log('[ATC] tcas probe', us); drawTab(); }

  /* ═══════════════ gate spawner (OpenStreetMap) ═══════════════ */
  const GD = {}; // icao -> {gates:[{ref,lat,lon,t}], twys:[{ref,p}], at}
  const OVP = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  async function loadGates(icao) {
    icao = (icao || '').toUpperCase(); await ensure(icao); const a = AP(icao); if (!a) throw new Error('Load the airport first (NAV DATA tab / enter ICAO)'); if (GD[icao]) return GD[icao];
    try { const c = JSON.parse(localStorage.getItem('geofsATC.gd2.' + icao) || 'null'); if (c && c.gates) return (GD[icao] = c); } catch (e) { /* ignore */ }
    const d = .035, bb = `${(a.lat - d).toFixed(5)},${(a.lon - d).toFixed(5)},${(a.lat + d).toFixed(5)},${(a.lon + d).toFixed(5)}`, qq = `[out:json][timeout:30];(node["aeroway"~"^(gate|parking_position)$"](${bb});way["aeroway"~"^(gate|parking_position)$"](${bb});way["aeroway"="taxiway"]["ref"](${bb}););out geom tags;`; let j = null, last = null;
    for (const u of OVP) { try { const r = await fetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(qq), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); if (!r.ok) throw new Error('HTTP ' + r.status); j = await r.json(); break; } catch (e) { last = e; } } if (!j) throw last || new Error('download failed');
    const gates = [], twys = []; (j.elements || []).forEach(e => { const t = e.tags || {}; if (t.aeroway === 'taxiway' && e.geometry) twys.push({ ref: t.ref, p: e.geometry.map(g => [+g.lat.toFixed(5), +g.lon.toFixed(5)]) }); else if (t.aeroway === 'gate' || t.aeroway === 'parking_position') { let lat, lon; if (e.type === 'node') { lat = e.lat; lon = e.lon; } else if (e.geometry && e.geometry.length) { lat = e.geometry.reduce((s, g) => s + g.lat, 0) / e.geometry.length; lon = e.geometry.reduce((s, g) => s + g.lon, 0) / e.geometry.length; } else return; gates.push({ ref: t.ref || t.name || '', lat: +lat.toFixed(6), lon: +lon.toFixed(6), t: t.aeroway, dir: t.direction ? parseFloat(t.direction) : null }); } });
    const g = { gates: gates.filter(x => x.ref), twys, at: now() }; GD[icao] = g; try { localStorage.setItem('geofsATC.gd2.' + icao, JSON.stringify(g)); } catch (e) { /* storage full */ } return g;
  }
  function gateHeading(g, G) { if (g.dir != null && isFinite(g.dir)) return Math.round(g.dir); let best = null, bd = 1e9; G.twys.forEach(w => w.p.forEach(q => { const d = gcd({ lat: g.lat, lon: g.lon }, { lat: q[0], lon: q[1] }); if (d < bd) { bd = d; best = q; } })); return best ? Math.round(brg({ lat: best[0], lon: best[1] }, { lat: g.lat, lon: g.lon })) : 0; } // nose-in: facing from the taxiway toward the stand
  async function teleport(lat, lon, hdg, elevFt) {
    const log2 = []; const near = () => { const p = pos(); return p ? gcd(p, { lat, lon }) * 1852 : 1e9; }; const sl = ms => new Promise(r => setTimeout(r, ms));
    try { if (typeof geofs.flyTo === 'function') { geofs.flyTo([lat, lon, S.spawnAlt, hdg], true); await sl(900); log2.push('flyTo ' + Math.round(near()) + ' m'); if (near() < 60) return log2.join('; ') + ' OK'; } } catch (e) { log2.push('flyTo error ' + e.message); }
    try { const I = inst(); I.llaLocation = [lat, lon, (elevFt || 0) * .3048 + 5 + S.spawnAlt]; if (Array.isArray(I.htr)) I.htr[0] = hdg * RAD; const rb = I.rigidBody; if (rb) Object.keys(rb).filter(k => /velocity|angular/i.test(k)).forEach(k => { if (Array.isArray(rb[k])) for (let i = 0; i < rb[k].length; i++) rb[k][i] = 0; }); await sl(700); log2.push('direct ' + Math.round(near()) + ' m'); if (near() < 60) return log2.join('; ') + ' OK'; } catch (e) { log2.push('direct error ' + e.message); }
    throw new Error('Teleport did not take effect (' + log2.join('; ') + '). GeoFS may have changed - tell me this message.');
  }
  async function spawn(icao, g, hdgOverride) {
    const G = GD[icao], hdg = hdgOverride != null && hdgOverride !== '' ? ((+hdgOverride % 360) + 360) % 360 : gateHeading(g, G), a = AP(icao); log('SYS', 'Spawning at gate ' + g.ref + ' heading ' + hdg + '…');
    const res = await teleport(g.lat, g.lon, hdg, a ? a.elev : 0); log('SYS', 'Spawn: ' + res); try { await GeoFSReal.parking(true, true); } catch (e) { /* ignore */ } try { OV().pressTo('eng', false, true); } catch (e) { /* ignore */ }
    const f = F(); if (LO()) { f.orig = icao; safe(() => LO().save()); } newFlight(); A.gate = g.ref; A.t.stn = now(); log('ATC', 'At gate ' + g.ref + ' - request clearance on ' + clsFor(A.stn)); drawTab();
  }

  /* ═══════════════ main loop ═══════════════ */
  function newFlight() { Object.assign(A, { ph: mode() === 'VFR' ? 'gnd' : 'cd', stn: null, as: { alt: null, hdg: null, spd: null, sq: '', rwy: '', sid: '' }, checked: false, t: {}, busy: false, everAir: false, landed: false, maxAlt: 0, push: false, taxi: false, lined: false, cleared: false, ldgClr: false, vec: 0, go: 0, warn: {}, emg: null, divert: '', cpLogged: false, joinPt: null, arrRwy: '', cdDone: false }); setStn(A.ph === 'gnd' ? 'GND' : 'CLD', 'o'); log('SYS', 'New flight (' + mode() + ')'); }
  async function tick() {
    C = T(); const c = C; statBar(); airTick(c); safe(() => posWatch(c)); if (!c.p) return;
    if (!c.g) { A.everAir = true; A.maxAlt = Math.max(A.maxAlt, c.alt); }
    if (!A.stn) setStn(mode() === 'VFR' ? 'GND' : 'CLD', 'o');
    if (A.ph === 'cd' && mode() === 'VFR') { A.ph = 'gnd'; setStn('GND', 'o'); }
    // origin / destination from the CDU, or the nearest airport
    if (AIDX && now() - (A.t.near || 0) > 5000) { A.t.near = now(); const n = nearest(c.p, 1)[0]; if (n) { A.nearest = n; if (c.g && !A.everAir && n.d < 4 && !F().orig) A.origNear = n.i; if (!c.g && !F().dest && c.a < 6000 && n.d < 25 && A.everAir && !A.destNear) A.destNear = n.i; } }
    [oIcao(), dIcao()].forEach(i => ensure(i)); if (A.nearest && !AP(A.nearest.i) && A.nearest.d < 10) ensure(A.nearest.i);
    // squawk watch: emergency codes and VFR/IFR mode changes
    const code = sq(); if (code !== A.lastSq) { const prev = A.lastSq; A.lastSq = code; if (prev) { if (code === '7700' && !A.emg) declare('MAYDAY'); else if (code === '7600' && !A.t.sq7600) { A.t.sq7600 = now(); log('ATC', 'Squawk 7600 (radio failure) seen - transmitting blind; ATC will watch for you'); atcTx(A.stn || station('CTR', 'o'), csT() + ' squawk seven six zero zero observed, acknowledge by ident.'); } else if (vfrList().includes(code) && A.ph === 'cd') { log('SYS', 'VFR code ' + code + ' - switched to VFR handling'); } } }
    if (A.emg && A.emg.st === 1 && now() - A.emg.t > 40000 && !A.t.emgNag) { A.t.emgNag = now(); atcTx(A.stn || station('CTR', 'o'), csT() + ' say souls on board, fuel remaining and intentions.'); }
    if (A.rb && !A.rb.nag && now() - A.rb.t > 45000 && !A.busy) { A.rb.nag = true; atcTx(A.rb.stn, csT() + ' confirm you received.'); }
    if (A.busy) return;
    A.busy = true; try {
      const stn = A.stn; // retry of unheard handoffs / checks of silence
      if (stn && S.needTune && stn.freq != null && !stnHeard(stn) && A.checked === false && A.ph !== 'cd') { /* waiting for the pilot to tune */ }
      if (stn && A.ph !== 'vfr' && stnHeard(stn) && A.checked === false && S.auto && now() - A.t.stn > 3500 && REQ.checkin.show() && A.ph !== 'gnd' && A.ph !== 'twr') await REQ.checkin.run();
      if (!A.emg || A.emg.st !== 1) { const f = PHASES[A.ph]; if (f) await f(c); }
      await monitor(c);
      if (S.auto && stn && stnTx(stn)) { const r = autoReq(); if (r && now() - (A.t.auto || 0) > 6000) { A.t.auto = now(); await r.run(); } }
    } catch (e) { log('SYS', 'ATC error: ' + e.message); }
    A.busy = false;
  }
  function autoReq() { // which pilot request would the "auto" pilot make now?
    const c = C, r = depRwy(), a = oApt(); const ok = x => x && x.show();
    if (A.ph === 'cd') return ok(REQ.cd) ? REQ.cd : null; if (A.ph === 'gnd') { if (!A.checked && A.stn && false) return null; if (!A.push && !A.taxi && c.g && c.gs < 2 && sw('beacon') === 1) return REQ.push; if (!A.taxi && c.g && c.gs < 2 && C.eng && !C.park) return REQ.taxi; return null; }
    if (A.ph === 'twr' && r && a && c.g && gcd(c.p, thr(r)) < .4 && c.gs < 10 && ok(REQ.rdy)) return REQ.rdy; return null;
  }
  const sw = k => safe(() => OV().state.sw[k], undefined);
  // pilot buttons for the current phase
  const available = () => Object.entries(REQ).filter(([k, r]) => (Array.isArray(r.ph) ? r.ph.includes(A.ph) : r.ph === A.ph) && r.show()).map(([k, r]) => ({ k, label: r.label }));
  async function pilotAct(k) { const r = REQ[k]; if (!r || A.busy) return; A.busy = true; unlock(); try { await r.run(); } catch (e) { log('SYS', 'Error: ' + e.message); } A.busy = false; drawTab(); }

  /* ═══════════════ free-text / spoken transmissions ═══════════════ */
  const DW = { zero: 0, oh: 0, one: 1, two: 2, three: 3, tree: 3, four: 4, five: 5, fife: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9 };
  function norm(t) { // "flight level three five zero" -> "flight level 350"; "four thousand five hundred" -> "4500"
    let x = ' ' + String(t).toLowerCase().replace(/[,;:!?]/g, ' ').replace(/\b(decimal|point|dot)\b/g, '.') + ' ';
    x = x.replace(/\b(zero|oh|one|two|three|tree|four|five|fife|six|seven|eight|nine|niner)\b/g, (m, w) => ' ' + DW[w] + ' ');
    x = x.replace(/(\d+)\s+thousand(?:\s+(\d+)\s+hundred)?/g, (m, a, b) => ' ' + (+a * 1000 + (b ? +b * 100 : 0)) + ' ').replace(/(\d+)\s+hundred/g, (m, a) => ' ' + (+a * 100) + ' ');
    for (let i = 0; i < 6; i++) x = x.replace(/(\d)\s+(?=\d)/g, '$1').replace(/(\d)\s*\.\s*(?=\d)/g, '$1.').replace(/\bfl\s*(\d)/g, 'flight level $1');
    return x.replace(/\s+/g, ' ').trim();
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const csHeard = (raw, n) => { const c = csRaw(), dg2 = c.replace(/\D/g, ''); if (!dg2) return true; if (raw.toUpperCase().replace(/\s+/g, '').includes(c)) return true; const m = /^([A-Z]{3})/.exec(c); if (m && TEL[m[1]] && n.includes(TEL[m[1]].toLowerCase().split(' ')[0]) && n.includes(dg2)) return true; return n.includes(dg2) && /heavy|\b[a-z]{3,}\b/.test(n); };
  const REQMAP = [[/\bclearance\b|ifr clearance/, 'cd'], [/push ?back|start ?up/, 'push'], [/\btaxi\b/, 'taxi'], [/ready|holding short|line ?up|departure/, 'rdy'], [/vacated|clear of the runway|runway vacated/, 'checkin'], [/on frequency|with you|checking in|check in|passing|airborne|inbound|established|good (day|morning|evening|afternoon)/, 'checkin']];
  async function transmit(raw, spoken) {
    raw = String(raw || '').trim(); if (!raw) return; unlock(); const stn = A.stn; if (!stn) return log('SYS', 'No station selected');
    if (!stnTx(stn)) { const i = stn.freq != null ? tunedIdx(stn.freq) : -1; return log('SYS', i >= 0 ? 'Select MIC on VHF ' + (i + 1) + ' to transmit' : 'Not on frequency - tune ' + (stn.freq ? stn.freq.toFixed(3) : '') + ' first'); }
    for (let i = 0; i < 40 && A.busy; i++) await sleep(150); A.busy = true; const c = C || T();
    try {
      const n = norm(raw), pilot = async () => { log('ME', raw); if (!spoken) await speak(raw, { who: 'pilot', key: 'pilot' }); }, say = t => atcTx(stn, t);
      if (/\bmay ?day\b/.test(n)) { A.busy = false; return declare('MAYDAY'); } if (/\bpan[ -]?pan\b/.test(n)) { A.busy = false; return declare('PAN-PAN'); }
      if (S.needCs && !csHeard(raw, n)) { await pilot(); await say('Aircraft calling ' + stn.name + ', say again your callsign.'); return; }
      // 1. readback check
      if (A.rb && now() - A.rb.t < 180000) { const nn = n.replace(/\s/g, ''), hit = A.rb.toks.filter(k => nn.includes(k.replace(/\s/g, ''))); if (hit.length || /wilco|roger|readback|read back|copy/.test(n)) { await pilot(); if (hit.length === A.rb.toks.length) { const ok2 = A.rb.onOk; A.rb = null; if (ok2) await ok2(); else await say(csT() + ' readback correct.'); } else { A.rb.tries++; const t = A.rb.text; if (A.rb.tries >= 3) A.rb = null; await say(csT() + ' negative, I say again. ' + t.replace(csT(), '').trim()); } return; } }
      let m;
      // 2. generic
      if (/say again|repeat|\bcopy last|didn'?t (get|copy)/.test(n)) { await pilot(); if (A.lastAtc) await say(A.lastAtc.text.replace(/^[^,]*,\s*/, '')); else await say(csT() + ' nothing to repeat.'); return; }
      if (/^(unable|negative)\b/.test(n) || /\bunable\b/.test(n) && !/request/.test(n)) { await pilot(); await say(csT() + ' roger, say intentions.'); return; }
      if (/\bstand ?by\b/.test(n) && !/request/.test(n)) { await pilot(); await say(csT() + ' roger.'); return; }
      if (/selcal/.test(n)) { await pilot(); selcalTone(); return say(csT() + ' SELCAL check OK.'); }
      if (/position|estimating/.test(n) && curOc()) { await pilot(); A.posDue = null; return say(csT() + ' roger.'); }
      // 3. scripted requests, in the pilot's own words
      for (const [re, k] of REQMAP) if (re.test(n)) { const av = available().find(a => a.k === k); if (av) { A.custom = { t: raw, spoken }; A.busy = false; await pilotAct(k); return; } break; }
      // 4. free requests
      const dp = ['dep', 'ctr', 'app'].includes(A.ph), f = F(), legs = f.legs || [];
      if (/ident/.test(n) && !/identif/.test(n)) { await pilot(); const x = xp(); if (x) { x.identUntil = now() + 18000; safe(() => LO().refresh()); } await say(csT() + (dp ? ' radar contact.' : ' squawk ident observed.')); return; }
      if (/deviat|weather|around (the )?(weather|cell|build)/.test(n) && !/wind|qnh/.test(n)) { await pilot(); if (A.ph !== 'ctr' && A.ph !== 'dep') return say(csT() + ' unable deviation at this time.'); const d = /left/.test(n) ? 'left' : /right/.test(n) ? 'right' : 'either side'; const mm = /(\d+) ?(nm|miles|mile)/.exec(n); return say(csT() + ' deviation ' + (d === 'either side' ? 'approved' : d + ' of route approved') + ', up to ' + (mm ? dg(mm[1]) : 'two zero') + ' miles, report back on route.'); }
      if (/qnh|altimeter|wind check|\bwind\b|weather|metar/.test(n)) { await pilot(); const ic = ['cd', 'gnd', 'twr'].includes(A.ph) ? oIcao() : dIcao(), wx = WXs(ic); return say(csT() + ' ' + windS(wx) + ', ' + qnhS(wx) + '.'); }
      if (/go ?around|missed approach/.test(n) && ['twr2', 'app'].includes(A.ph)) { await pilot(); const r = arrRwy(), ap = station('APP', 'd'); A.go++; A.ldgClr = false; A.vec = 0; A.t.hoApp = 0; A.t.hoCtr = 1; A.as.alt = 3000; A.as.hdg = null; A.ph = 'app'; await say(csT() + ' roger, fly runway heading' + (r ? ' ' + hdgS(r.hdg) : '') + ', climb ' + altS(3000) + ', contact Approach ' + (ap.freq ? freqS(ap.freq) : '') + '.'); setStn('APP', 'd'); return; }
      if (A.ph === 'twr2' && /final|runway|land|ils|visual|established/.test(n)) { await pilot(); const r = arrRwy(); if (!r) return say(csT() + ' continue approach.'); const xt = xtrack(r, c.p); if (A.ldgClr) return say(csT() + ' runway ' + rwyS(r.id) + ', cleared to land, ' + windS(WXs(dIcao())) + '.'); if (!c.g && xt.along < 8 && xt.along > 0) { A.ldgClr = true; return say(csT() + ' ' + windS(WXs(dIcao())) + ', runway ' + rwyS(r.id) + ', cleared to land.'); } return say(csT() + ' continue approach, report final.'); }
      if ((m = /direct(?: to)? ([a-z0-9]{3,5})/.exec(raw.toLowerCase())) || /next (waypoint|fix|point)/.test(n)) { await pilot(); if (!['ctr', 'dep', 'app'].includes(A.ph)) return say(csT() + ' unable direct, expect further routing on departure.'); const id = m ? m[1].toUpperCase() : (legs[(f.active || 0) + 1] || {}).id; const i = id ? legs.findIndex(l => String(l.id).toUpperCase() === id) : -1; if (i < 0) return say(csT() + ' unable, ' + (id ? phon(id) + ' is not on your filed route' : 'say waypoint') + '.'); if (i <= (f.active || 0)) return say(csT() + ' negative, you have already passed ' + phon(id) + '.'); f.active = i; f.lnav = true; safe(() => LO().save()); safe(() => LO().refresh()); return say(csT() + ' proceed direct ' + phon(id) + '.'); }
      if (/speed|slow|reduce|increase/.test(n) && (m = /(\d{3})/.exec(n))) { await pilot(); const v = +m[1]; if (c.alt < 10000 && v > 250) return say(csT() + ' unable, maximum speed two five zero knots below one zero thousand.'); A.as.spd = v; return say(csT() + ' speed ' + dg(v) + ' knots approved.'); }
      if (/vector|heading/.test(n) && dp) { await pilot(); if ((m = /heading (\d{3})/.exec(n)) && /request/.test(n)) { A.as.hdg = +m[1] % 360; return say(csT() + ' approved, fly heading ' + hdgS(A.as.hdg) + '.'); } const tgt = A.ph === 'app' && arrRwy() ? dest(thr(arrRwy()), (arrRwy().hdg + 180) % 360, 14) : (legs[f.active || 0] ? { lat: legs[f.active || 0].lat, lon: legs[f.active || 0].lon } : null); if (!tgt) return say(csT() + ' say heading required.'); A.as.hdg = Math.round(brg(c.p, tgt) / 5) * 5 % 360; A.t.vec = now(); if (A.ph === 'app' && !A.vec) A.vec = 1; return say(csT() + ' fly heading ' + hdgS(A.as.hdg) + '.'); }
      if (/descen|lower|climb|higher|flight level|request.*\d{4,5}|\bfl\d/.test(n) && ['dep', 'ctr', 'app'].includes(A.ph)) {
        await pilot(); let tgt = null; if ((m = /flight level (\d{2,3})/.exec(n))) tgt = +m[1] * 100; else if ((m = /(\d{4,5})(?: ?(?:ft|feet))?/.exec(n)) && +m[1] >= 1000) tgt = +m[1]; const up = /climb|higher|upgrade/.test(n) || (tgt && tgt > c.alt + 300 && !/descen|lower/.test(n)); if (tgt == null) tgt = up ? Math.min(43000, Math.round((c.alt + 2000) / 1000) * 1000) : Math.round((c.alt - 4000) / 1000) * 1000;
        if (up) { if (tgt > 43000) return say(csT() + ' unable, maximum flight level four three zero.'); if (A.ph === 'app') return say(csT() + ' unable, maintain ' + altS(A.as.alt || c.alt) + '.'); if (A.ph === 'ctr' && Math.random() < .12) return say(csT() + ' unable ' + altS(tgt) + ' due traffic, maintain ' + altS(A.as.alt || c.alt) + ', expect higher in ten minutes.'); A.as.alt = tgt; return say(csT() + ' climb ' + altS(tgt) + '.'); }
        const d = toD(); if (A.ph === 'ctr' && d != null && c.alt - tgt > 4000 && d > ((c.alt - tgt) / 1000) * 3 + 25) return say(csT() + ' unable descent yet, maintain ' + altS(A.as.alt || c.alt) + ', expect descent in ' + dg(Math.round(d - (((c.alt - tgt) / 1000) * 3 + 25))) + ' miles.'); if (tgt < 2000) return say(csT() + ' unable, minimum vectoring altitude two thousand.'); A.as.alt = tgt; return say(csT() + ' descend ' + altS(tgt) + '.');
      }
      // 5. nothing matched - a controller would not guess
      await pilot(); await say(csT() + ' say again.');
    } catch (e) { log('SYS', 'Transmit error: ' + e.message); } finally { A.busy = false; A.custom = null; drawTab(); }
  }
  const interpret = t => transmit(t, true);

  /* ═══════════════ speech recognition (push to talk) ═══════════════ */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; let rec = null;
  function ptt(on) {
    if (!SR) return log('SYS', 'Speech recognition is not available in this browser - use the buttons'); unlock();
    if (!on) { try { rec && rec.stop(); } catch (e) { /* ignore */ } return; }
    try { rec = new SR(); rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1; rec.onresult = e => { const t = String(e.results[0][0].transcript || '').toLowerCase(); log('SYS', 'Heard: "' + t + '"'); transmit(t, true); }; rec.onerror = e => log('SYS', 'Mic: ' + (e.error || 'error')); rec.start(); log('SYS', 'Listening…'); } catch (e) { log('SYS', 'Mic error: ' + e.message); }
  }
  /* ═══════════════ UI ═══════════════ */
  const CSS = `
  #gfa-root,#gfa-root *{box-sizing:border-box}#gfa-root{position:fixed;z-index:99986;display:none;width:min(540px,98vw);font:600 11px system-ui,sans-serif;color:#dde4ea;background:#1d2125;border:2px solid #000;border-radius:10px;box-shadow:0 10px 36px #000c;-webkit-user-select:none;user-select:none;touch-action:manipulation;max-height:calc(100dvh - 16px);display:none;flex-direction:column;overflow:hidden}
  #gfa-root.open{display:flex}#gfa-root.min{width:auto;max-width:92vw}#gfa-root.min .gat,#gfa-root.min .gabody,#gfa-root.min #gfa-log{display:none}.gab{display:flex;align-items:center;gap:6px;padding:5px 8px;background:linear-gradient(#3a3f44,#2a2e32);cursor:grab;touch-action:none;letter-spacing:.12em;font-size:10px}.gab b{flex:1;color:#f1f4f6}
  #gfa-root button{all:unset;cursor:pointer;padding:7px 10px;border-radius:5px;background:#3b4046;border:1px solid #0d0f11;font-size:10px;letter-spacing:.05em;color:#dfe5e9;text-align:center;box-sizing:border-box}#gfa-root button.on{background:#1f3b57;color:#fff}#gfa-root button.go{background:#1d4d2e;color:#bfffd2}#gfa-root button.warn{background:#5a2420;color:#ffd0ca}#gfa-root button.amb{background:#5a4a14;color:#ffe9a8}#gfa-root button:disabled{opacity:.4}
  .gat{display:flex;gap:4px;padding:5px 8px;background:#14181c;flex-wrap:wrap}.gabody{padding:10px;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;flex:1;min-height:80px}
  .gar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}#gfa-root input[type=text],#gfa-root select,#gfa-root input[type=number]{font:600 16px ui-monospace,monospace;background:#0f1215;color:#dfe;border:1px solid #444;border-radius:4px;padding:5px 7px;-webkit-user-select:text;user-select:text;max-width:100%}
  #gfa-log{background:#0b0e10;padding:6px 8px;border-top:1px solid #000;max-height:140px;overflow:auto;font:500 10.5px ui-monospace,monospace;line-height:1.45}#gfa-log div{margin:1px 0}#gfa-log .a{color:#8fd7ff}#gfa-log .m{color:#ffe28a}#gfa-log .w{color:#ffb36a}#gfa-log .c{color:#c6a8ff}#gfa-log .t{color:#ff7b7b}
  .gah{color:#9fb3c0;font-size:9.5px;letter-spacing:.1em;margin-top:8px}.gan{color:#8da0ad;font-weight:500;line-height:1.4;margin:6px 0}.gacard{background:#12161a;border:1px solid #2c333a;border-radius:6px;padding:7px 9px;margin:6px 0}.gacard b{color:#fff}.gastn{background:#10261a;border:1px solid #2d6b45;border-radius:6px;padding:8px;margin:6px 0}.gabad{background:#2a1710;border-color:#8a4a22}
  .galcd{font:700 18px ui-monospace,monospace;color:#9fffb8;background:#0b0e10;border-radius:5px;padding:4px 8px;min-width:96px;text-align:center}.gakp{display:grid;grid-template-columns:repeat(4,44px);gap:4px}
  @media (pointer:coarse),(hover:none){#gfa-root button{padding:10px 12px;font-size:12px;min-height:38px}}`;
  let root = null;
  const sel = (path, opts, c) => `<select data-s="${path}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === c ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const chk = (path, label) => `<label><input type="checkbox" data-s="${path}"${getp(S, path) ? ' checked' : ''}> ${label}</label>`;
  const TABS = ['COMMS', 'AIRSPACE', 'RADIO', 'TCAS', 'CPDLC', 'GATE', 'SET'];
  let GATEUI = { icao: '', list: [], msg: '', busy: false };
  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'gfa-root'; root.innerHTML = '<div class="gab" id="gfa-bar"><b id="gfa-stat">ATC CONTROLLER</b><button data-a="min">—</button><button data-a="close">✕</button></div><div class="gat" id="gfa-tabs"></div><div class="gabody" id="gfa-body"></div><div id="gfa-log"></div>'; document.body.appendChild(root);
    const tb = document.createElement('div'); tb.id = 'gfa-tab'; tb.textContent = 'ATC'; tb.addEventListener('click', () => toggle()); document.body.appendChild(tb);
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'wheel', 'keydown', 'keyup'].forEach(t => root.addEventListener(t, e => e.stopPropagation(), { passive: true }));
    root.addEventListener('click', onClick); root.addEventListener('change', onChange);
    const bar = $('#gfa-bar', root); let dr = null; bar.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; dr = { dx: e.clientX - S.x, dy: e.clientY - S.y }; try { bar.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
    bar.addEventListener('pointermove', e => { if (!dr) return; S.x = clamp(e.clientX - dr.dx, 0, innerWidth - 80); S.y = clamp(e.clientY - dr.dy, 0, innerHeight - 40); place(); }); bar.addEventListener('pointerup', () => { dr = null; save(); });
    root.addEventListener('input', e => { if (e.target.id === 'gfa-msg') MSG = e.target.value; });
    root.addEventListener('keydown', e => { if (e.target.id === 'gfa-msg' && e.key === 'Enter') { e.preventDefault(); sendMsg(); } });
    root.classList.toggle('min', !!S.min); place(); drawTab(); drawLog();
  }
  let MSG = '';
  function sendMsg() { const el = $('#gfa-msg'), t = (el ? el.value : MSG).trim(); if (!t) return; MSG = ''; if (el) el.value = ''; transmit(t, false); }
  function statBar() { const el = $('#gfa-stat'); if (!el) return; const st = A.stn; el.textContent = S.min ? 'ATC · ' + (st ? (st.name + (st.freq ? ' ' + st.freq.toFixed(3) : '')) : '—') + ' · ' + A.ph.toUpperCase() + ' · ' + sq() + (TC.adv ? ' · ' + TC.adv : '') + (CP.msgs.some(m => m.dir === 'UP' && m.st === 'NEW') ? ' · ✉' : '') : 'ATC CONTROLLER'; }
  const place = () => { if (root) { root.style.left = S.x + 'px'; root.style.top = S.y + 'px'; } };
  const toggle = f => { S.open = typeof f === 'boolean' ? f : !S.open; save(); root && root.classList.toggle('open', S.open); unlock(); drawTab(); };
  function drawLog() { const el = $('#gfa-log'); if (!el) return; el.innerHTML = LOGS.slice(0, 16).map(l => { const cl = l.who === 'ME' || l.who === 'ME·' ? 'm' : l.who === 'SYS' ? 'w' : l.who === 'CPDLC' ? 'c' : l.who === 'TCAS' ? 't' : 'a'; return `<div class="${cl}">${pad(new Date(l.t).getUTCHours())}${pad(new Date(l.t).getUTCMinutes())}Z [${esc(l.who)}] ${esc(l.text)}</div>`; }).join('') || '<div class="w">Tap once to unlock speech. Set ORIGIN/DEST in the CDU RTE page, then tune the pedestal VHF to the frequency shown.</div>'; }
  const radioHtml = () => { const rs = radios(), mi = micIdx(); return rs.map((r, i) => `<div class="gacard"><b>VHF ${i + 1}</b>${mi === i ? ' <span style="color:#9fffb8">● MIC</span>' : ''} <span class="galcd">${(r.act / 1000).toFixed(3)}</span> ⇄ <span class="galcd" style="color:#ffe28a">${(r.stby / 1000).toFixed(3)}</span> <button data-a="xfer-${i}">XFER</button><button data-a="mic-${i}" class="${mi === i ? 'on' : ''}">MIC</button><br><input type="text" data-stby="${i}" size="8" maxlength="7" inputmode="decimal" placeholder="STBY MHz" style="margin-top:6px"> <button data-a="setstby-${i}">SET STBY</button></div>`).join('') || '<div class="gan">Lower Panel script not found.</div>'; };
  function tcasSvg() {
    const R = S.tcasRange, W = 240, cx = 120, cy = 120, sc = 100 / R; let s = `<svg viewBox="0 0 ${W} ${W}" width="240" height="240" style="background:#06090c;border-radius:8px"><circle cx="${cx}" cy="${cy}" r="100" fill="none" stroke="#2c4358"/><circle cx="${cx}" cy="${cy}" r="50" fill="none" stroke="#2c4358"/><text x="${cx + 4}" y="${cy - 52}" fill="#6c8294" font-size="9">${R / 2}</text><text x="${cx + 4}" y="${cy - 102}" fill="#6c8294" font-size="9">${R}</text><path d="M${cx} ${cy - 8} L${cx + 6} ${cy + 7} L${cx} ${cy + 3} L${cx - 6} ${cy + 7}Z" fill="#fff"/>`;
    TC.targets.forEach(t => { const rr = Math.min(t.r, R) * sc, a = (t.b - (C ? C.hdg : 0)) * RAD, x = cx + Math.sin(a) * rr, y = cy - Math.cos(a) * rr, col = t.ra ? '#ff3b30' : t.ta ? '#ffb020' : t.prox ? '#4dd2ff' : '#e6edf2', rel = Math.round(t.rel / 100); s += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">${t.ra ? `<rect x="-6" y="-6" width="12" height="12" fill="${col}"/>` : t.ta ? `<circle r="6" fill="${col}"/>` : `<path d="M0 -6 L6 0 L0 6 L-6 0Z" fill="${t.prox ? col : 'none'}" stroke="${col}"/>`}<text x="8" y="-2" fill="${col}" font-size="9">${rel >= 0 ? '+' : '-'}${pad(Math.abs(rel))}</text></g>`; });
    return s + '</svg>';
  }
  function drawTab() {
    const tabs = $('#gfa-tabs'), body = $('#gfa-body'); if (!tabs || !body || !S.open) return; if (document.activeElement && root.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    tabs.innerHTML = TABS.map(t => `<button data-t="${t}" class="${S.tab === t ? 'on' : ''}">${t}${t === 'CPDLC' && CP.msgs.some(m => m.dir === 'UP' && m.st === 'NEW') ? ' ●' : ''}${t === 'TCAS' && TC.adv ? ' ●' : ''}</button>`).join('');
    let h = ''; const x = xp(), md = mode(), stn = A.stn;
    if (S.tab === 'COMMS') {
      const heard = stn ? stnHeard(stn) : true, tx = stn ? stnTx(stn) : true, av = available();
      h += `<div class="gacard"><b>${md}</b> · SQUAWK <b>${esc(sq())}</b>${A.as.sq && md === 'IFR' ? ' (assigned ' + A.as.sq + ')' : ''} · ${esc(oIcao() || '----')} → ${esc(dIcao() || '----')} · CALLSIGN <b>${esc(csRaw())}</b> · PHASE <b>${esc(A.ph.toUpperCase())}</b>${A.emg ? ' · <b style="color:#ff6b5e">' + A.emg.kind + '</b>' : ''}</div>`;
      h += `<div class="gastn${heard ? '' : ' gabad'}"><div class="gah">CURRENT STATION</div><b>${esc(stn ? clsFor(stn) : '—')}</b> ${stn && stn.freq ? (heard ? (tx ? '<span style="color:#9fffb8">● on frequency</span>' : '<span style="color:#ffb36a">● tuned - select MIC on that radio</span>') : '<span style="color:#ff8d7d">● NOT TUNED</span>') : ''}<div class="gar">${stn && stn.freq ? `<button class="amb" data-a="tune">TUNE ${stn.freq.toFixed(3)}</button>` : ''}${av.map(r => `<button class="go" data-a="req-${r.k}">${esc(r.label.toUpperCase())}</button>`).join('') || '<span class="gan">No pilot call needed now - ATC will call you.</span>'}</div></div>`;
      h += `<div class="gah">TRANSMIT - TYPE OR SPEAK YOUR OWN CALL</div><div class="gar"><input type="text" id="gfa-msg" value="${esc(MSG)}" placeholder="e.g. ${esc(cs().replace(/ heavy$/, ''))} heavy, request flight level three seven zero" style="flex:1;min-width:200px" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><button class="go" data-a="send">SEND</button>${SR ? '<button class="go" data-a="ptt">🎙 SPEAK</button>' : ''}</div><div class="gar">${[['Say again', 'say again'], ['Unable', 'unable'], ['Wilco', 'wilco'], ['Standby', 'standby'], ['Request FL…', 'request flight level '], ['Direct to…', 'request direct to '], ['Vectors', 'request vectors'], ['Speed…', 'request speed '], ['Weather dev.', 'request deviation right of track, weather'], ['Go around', 'going around']].map(([l, t]) => `<button data-fill="${esc(t)}">${l}</button>`).join('')}</div>`;
      h += `<div class="gar"><button data-a="atis-o">ATIS ${esc(oIcao() || 'ORIG')}</button><button data-a="atis-d">ATIS ${esc(dIcao() || 'DEST')}</button><button data-a="repeat">SAY AGAIN</button><button data-a="skip">SKIP PHASE</button><button data-a="newflight">NEW FLIGHT</button></div>`;
      if (curOc()) h += `<div class="gacard"><b>OCEANIC</b> · SELCAL <b>${esc(selcal())}</b> · ${A.posDue ? '<b style="color:#ffb36a">POSITION REPORT DUE</b>' : 'no report due'}<div class="gar"><button class="go" data-a="posrep">POSITION REPORT</button><button data-a="selcheck">SELCAL CHECK (HF)</button></div></div>`;
      h += `<div class="gar"><button class="amb" data-a="pan">PAN-PAN</button><button class="warn" data-a="mayday">MAYDAY</button>${A.emg ? '<button data-a="emgrep">REPORT SOULS / FUEL / INTENTIONS</button><button data-a="emgend">CANCEL</button>' : ''}</div>`;
      if (A.nearest) h += `<div class="gan">NEAREST: <b>${esc(A.nearest.i)}</b> ${esc(A.nearest.n)} · ${A.nearest.d.toFixed(1)} NM · BRG ${pad(Math.round(A.nearest.b), 3)}°</div>`;
      h += `<div class="gar">${chk('auto', 'Auto pilot calls (I speak for you)')}${chk('readback', 'Readbacks')}${chk('needTune', 'Require VHF tuning')}${chk('manualRb', 'I read back myself (checked)')}${chk('needCs', 'Callsign required')}</div>`;
    } else if (S.tab === 'AIRSPACE') {
      h += airHtml();
    } else if (S.tab === 'RADIO') {
      h += radioHtml(); h += '<div class="gah">TRANSPONDER</div>';
      h += `<div class="gar"><span class="galcd">${esc(sq())}</span><span class="galcd" style="font-size:12px">${x ? (XMODES.find(m => m[1] === x.mode) || [x.mode === 1 ? 'ALT OFF' : '?'])[0] : '—'}</span><button data-a="ident" class="amb">IDENT</button></div><div class="gar"><div class="gakp">${['1', '2', '3', '4', '5', '6', '7', '0'].map(d => `<button data-kp="${d}">${d}</button>`).join('')}</div><button data-a="kpclr">CLR</button></div>`;
      h += `<div class="gar">${XMODES.map(([n, v]) => `<button data-xm="${v}" class="${x && x.mode === v ? 'on' : ''}">${n}</button>`).join('')}</div><div class="gar"><button data-code="1200">VFR 1200</button><button data-code="7000">VFR 7000</button><button data-code="2000">2000</button><button data-code="7600" class="amb">7600</button><button data-code="7700" class="warn">7700</button></div>`;
      h += `<div class="gan">Keypad entry: type 4 digits. These controls drive the pedestal's radios and transponder. Before takeoff the tower warns if the transponder is on STBY or the squawk is wrong.</div>`;
    } else if (S.tab === 'TCAS') {
      h += `<div class="gar">${tcasSvg()}<div>${[5, 10, 20].map(r => `<button data-r="${r}" class="${S.tcasRange === r ? 'on' : ''}">${r} NM</button>`).join('<br>')}<br><button data-a="tcasprobe">PROBE</button></div></div><div class="gacard"><b style="color:${TC.ra ? '#ff6b5e' : TC.ta ? '#ffb020' : '#9fffb8'}">${esc(TC.adv || (x && x.mode >= 3 ? 'NO TRAFFIC ALERT' : 'TCAS OFF - set transponder TA or TA/RA'))}</b><br>${TC.targets.length} aircraft within 40 NM${TC.probe ? '<br><span class="gan">' + esc(TC.probe) + '</span>' : ''}</div><div class="gar">${chk('tcas', 'TCAS enabled')}${chk('tcasAlerts', 'Spoken alerts')}</div><div class="gan">Uses GeoFS multiplayer aircraft. Simplified tau logic (TA ≈ 45 s, RA ≈ 30 s to closest approach within ±1200 / ±800 ft). Not certified. Needs the transponder in TA or TA/RA.</div>`;
    } else if (S.tab === 'CPDLC') {
      h += `<div class="gacard"><b>${cpOK() ? 'CONNECTED: ' + esc(CP.unit) : 'NOT CONNECTED'}</b> · shows on the CDU: press <b>ATC</b> key (UPLINK, REQUEST, LOG)</div><div class="gar"><button data-a="cplogon">${cpOK() ? 'LOGOFF' : 'LOGON'}</button><button data-a="cpfl" ${cpOK() ? '' : 'disabled'}>REQ FL+2000</button><button data-a="cpdct" ${cpOK() ? '' : 'disabled'}>REQ DIRECT NEXT WPT</button>${chk('cpdlc', 'Use CPDLC')}${chk('autoAP', 'Set autopilot ALT on WILCO')}</div>`;
      h += CP.msgs.slice(0, 8).map(m => `<div class="gacard"><b>${m.dir === 'UP' ? '▼ UPLINK' : '▲ DOWNLINK'}</b> ${new Date(m.t).toISOString().slice(11, 16)}Z · ${m.st}<br>${esc(m.txt)}${m.dir === 'UP' && (m.st === 'NEW' || m.st === 'STANDBY') ? `<div class="gar"><button class="go" data-cp="${m.id}:${m.resp === 'WU' ? 'WILCO' : 'ROGER'}">${m.resp === 'WU' ? 'WILCO / ACCEPT' : 'ROGER'}</button><button class="warn" data-cp="${m.id}:UNABLE">UNABLE / REJECT</button><button data-cp="${m.id}:STANDBY">STANDBY</button></div>` : ''}</div>`).join('') || '<div class="gan">No messages. Connect after the Centre check-in.</div>';
    } else if (S.tab === 'GATE') {
      h += `<div class="gar"><input type="text" id="gfa-gic" size="6" maxlength="4" value="${esc(GATEUI.icao || oIcao())}" placeholder="ICAO" style="text-transform:uppercase" autocapitalize="characters" autocorrect="off"><button class="go" data-a="gload" ${GATEUI.busy ? 'disabled' : ''}>${GATEUI.busy ? 'LOADING…' : 'LOAD GATES'}</button><input type="text" id="gfa-gfl" size="6" placeholder="FILTER" value="${esc(S.gateFilter)}" style="text-transform:uppercase"><label>HDG <input type="number" id="gfa-ghd" style="width:84px" placeholder="auto" value="${esc(S.gateHdg)}"></label></div>`;
      const g = GD[GATEUI.icao]; const fl = (S.gateFilter || '').toUpperCase(), L2 = g ? g.gates.filter(x => !fl || x.ref.toUpperCase().includes(fl)).sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true })).slice(0, 60) : [];
      h += `<div class="gan">${esc(GATEUI.msg)}</div><div class="gar">${L2.map(x => `<button data-spawn="${esc(x.ref)}">${esc(x.ref)}</button>`).join('') || '<span class="gan">Load an airport to list its gates/stands (from OpenStreetMap).</span>'}</div><div class="gan">Tap a gate to teleport the aircraft there (nose toward the stand, parking brake set, engines off, ATC restarts at the gate). Heading is estimated from the nearest taxiway - enter HDG to override. Gates exist only where OpenStreetMap has them. Teleport uses GeoFS internals (experimental).</div>`;
    } else {
      const vs = TTS.voices; h += `<div class="gar">${chk('voiceOn', 'Voice on')}${chk('radioFx', 'Radio squelch')}${chk('lineup', 'Use "line up and wait" (IFR)')}${chk('autoSq', 'Set assigned squawk automatically')}${chk('followXp', 'Follow the pedestal transponder code (VFR / emergency)')}</div>
        <div class="gar"><label>VFR CODES <input type="text" data-s="vfrCodes" value="${esc(S.vfrCodes)}" size="14"></label><label>CALLSIGN <input type="text" data-s="callsign" value="${esc(S.callsign)}" placeholder="from CDU FLT NO" size="10" autocapitalize="characters"></label></div>
        <div class="gar"><label>SPEED <input type="range" data-s="rate" min=".7" max="1.5" step=".05" value="${S.rate}"></label><label>VOLUME <input type="range" data-s="vol" min="0" max="1" step=".05" value="${S.vol}"></label></div>
        <div class="gar"><label>SOULS <input type="text" data-s="souls" value="${esc(S.souls)}" size="4" inputmode="numeric"></label><label>FUEL <input type="text" data-s="fuelH" value="${esc(S.fuelH)}" size="2" inputmode="numeric">h <input type="text" data-s="fuelM" value="${esc(S.fuelM)}" size="2" inputmode="numeric">m</label><label>SPAWN ALT <input type="number" data-s="spawnAlt" value="${S.spawnAlt}" style="width:70px">m</label></div>
        <div class="gan">${TTS.ok ? vs.length + ' voices found; each controller uses a different one.' : 'Speech not available - text only.'} VFR codes: transponder codes that switch ATC to VFR handling (default 1200, 7000). Squawk 7700 starts an emergency, 7600 is acknowledged.</div>`;
    }
    body.innerHTML = h; if (S.tab === 'AIRSPACE') mapAttach();
  }
  async function onClick(e) {
    const b = e.target.closest('button'); if (!b || b.disabled) return; unlock(); const a = b.dataset.a;
    try {
      if (b.dataset.fill !== undefined) { const t0 = cs().replace(/ heavy$/, '') + ' heavy, ' + b.dataset.fill; const q = b.dataset.fill; if (/^(say again|unable|wilco|standby)$/.test(q)) { MSG = ''; return transmit(cs() + ', ' + q, false); } MSG = t0; drawTab(); const el = $('#gfa-msg'); if (el) { try { el.focus(); } catch (x) { /* ignore */ } } return; }
      if (b.dataset.tf) { const [m] = b.dataset.tf.split(':'); return setRadio(parseFloat(m), 'act'); }
      if (b.dataset.t) { S.tab = b.dataset.t; save(); return drawTab(); }
      if (b.dataset.r) { S.tcasRange = +b.dataset.r; save(); return drawTab(); }
      if (b.dataset.cp) { const [id, how] = b.dataset.cp.split(':'); return cpRespond(+id, how); }
      if (b.dataset.kp) { const x = xp(); if (!x) return; x.entry = ((x.entry || '') + b.dataset.kp).slice(0, 4); if (x.entry.length === 4) { x.code = x.entry; x.entry = ''; } safe(() => LO().refresh()); log('SYS', 'Squawk entry ' + (x.entry || x.code)); return drawTab(); }
      if (b.dataset.code) { const x = xp(); if (x) { x.code = b.dataset.code; x.entry = ''; safe(() => LO().refresh()); } return drawTab(); }
      if (b.dataset.xm !== undefined) { const x = xp(); if (x) { x.mode = +b.dataset.xm; safe(() => LO().refresh()); } return drawTab(); }
      if (b.dataset.spawn) { const ic = GATEUI.icao, g = GD[ic].gates.find(x => x.ref === b.dataset.spawn), hd = ($('#gfa-ghd') || {}).value; S.gateHdg = hd || ''; save(); GATEUI.msg = 'Spawning at ' + g.ref + '…'; drawTab(); try { await spawn(ic, g, hd); GATEUI.msg = 'Spawned at gate ' + g.ref + '.'; } catch (err) { GATEUI.msg = err.message; log('SYS', err.message); } return drawTab(); }
      if (a && a.startsWith('req-')) return pilotAct(a.slice(4));
      if (a && a.startsWith('xfer-')) { const r = radios()[+a.slice(5)]; if (r) { [r.act, r.stby] = [r.stby, r.act]; safe(() => LO().refresh()); } return drawTab(); }
      if (a && a.startsWith('mic-')) { safe(() => { LO().state.mic = 'vhf' + a.slice(4); LO().refresh(); }); return drawTab(); }
      if (a && a.startsWith('setstby-')) { const i = +a.slice(8), inp = $(`[data-stby="${i}"]`), v = parseFloat((inp || {}).value); if (isFinite(v) && v >= 118 && v <= 137) { radios()[i].stby = Math.round(v * 1000); safe(() => LO().refresh()); } else log('SYS', 'Enter a frequency 118.000-136.975'); return drawTab(); }
      switch (a) {
        case 'close': return toggle(false);
        case 'min': S.min = !S.min; save(); root.classList.toggle('min', S.min); statBar(); return;
        case 'send': return sendMsg();
        case 'mapz+': return mapZoom(1.5);
        case 'mapz-': return mapZoom(1 / 1.5);
        case 'mapfollow': MAPV.follow = true; MAPV.sel = ''; mapDraw(); return drawTab();
        case 'maptrail': MAPV.trail = []; return mapDraw();
        case 'ocopy': { const t = oceanicText(); try { await navigator.clipboard.writeText(t); log('SYS', 'Oceanic list copied (' + oceanicList().length + ' centres)'); } catch (x) { log('SYS', 'Copy was blocked - use DOWNLOAD'); } return; }
        case 'odl': dlText('oceanic-centres.txt', oceanicText()); return log('SYS', 'Oceanic list saved as oceanic-centres.txt');
        case 'posrep': return sendPos();
        case 'selcheck': return selcalCheck();
        case 'ffhsave': { const id = curFir(), v = parseFloat((($('#gfa-fh') || {}).value || '').replace(',', '.')); if (id && isFinite(v) && v >= 2 && v <= 30) { S.firHF[id] = Math.round(v * 1000) / 1000; save(); log('SYS', id + ' HF saved: ' + v.toFixed(3) + ' MHz'); } else log('SYS', 'Enter HF in MHz, for example 5.649'); return drawTab(); }
        case 'ffhact': { const f = S.firHF[curFir()]; if (f) tuneHF(f); return drawTab(); }
        case 'airload': return loadAirspace(true);
        case 'ffsave': { const id = curFir(), v = parseFloat((($('#gfa-ff') || {}).value || '').replace(',', '.')); if (id && isFinite(v) && v >= 118 && v <= 137) { S.firFreq[id] = Math.round(v * 1000) / 1000; save(); log('SYS', id + ' frequency saved: ' + v.toFixed(3)); } else log('SYS', 'Enter a frequency from 118.000 to 136.975'); return drawTab(); }
        case 'ffact': { const f = S.firFreq[curFir()]; if (f) setRadio(f, 'act'); return; }
        case 'ffstby': { const f = S.firFreq[curFir()]; if (f) setRadio(f, 'stby'); return; }
        case 'tune': if (A.stn && A.stn.freq) { if (A.stn.hf) tuneHF(A.stn.freq); else tune(A.stn.freq); } return drawTab();
        case 'atis-o': return atis(oIcao()); case 'atis-d': return atis(dIcao());
        case 'repeat': { const l = LOGS.find(x => x.who === 'ATC'); if (l) speak(l.text, { key: 'repeat' }); return; }
        case 'skip': { const o = ['cd', 'gnd', 'twr', 'dep', 'ctr', 'app', 'twr2', 'gnd2', 'done'], i = o.indexOf(A.ph); if (i >= 0 && i < o.length - 1) { A.ph = o[i + 1]; if (UNITS[A.ph]) setStn(UNITS[A.ph][0], UNITS[A.ph][1]); A.checked = true; log('SYS', 'Phase -> ' + A.ph); } return drawTab(); }
        case 'newflight': return newFlight();
        case 'ptt': return ptt(true);
        case 'pan': return declare('PAN-PAN'); case 'mayday': return declare('MAYDAY'); case 'emgrep': return emgReport(); case 'emgend': return endEmergency();
        case 'ident': { const x = xp(); if (x) { x.identUntil = now() + 18000; safe(() => LO().refresh()); log('ME', 'Squawk ident'); } return; }
        case 'kpclr': { const x = xp(); if (x) { x.entry = ''; safe(() => LO().refresh()); } return drawTab(); }
        case 'tcasprobe': return tcasProbe();
        case 'cplogon': if (cpOK()) { A.cpLogged = false; log('CPDLC', 'Logoff'); } else if (A.stn) cpLogon(A.stn); return drawTab();
        case 'cpfl': return cpRequest('alt', cruise() + 2000);
        case 'cpdct': { const f = F(), l = (f.legs || [])[(f.active || 0) + 1]; return l ? cpRequest('dct', l.id) : log('SYS', 'No next waypoint in the CDU route'); }
        case 'gload': { const ic = (($('#gfa-gic') || {}).value || '').toUpperCase().trim(); S.gateFilter = (($('#gfa-gfl') || {}).value || '').trim(); save(); GATEUI.icao = ic; GATEUI.busy = true; GATEUI.msg = 'Downloading…'; drawTab(); try { const g = await loadGates(ic); GATEUI.msg = g.gates.length + ' gates/stands and ' + g.twys.length + ' named taxiway segments loaded for ' + ic; } catch (err) { GATEUI.msg = err.message; } GATEUI.busy = false; return drawTab(); }
      }
    } catch (err) { log('SYS', (a || 'error') + ': ' + (err && err.message ? err.message : err)); }
  }
  const UNITS = { cd: ['CLD', 'o'], gnd: ['GND', 'o'], twr: ['TWR', 'o'], dep: ['DEP', 'o'], ctr: ['CTR', 'o'], app: ['APP', 'd'], twr2: ['TWR', 'd'], gnd2: ['GND', 'd'] };
  function onChange(e) { const el = e.target.closest('[data-s]'); if (!el) return; const p = el.dataset.s; let v = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? parseFloat(el.value) : el.value; setp(S, p, v); save(); if (p === 'followXp' || p === 'vfrCodes') drawTab(); }
  document.addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyT') { e.preventDefault(); toggle(); } });

  /* ═══════════════ boot ═══════════════ */
  function boot() {
    if (!document.body || !document.head) return setTimeout(boot, 800);
    if (!safe(() => window.geofs && geofs.animation && geofs.animation.values, null)) return setTimeout(boot, 1500);
    build(); loadIndex();
    let tries = 0; const iv = setInterval(() => { if (installPages() || ++tries > 40) clearInterval(iv); }, 1500);
    setInterval(() => { try { tick(); } catch (e) { /* never break GeoFS */ } }, 1000);
    setInterval(() => { try { C = C || T(); tcasTick(); if (S.open && (S.tab === 'TCAS' || S.tab === 'COMMS' || S.tab === 'RADIO')) drawTab(); } catch (e) { /* ignore */ } }, 1500);
    window.GeoFSATC = { AIR, transmit, norm, LOGS, version: VERSION, open: () => toggle(true), close: () => toggle(false), state: S, A, CP, TC, REQ, atis, declare, spawn, loadGates, GD, tune, newFlight, cpUplink, cpRespond, interpret, speak, _t: { oc: () => oceanicText(), mapPaint, mapEnsure, MAPV, tick, PHASES, station, setStn, monitor, T, onRunway, xtrack, mode, vecText, taxiRoute, setC: c => { C = c; }, tcasTick, userLLA, available, pilotAct } };
    log('SYS', 'ATC ready - ' + (TTS.ok ? 'voice available' : 'text only')); console.log('[GeoFS ATC] loaded. Alt+T');
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
GeoFSDock.add('#gfa-tab', 8);
