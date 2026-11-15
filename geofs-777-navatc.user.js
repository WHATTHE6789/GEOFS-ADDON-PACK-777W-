// ==UserScript==
// @name         GeoFS 777-300ER Nav Data (airports / SID / STAR / approaches) + Voice ATC
// @namespace    https://github.com/geofs-overhead
// @version      1.0.0
// @description  Loads real airport, runway and frequency data, imports real SID/STAR/approach procedures (ARINC 424 / text), builds generic departures and ILS approaches from runway geometry, pushes them into the Lower Panel CDU LEGS page (new DEP/ARR pages), and runs a spoken ATC (clearance, ground, tower, departure, approach) with ATIS.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * INSTALL: Tampermonkey/Violentmonkey -> new script -> paste -> save -> reload GeoFS. Install AFTER the Lower Panel script.
 * USE:     Alt+N = Nav Data & ATC panel (or the NAV tab on the left edge). CDU: press DEP ARR.
 *
 * HONESTY NOTE (please read)
 *   REAL DATA   Airport position/elevation, runway thresholds/headings/lengths and ATC frequencies come from the free
 *               OurAirports database (davidmegginson.github.io/ourairports-data), fetched by YOUR browser the first time
 *               you load an airport and then cached on your device. Weather for ATIS/ATC comes from aviationweather.gov.
 *   PROCEDURES  There is no free worldwide SID/STAR database that a browser can download directly, and I cannot fabricate
 *               charts. So real procedures come from a file YOU provide:
 *                 * ARINC 424 text (FAA CIFP for the US is free from faa.gov; Navigraph / sim-navdata exports work too), or
 *                 * a short text format (see PROC tab) to type or paste a procedure from a chart.
 *               Only legs with a fixed position (IF, TF, DF, CF, RF, AF ...) are imported; heading/altitude-terminated legs
 *               (VA, VM, CA, FM ...) have no fix and are skipped. The parser is written from the ARINC 424 layout and has
 *               only been checked against records I wrote myself - if a real file does not parse, tell me.
 *   GENERATED   "GEN" procedures (straight-out departure, ILS/visual final) are built from runway geometry only. They are
 *               NOT charted procedures.
 *   ATC         The controller is a scripted simulation with browser text-to-speech - not real ATC, not VATSIM/IVAO, and it
 *               does not know taxiways, traffic or airspace. Frequencies shown are real; "Control" (en-route) has none.
 *   NOT FOR REAL-WORLD NAVIGATION.
 */
(function () {
  'use strict';
  if (window.GeoFSNavATC) return;
  const VERSION = '1.0.0', STORE = 'geofsNavATC.v1', DBK = 'geofsNav.apt.', PRK = 'geofsNav.proc.';
  const BASE = 'https://davidmegginson.github.io/ourairports-data/';

  /* ───────────────────────── helpers ───────────────────────── */
  const safe = (f, d) => { try { const r = f(); return r === undefined ? d : r; } catch (e) { return d; } };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const RAD = Math.PI / 180;
  const V = () => safe(() => geofs.animation.values, {}) || {};
  const inst = () => safe(() => geofs.aircraft.instance, null);
  const LO = () => safe(() => window.GeoFSLower, null), OV = () => safe(() => window.GeoFSOverhead, null);
  const fmc = () => safe(() => LO().fmc, null);
  const sw = k => safe(() => OV().state.sw[k], undefined);
  const agl = v => (typeof v.haglFeet === 'number' ? v.haglFeet : Math.max(0, (v.altitude || 0) - (v.groundElevationFeet || 0)));
  const onGround = v => { const g = safe(() => inst().groundContact, undefined); return g !== undefined ? !!g : agl(v) < 8; };
  const gsKt = v => (typeof v.groundSpeedKnt === 'number' ? v.groundSpeedKnt : (v.groundSpeed || 0) * 1.944);
  const gearPos = () => { const v = V().gearPosition; return typeof v === 'number' ? v : safe(() => controls.gear.position, 0); };
  const parkSet = () => !!safe(() => controls.parkingBrake, false);
  const engRun = () => { const on = safe(() => inst().engine.on, undefined); return on !== undefined ? !!on : (V().rpm || 0) > 300; };
  const pos = () => { const l = safe(() => inst().llaLocation, null) || safe(() => geofs.camera.lla, null); return l && isFinite(l[0]) && isFinite(l[1]) ? { lat: l[0], lon: l[1] } : null; };
  const gcd = (a, b) => { const dl = (b.lat - a.lat) * RAD, dn = (b.lon - a.lon) * RAD, x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dn / 2) ** 2; return 2 * 3440.065 * Math.asin(Math.sqrt(x)); };
  const brg = (a, b) => { const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD), x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD); return (Math.atan2(y, x) / RAD + 360) % 360; };
  const dest = (p, b, nm) => { const d = nm / 3440.065, t = b * RAD, la = p.lat * RAD, lo = p.lon * RAD, la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(t)), lo2 = lo + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2)); return { lat: la2 / RAD, lon: ((lo2 / RAD + 540) % 360) - 180 }; };
  const getp = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const setp = (o, p, v) => { const ks = p.split('.'), l = ks.pop(); ks.reduce((a, k) => a[k], o)[l] = v; };
  const angd = (a, b) => ((a - b + 540) % 360) - 180;

  /* ───────────────────────── settings ───────────────────────── */
  const DEF = () => ({ open: false, x: 120, y: 52, tab: 'ATC', apt: '', callsign: '', voiceOn: true, atcVoice: '', pilotVoice: '', rate: 1, vol: 1, auto: false, readback: true, radio: true, rwyDep: '', rwyArr: '', proc: { t: 'SID', sel: -1 }, info: 'A' });
  const S = DEF();
  try { const o = JSON.parse(localStorage.getItem(STORE) || 'null'); if (o) Object.keys(S).forEach(k => { if (o[k] !== undefined) S[k] = (S[k] && typeof S[k] === 'object') ? Object.assign(S[k], o[k]) : o[k]; }); } catch (e) { /* ignore */ }
  S.open = false;
  let saveT = 0; const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } }, 400); };
  const logLines = [];
  const log = (who, text) => { logLines.unshift({ who, text, t: Date.now() }); if (logLines.length > 60) logLines.pop(); drawLog(); };

  /* ───────────────────────── airport data (OurAirports) ───────────────────────── */
  const APT = {};
  const csv = line => { const o = []; let c = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else if (ch === '"') q = true; else if (ch === ',') { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
  const num = x => { const n = parseFloat(x); return isFinite(n) ? n : null; };
  async function getText(file) { const r = await fetch(BASE + file, { cache: 'force-cache' }); if (!r.ok) throw new Error(file + ' HTTP ' + r.status); return r.text(); }
  function rowsFor(text, re) { const out = []; let m; re.lastIndex = 0; while ((m = re.exec(text))) out.push(csv(m[0])); return out; }
  async function loadAirport(icao, force) {
    icao = String(icao || '').toUpperCase().trim(); if (!/^[A-Z0-9]{3,4}$/.test(icao)) throw new Error('Enter a 3-4 letter ICAO code');
    if (APT[icao] && !force) return APT[icao];
    if (!force) { try { const c = JSON.parse(localStorage.getItem(DBK + icao) || 'null'); if (c) return (APT[icao] = c); } catch (e) { /* ignore */ } }
    const [at, rt, ft] = await Promise.all([getText('airports.csv'), getText('runways.csv'), getText('airport-frequencies.csv')]);
    const a = rowsFor(at, new RegExp('^\\d+,"' + icao + '",.*$', 'gm'))[0]; if (!a) throw new Error(icao + ' not found in OurAirports');
    const apt = { icao, name: a[3], city: a[10], country: a[8], lat: num(a[4]), lon: num(a[5]), elev: num(a[6]) || 0, rwys: [], freqs: [] };
    rowsFor(rt, new RegExp('^\\d+,\\d+,"' + icao + '",.*$', 'gm')).forEach(r => {
      if (r[7] === '1') return; const len = num(r[3]), wid = num(r[4]);
      const ends = [[8, 9, 10, 11, 12, 13, 14], [14, 15, 16, 17, 18, 19, 8]];
      ends.forEach(([i, la, lo, el, hd, ds, oi], k) => {
        const id = r[i]; if (!id) return; const o = k === 0 ? [14, 15, 16] : [8, 9, 10]; let h = num(r[hd]);
        const t = { lat: num(r[la]), lon: num(r[lo]) }, op = { lat: num(r[o[1]]), lon: num(r[o[2]]) };
        if (h == null && t.lat != null && op.lat != null) h = brg(t, op);
        if (h == null) { const m = /^(\d+)/.exec(id); h = m ? +m[1] * 10 : 0; }
        apt.rwys.push({ id, hdg: Math.round(h), len, wid, surf: r[5], lat: t.lat, lon: t.lon, elev: num(r[el]) != null ? num(r[el]) : apt.elev, disp: num(r[ds]) || 0, opp: r[oi], oLat: op.lat, oLon: op.lon });
      });
    });
    rowsFor(ft, new RegExp('^\\d+,\\d+,"' + icao + '",.*$', 'gm')).forEach(r => apt.freqs.push({ type: r[3], desc: r[4], mhz: num(r[5]) }));
    APT[icao] = apt; try { localStorage.setItem(DBK + icao, JSON.stringify(apt)); } catch (e) { /* ignore */ } return apt;
  }
  const rwy = (apt, id) => apt && apt.rwys.find(r => r.id === id);
  const freqOf = (apt, ...types) => { if (!apt) return null; for (const t of types) { const f = apt.freqs.find(x => x.type === t); if (f) return f; } return null; };
  const shortName = apt => (apt ? (apt.name || apt.city || apt.icao).replace(/\b(international|airport|regional|municipal|intl)\b/ig, '').replace(/\s+/g, ' ').trim() || apt.icao : '');

  /* ───────────────────────── weather ───────────────────────── */
  const WX = {};
  async function metar(icao) {
    try { const r = await fetch('https://aviationweather.gov/api/data/metar?ids=' + icao + '&format=raw', { cache: 'no-store' }); if (!r.ok) throw 0; const t = (await r.text()).trim(); if (!t) throw 0; const w = /\b(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(t), q = /\bQ(\d{4})\b/.exec(t), a = /\bA(\d{4})\b/.exec(t), vis = /\s(\d{4})\s/.exec(t);
      return (WX[icao] = { raw: t, dir: w && w[1] !== 'VRB' ? +w[1] : null, spd: w ? +w[2] : 0, gust: w && w[3] ? +w[3] : null, qnh: q ? +q[1] : a ? Math.round(+a[1] / 100 * 33.8639) : 1013, inhg: a ? (+a[1] / 100).toFixed(2) : null, vis: vis ? +vis[1] : null, at: Date.now() }); } catch (e) { return WX[icao] || null; }
  }
  const wxNow = icao => WX[icao] || { dir: null, spd: 0, gust: null, qnh: 1013, raw: '' };
  function bestRwy(apt, wx, pref) {
    if (!apt || !apt.rwys.length) return null; if (pref) { const r = rwy(apt, pref); if (r) return r; }
    return apt.rwys.slice().sort((a, b) => score(b) - score(a))[0];
    function score(r) { const hw = wx && wx.dir != null ? Math.cos(angd(wx.dir, r.hdg) * RAD) * wx.spd : 0; return (hw >= -3 ? 1000 : 0) + hw * 5 + (r.len || 0) / 100; }
  }

  /* ───────────────────────── procedures ───────────────────────── */
  const PROCS = {}; // icao -> [{t,name,rwy:[],trans,legs:[{id,lat,lon,alt,spd}],src}]
  function loadProcs(icao) { if (PROCS[icao]) return PROCS[icao]; try { PROCS[icao] = JSON.parse(localStorage.getItem(PRK + icao) || '[]'); } catch (e) { PROCS[icao] = []; } return PROCS[icao]; }
  function saveProcs(icao) { try { localStorage.setItem(PRK + icao, JSON.stringify(PROCS[icao] || [])); } catch (e) { log('SYS', 'Storage full - could not save procedures'); } }
  function addProcs(icao, list, replaceSrc) { const cur = loadProcs(icao).filter(p => !(replaceSrc && p.src === replaceSrc)); list.forEach(p => { if (!cur.some(q => q.t === p.t && q.name === p.name && q.rwy.join() === p.rwy.join())) cur.push(p); }); PROCS[icao] = cur; saveProcs(icao); return list.length; }
  const rn = id => String(id || '').replace(/^RW/, '').replace(/B$/, ''); // RW02L -> 02L
  function generated(apt) {
    const out = [];
    (apt ? apt.rwys : []).forEach(r => {
      if (r.lat == null) return; const th = { lat: r.lat, lon: r.lon }, de = r.oLat != null ? { lat: r.oLat, lon: r.oLon } : dest(th, r.hdg, (r.len || 9000) / 6076);
      const mk = (id, p, alt) => ({ id, lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), alt });
            out.push({ t: 'SID', name: 'GEN STRAIGHT-OUT', rwy: [r.id], trans: '', src: 'GEN', legs: [mk('D' + r.id + '1', dest(de, r.hdg, 3), Math.round(r.elev / 100) * 100 + 1500), mk('D' + r.id + '2', dest(de, r.hdg, 9), Math.round(r.elev / 100) * 100 + 4500)].map(l => (l.id = l.id.slice(0, 5), l)) });
      const legs = [15, 10, 6].map(nm => mk(r.id + String(nm).padStart(2, '0'), dest(th, (r.hdg + 180) % 360, nm), Math.round((r.elev + nm * 318 + 50) / 100) * 100)); legs.push(mk('RW' + r.id, th, Math.round((r.elev + 50) / 10) * 10));
      legs.forEach(l => { l.id = l.id.slice(0, 5); });
      out.push({ t: 'APP', name: 'GEN ILS/VIS ' + r.id, rwy: [r.id], trans: '', src: 'GEN', legs });
    });
    return out;
  }
  const procList = (icao, t) => { const apt = APT[icao]; return loadProcs(icao).concat(generated(apt)).filter(p => p.t === t || (t === 'ARR' && (p.t === 'STAR' || p.t === 'APP'))); };

  // text format:  "# SID WSSS 02L,02R SENJO1A [TRANS]"  then lines "IDENT lat lon [alt] [spd]"
  function parseText(txt) {
    const out = []; let cur = null;
    String(txt).split(/\r?\n/).forEach(raw => {
      const l = raw.trim(); if (!l) return;
      if (l[0] === '#') { const m = /^#\s*(SID|STAR|APP)\s+([A-Z0-9]{3,4})\s+(\S+)\s+(\S+)(?:\s+(\S+))?/i.exec(l); if (m) { cur = { t: m[1].toUpperCase(), icao: m[2].toUpperCase(), rwy: m[3] === '*' ? [] : m[3].split(',').map(x => x.toUpperCase()), name: m[4].toUpperCase(), trans: m[5] || '', legs: [], src: 'TEXT' }; out.push(cur); } return; }
      if (!cur) return; const p = l.split(/[\s,;]+/); const la = coord(p[1]), lo = coord(p[2]); if (la == null || lo == null || !p[0]) return;
      cur.legs.push({ id: p[0].toUpperCase().slice(0, 5), lat: la, lon: lo, alt: p[3] ? parseAlt(p[3]) : null, spd: p[4] ? +p[4] : null });
    });
    return out.filter(p => p.legs.length);
  }
  function coord(s) { if (s == null) return null; s = String(s).trim().toUpperCase(); let m = /^([NSEW])(\d{5,9})$/.exec(s);
    if (m) { const dl = (m[1] === 'N' || m[1] === 'S') ? 2 : 3, d = m[2]; const v = +d.slice(0, dl) + +d.slice(dl, dl + 2) / 60 + (d.length > dl + 2 ? +d.slice(dl + 2, dl + 4) / 3600 : 0); return m[1] === 'S' || m[1] === 'W' ? -v : v; }
    m = /^([NSEW])?(-?\d+(?:\.\d+)?)$/.exec(s); if (m) { let v = +m[2]; if (m[1] === 'S' || m[1] === 'W') v = -Math.abs(v); return isFinite(v) ? v : null; } return null; }
  const parseAlt = s => { s = String(s).trim().toUpperCase(); if (/^FL\d+/.test(s)) return +s.slice(2) * 100; const n = parseInt(s, 10); return isFinite(n) ? n : null; };

  // ARINC 424 (132-col) terminal procedures. Positions are 0-based slices of the 1-based spec columns.
  const aLat = s => { const m = /^([NS])(\d{2})(\d{2})(\d{4})$/.exec(s.trim()); return m ? (+m[2] + +m[3] / 60 + +m[4] / 360000) * (m[1] === 'S' ? -1 : 1) : null; };
  const aLon = s => { const m = /^([EW])(\d{3})(\d{2})(\d{4})$/.exec(s.trim()); return m ? (+m[2] + +m[3] / 60 + +m[4] / 360000) * (m[1] === 'W' ? -1 : 1) : null; };
  function arincLines(lines, wanted) { // lines: iterable of strings; wanted: Set of ICAO
    const ll = {}, term = {}, recs = [];
    for (const l of lines) {
      if (l.length < 51 || (l[0] !== 'S' && l[0] !== 'T')) continue; const sec = l[4], sub = l[5];
      if (sec === 'P') {
        const ap = l.substr(6, 4).trim(); if (!wanted.has('*') && !wanted.has(ap)) continue; const s2 = l[12];
        if (s2 === 'C' || s2 === 'G' || s2 === 'A') { const la = aLat(l.substr(32, 9)), lo = aLon(l.substr(41, 10)); if (la != null && lo != null) { const id = l.substr(13, 5).trim(); (term[ap] = term[ap] || {})[id] = { lat: la, lon: lo }; } }
        else if ((s2 === 'D' || s2 === 'E' || s2 === 'F') && l[38] <= '1') recs.push({ ap, k: s2, name: l.substr(13, 6).trim(), rt: l[19], tr: l.substr(20, 5).trim(), seq: +l.substr(26, 3), fix: l.substr(29, 5).trim(), reg: l.substr(34, 2), fs: l[36] + (l[37] || ''), desc: l.substr(39, 4), pt: l.substr(47, 2), ad: l[82], a1: l.substr(84, 5).trim(), spd: +l.substr(99, 3) || null });
      } else if ((sec === 'E' && sub === 'A') || sec === 'D') { const la = aLat(l.substr(32, 9)), lo = aLon(l.substr(41, 10)); if (la != null && lo != null) { const id = l.substr(13, sec === 'D' ? 4 : 5).trim(); if (id) ll[id] = ll[id] || { lat: la, lon: lo }; } }
    }
    return { ll, term, recs };
  }
  function buildArinc({ ll, term, recs }) {
    const out = [], skipped = { n: 0 };
    const look = (r, ap) => (term[ap] && term[ap][r.fix]) || ll[r.fix] || null;
    const key = r => r.ap + '|' + r.k + '|' + r.name; const groups = {};
    recs.forEach(r => { (groups[key(r)] = groups[key(r)] || []).push(r); });
    Object.values(groups).forEach(g => {
      const { ap, k, name } = g[0]; const legsOf = rs => rs.sort((a, b) => a.seq - b.seq).map(r => {
        if (!r.fix) { skipped.n++; return null; } const p = look(r, ap); if (!p) { skipped.n++; return null; } const al = r.a1 ? parseAlt(r.a1) : null;
        return { id: r.fix.slice(0, 5), lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), alt: al, spd: r.spd, map: r.desc[3] === 'M', mm: r.desc[2] === 'M' || r.desc[3] === 'M' };
      }).filter(Boolean);
      const by = (...types) => g.filter(r => types.includes(r.rt));
      const trans = rs => { const m = {}; rs.forEach(r => { (m[r.tr] = m[r.tr] || []).push(r); }); return Object.entries(m); };
      const join = (...parts) => { const o = []; parts.flat().forEach(l => { if (!o.length || o[o.length - 1].id !== l.id) o.push(l); }); return o; };
      if (k === 'D') { // SID: runway trans (1,4,F,T) + common (2,5,M) + enroute trans (3,6,S,V)
        const rwT = trans(by('1', '4', 'F', 'T')), cm = legsOf(by('2', '5', 'M')), en = trans(by('3', '6', 'S', 'V'));
        const R = rwT.length ? rwT : [['', []]], E = en.length ? en : [['', []]];
        R.forEach(([rt, rr]) => E.forEach(([et, er]) => { const legs = join(legsOf(rr), cm, legsOf(er)); if (legs.length) out.push({ t: 'SID', name, rwy: rt ? [rn(rt)] : [], trans: et, legs, src: 'ARINC', ap }); }));
      } else if (k === 'E') { // STAR: enroute trans (1,4,7) + common (2,5,8) + runway trans (3,6,9)
        const en = trans(by('1', '4', '7')), cm = legsOf(by('2', '5', '8')), rwT = trans(by('3', '6', '9'));
        const E = en.length ? en : [['', []]], R = rwT.length ? rwT : [['', []]];
        E.forEach(([et, er]) => R.forEach(([rt, rr]) => { const legs = join(legsOf(er), cm, legsOf(rr)); if (legs.length) out.push({ t: 'STAR', name, rwy: rt ? [rn(rt)] : [], trans: et, legs, src: 'ARINC', ap }); }));
      } else { // approach: ident like I02L ; transitions have route type 'A'
        const fin = g.filter(r => r.rt !== 'A'), tr = trans(by('A')); const f = legsOf(fin); const m = f.findIndex(l => l.map); const fl = (m >= 0 ? f.slice(0, m + 1) : f).map(l => ({ id: l.id, lat: l.lat, lon: l.lon, alt: l.alt, spd: l.spd }));
        const mm = /^[A-Z]([0-9]{2}[LRCB]?)/.exec(name), rw = mm ? [mm[1].replace(/B$/, '')] : [], lab = ({ I: 'ILS', L: 'LOC', R: 'RNAV', H: 'RNP', G: 'IGS', V: 'VOR', D: 'VOR/DME', N: 'NDB', S: 'VOR', Q: 'NDB', X: 'LDA', U: 'SDF', B: 'LOC BC', P: 'GPS' })[name[0]] || 'APP';
        const T = tr.length ? tr : [['', []]];
        T.forEach(([t, rr]) => { const legs = join(legsOf(rr), fl); if (legs.length) out.push({ t: 'APP', name: lab + ' ' + name.slice(1), rwy: rw, trans: t, legs, src: 'ARINC', ap }); });
      }
    });
    return { out, skipped: skipped.n };
  }
  async function importArincFile(file, airports) {
    const wanted = new Set(airports); const keep = []; const dec = new TextDecoder('latin1'); let tail = '', off = 0; const CH = 8 << 20;
    const filterL = l => { if (l.length < 40) return false; const s = l[4]; return s === 'P' ? (wanted.has('*') || wanted.has(l.substr(6, 4).trim())) : (s === 'D' || (s === 'E' && l[5] === 'A')); };
    while (off < file.size) {
      const buf = await file.slice(off, off + CH).arrayBuffer(); off += CH; const txt = tail + dec.decode(buf, { stream: true }); const parts = txt.split(/\r?\n/); tail = parts.pop();
      for (const l of parts) if (filterL(l)) keep.push(l); log('SYS', 'Reading ' + Math.min(100, Math.round(off / file.size * 100)) + '%');
      await new Promise(r => setTimeout(r, 0));
    }
    if (tail && filterL(tail)) keep.push(tail);
    return buildArinc(arincLines(keep, wanted));
  }

  /* ───────────────────────── push into the CDU ───────────────────────── */
  function apply(icao, p) {
    const L = LO(), F = fmc(); if (!F) { log('SYS', 'Lower Panel script not found - cannot load into CDU'); return false; }
    const mk = (l, tag) => ({ id: l.id, lat: l.lat, lon: l.lon, alt: l.alt || null, _p: tag });
    if (p.t === 'SID') { const nl = p.legs.map(l => mk(l, 'SID')); const ids = new Set(nl.map(l => l.id)); F.legs = nl.concat(F.legs.filter(l => l._p !== 'SID' && !ids.has(l.id))); F.active = 0; if (!F.orig) F.orig = icao; if (!F.rwy && p.rwy[0]) F.rwy = p.rwy[0]; }
    else {
      const tag = p.t; const base = F.legs.filter(l => l._p !== tag && (tag !== 'STAR' || l._p !== 'APP') ); const keepApp = tag === 'STAR' ? F.legs.filter(l => l._p === 'APP') : [];
      const nl = p.legs.map(l => mk(l, tag)); const ids = new Set(nl.map(l => l.id)); const b2 = base.filter(l => !ids.has(l.id) || l._p === 'SID');
      F.legs = b2.concat(nl, keepApp.filter(l => !ids.has(l.id)));
      if (!F.dest) F.dest = icao; if (tag === 'APP' && p.rwy[0]) S.rwyArr = p.rwy[0];
      if (F.active >= F.legs.length) F.active = 0;
    }
    safe(() => L.save()); safe(() => L.cdus.forEach(c => { c.msg = p.t + ' ' + p.name + ' LOADED'; }));
    log('NAV', p.t + ' ' + p.name + ' (' + p.src + ') loaded into CDU LEGS: ' + p.legs.map(l => l.id).join(' ')); save(); drawTab(); return true;
  }

  /* ───────────────────────── speech / radio ───────────────────────── */
  const TTS = { ok: 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined', voices: [] };
  const loadVoices = () => { if (TTS.ok) { TTS.voices = speechSynthesis.getVoices() || []; if (S.tab === 'ATC' && S.open) drawTab(); } };
  if (TTS.ok) { loadVoices(); try { speechSynthesis.addEventListener('voiceschanged', loadVoices); } catch (e) { speechSynthesis.onvoiceschanged = loadVoices; } }
  function voice(who) { const want = who === 'atc' ? S.atcVoice : S.pilotVoice, vs = TTS.voices; if (!vs.length) return null; let v = vs.find(x => x.voiceURI === want); if (v) return v; const en = vs.filter(x => /^en/i.test(x.lang)), pool = en.length ? en : vs; const fem = /female|samantha|karen|zira|susan|serena|moira|tessa|victoria|fiona|hazel/i, mal = /male|daniel|alex|david|mark|fred|oliver|arthur|george/i; return (who === 'atc' ? pool.find(x => mal.test(x.name)) : pool.find(x => mal.test(x.name) && x !== (pool.find(y => mal.test(y.name))))) || (who === 'atc' ? pool.find(x => fem.test(x.name)) : null) || pool[who === 'atc' ? 0 : Math.min(1, pool.length - 1)]; }
  let ac = null; const actx = () => { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; } catch (e) { return null; } };
  function squelch(open) { const a = S.radio && actx(); if (!a) return; const t = a.currentTime, len = Math.floor(a.sampleRate * .09), b = a.createBuffer(1, len, a.sampleRate), d = b.getChannelData(0); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) * .5; const s = a.createBufferSource(), g = a.createGain(), f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200; s.buffer = b; g.gain.value = .12 * S.vol; s.connect(f); f.connect(g); g.connect(a.destination); s.start(t); void open; }
  let q = Promise.resolve();
  function say(who, text, label) { // who: 'atc' | 'pilot'
    log(who === 'atc' ? (label || 'ATC') : 'ME', text);
    if (!S.voiceOn || !TTS.ok) return Promise.resolve();
    q = q.then(() => new Promise(res => {
      squelch(true); const u = new SpeechSynthesisUtterance(text); const v = voice(who); if (v) { u.voice = v; u.lang = v.lang; } u.rate = clamp(S.rate * (who === 'atc' ? 1.08 : 1.0), .6, 1.8); u.pitch = who === 'atc' ? .92 : 1.05; u.volume = clamp(S.vol, 0, 1);
      let done = false; const fin = () => { if (!done) { done = true; squelch(false); setTimeout(res, 250); } }; u.onend = fin; u.onerror = fin; setTimeout(fin, 25000); try { setTimeout(() => speechSynthesis.speak(u), 120); } catch (e) { fin(); }
    }));
    return q;
  }
  let unlocked = false; const unlock = () => { if (unlocked) return; unlocked = true; actx(); if (TTS.ok) { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) { /* ignore */ } } };
  document.addEventListener('pointerdown', unlock, true); document.addEventListener('keydown', unlock, true);

  /* ───────────────────────── phraseology ───────────────────────── */
  const W = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const dg = s => String(s).replace(/\D/g, '').split('').map(c => W[+c]).join(' ');
  const rwyS = id => { const m = /^(\d+)([LRC]?)$/.exec(id || ''); return m ? dg(m[1]) + ({ L: ' left', R: ' right', C: ' centre', '': '' })[m[2]] : String(id || ''); };
  const freqS = f => (f ? String(f.toFixed(3)).replace(/0+$/, '').replace(/\.$/, '.0').split('').map(c => (c === '.' ? 'decimal' : W[+c])).join(' ') : '');
  const altS = ft => { ft = Math.round(ft / 100) * 100; if (ft >= 18000) return 'flight level ' + dg(ft / 100); const th = Math.floor(ft / 1000), h = (ft % 1000) / 100; return (th ? dg(th) + ' thousand' : '') + (h ? ' ' + dg(h) + ' hundred' : '') || 'zero'; };
  const TEL = { SIA: 'Singapore', BAW: 'Speedbird', UAE: 'Emirates', QFA: 'Qantas', DLH: 'Lufthansa', AFR: 'Air France', KLM: 'K L M', CPA: 'Cathay', ANA: 'All Nippon', JAL: 'Japan Air', SWR: 'Swiss', THA: 'Thai', MAS: 'Malaysian', QTR: 'Qatari', ETD: 'Etihad', AAL: 'American', DAL: 'Delta', UAL: 'United', SQC: 'Singapore Cargo', AIC: 'Air India', KAL: 'Korean Air', EVA: 'Eva', CES: 'China Eastern', CCA: 'Air China', CSN: 'China Southern', VIR: 'Virgin', ACA: 'Air Canada', TUR: 'Turkish', SAA: 'Springbok', ETH: 'Ethiopian', GIA: 'Indonesia', PAL: 'Philippine' };
  const callsign = () => { const c = (S.callsign || (fmc() && fmc().flt) || 'GEOFS1').toUpperCase().replace(/\s+/g, ''); const m = /^([A-Z]{3})(\d{1,4}[A-Z]?)$/.exec(c); if (m && TEL[m[1]]) return TEL[m[1]] + ' ' + dg(m[2].replace(/[A-Z]/g, '')) + ' heavy'; return c.split('').map(ch => (/\d/.test(ch) ? W[+ch] : ch)).join(' ') + ' heavy'; };
  const csShort = () => { const s = callsign(); return s; };
  const qnhS = wx => 'Q N H ' + dg(wx.qnh);
  const windS = wx => (wx.dir == null || !wx.spd ? 'wind calm' : 'wind ' + dg(pad(wx.dir, 3)) + ' degrees ' + dg(wx.spd) + ' knots' + (wx.gust ? ', gusting ' + dg(wx.gust) : ''));
  const squawk = () => { if (!S.sq) S.sq = String(1 + Math.floor(Math.random() * 6)) + [0, 0, 0].map(() => Math.floor(Math.random() * 8)).join(''); return S.sq; };

  /* ───────────────────────── ATC logic ───────────────────────── */
  const A = { done: {}, last: '', t: {}, busy: false, descIssued: 0, everAir: false, landed: false, maxAlt: 0 };
  const F0 = () => fmc() || {};
  const origApt = () => APT[(F0().orig || '').toUpperCase()] || null, destApt = () => APT[(F0().dest || '').toUpperCase()] || null;
  const depRwy = () => { const a = origApt(); return a ? (S.rwyDep && rwy(a, S.rwyDep)) || (F0().rwy && rwy(a, F0().rwy)) || bestRwy(a, wxNow(a.icao)) : null; };
  const arrRwy = () => { const a = destApt(); return a ? (S.rwyArr && rwy(a, S.rwyArr)) || bestRwy(a, wxNow(a.icao)) : null; };
  const distTo = a => { const p = pos(); return p && a ? gcd(p, a) : null; };
  const sidName = () => { const F = F0(); const l = (F.legs || []).find(x => x._p === 'SID'); const n = l ? (loadProcs((F.orig || '').toUpperCase()).concat(generated(origApt())).find(p => p.t === 'SID' && p.legs[0] && p.legs[0].id === l.id) || {}) : {}; return n.src === 'GEN' ? '' : (n.name || ''); };
  const cur = () => { const v = V(); return { v, g: onGround(v), gs: gsKt(v), alt: v.altitude || 0, a: agl(v), vs: v.verticalSpeed || 0, p: pos() }; };
  const crz = () => F0().crz || 35000;
  const wxLine = icao => { const w = wxNow(icao); return windS(w) + ', ' + qnhS(w); };

  const STEPS = [
    { id: 'clr', phase: 'GND', pilot: true, req: 'Request IFR clearance', auto: c => c.g && c.gs < 2 && !A.everAir, role: ['CLD', 'GND', 'TWR', 'A/D'], who: 'Delivery',
      req_t: () => { const o = origApt(); return (o ? shortName(o) : '') + ' Delivery, ' + csShort() + ', stand ready, request I F R clearance to ' + (F0().dest ? dg0(F0().dest) : 'destination') + '.'; },
      text: () => { const d = destApt(), r = depRwy(), sid = sidName(); try { const L = LO(); if (L && L.state && L.state.xp) L.state.xp.code = squawk(); } catch (e) { /* ignore */ } return csShort() + ', cleared to ' + (d ? shortName(d) : (F0().dest || 'destination')) + ' airport via ' + (sid ? sid + ' departure' : 'radar vectors') + (r ? ', runway ' + rwyS(r.id) : '') + ', climb initially ' + altS(Math.min(5000, crz())) + ', squawk ' + dg(squawk()) + '. Report ready for pushback.'; },
      rb: () => { const r = depRwy(), sid = sidName(); return 'Cleared to destination via ' + (sid ? sid + ' departure' : 'radar vectors') + (r ? ', runway ' + rwyS(r.id) : '') + ', initial ' + altS(Math.min(5000, crz())) + ', squawk ' + dg(squawk()) + ', ' + csShort() + '.'; } },
    { id: 'push', phase: 'GND', pilot: true, req: 'Request pushback & start', auto: c => c.g && c.gs < 2 && sw('beacon') === 1, role: ['GND', 'A/D', 'TWR'], who: 'Ground',
      req_t: () => csShort() + ', request pushback and start up.', text: () => csShort() + ', pushback approved, start up at your discretion, QNH ' + dg(wxNow((F0().orig || '').toUpperCase()).qnh) + '.', rb: () => 'Pushback approved, start up at our discretion, ' + csShort() + '.' },
    { id: 'taxi', phase: 'GND', pilot: true, req: 'Request taxi', auto: c => c.g && c.gs < 2 && engRun() && !parkSet(), role: ['GND', 'A/D', 'TWR'], who: 'Ground',
      req_t: () => csShort() + ', ready to taxi.', text: () => { const r = depRwy(); return csShort() + ', taxi to holding point runway ' + (r ? rwyS(r.id) : 'in use') + ' via the taxiways, ' + qnhS(wxNow((F0().orig || '').toUpperCase())) + '. Hold short of the runway.'; }, rb: () => { const r = depRwy(); return 'Taxi to holding point runway ' + (r ? rwyS(r.id) : 'in use') + ', hold short, ' + csShort() + '.'; } },
    { id: 'rdy', phase: 'TWR', pilot: true, req: 'Ready for departure', auto: c => { const r = depRwy(); return c.g && c.gs < 8 && r && c.p && gcd(c.p, r) < .35 && engRun(); }, role: ['TWR', 'A/D', 'ATF', 'CTAF'], who: 'Tower',
      req_t: () => csShort() + ', ready for departure.', text: () => { const r = depRwy(), w = wxNow((F0().orig || '').toUpperCase()); return csShort() + ', ' + windS(w) + ', runway ' + (r ? rwyS(r.id) : '') + ', cleared for takeoff.'; }, rb: () => { const r = depRwy(); return 'Runway ' + (r ? rwyS(r.id) : '') + ', cleared for takeoff, ' + csShort() + '.'; } },
    { id: 'dep', phase: 'DEP', auto: c => !c.g && c.a > 400 && A.everAir && c.alt < 12000, role: ['DEP', 'APP', 'TWR', 'A/D'], who: 'Tower',
      text: () => { const f = freqOf(origApt(), 'DEP', 'APP', 'A/D'); return csShort() + ', airborne. Contact Departure' + (f ? ' on ' + freqS(f.mhz) : '') + '.'; }, rb: () => { const f = freqOf(origApt(), 'DEP', 'APP', 'A/D'); return 'Contact Departure' + (f ? ' ' + freqS(f.mhz) : '') + ', ' + csShort() + '.'; } },
    { id: 'rc', phase: 'DEP', auto: () => A.done.dep && Date.now() - (A.t.dep || 0) > 12000, role: ['DEP', 'APP', 'TWR', 'A/D'], who: 'Departure', noRb: false,
      text: () => { const L = (F0().legs || [])[F0().active || 0]; return csShort() + ', radar contact. Climb ' + altS(Math.min(crz(), 24000)) + (L && L._p !== 'SID' ? ', proceed direct ' + L.id : '') + '.'; }, rb: () => { const L = (F0().legs || [])[F0().active || 0]; return 'Climb ' + altS(Math.min(crz(), 24000)) + (L && L._p !== 'SID' ? ', direct ' + L.id : '') + ', ' + csShort() + '.'; } },
    { id: 'ctr', phase: 'CTR', auto: c => !c.g && c.alt > 12000 && A.done.rc, role: [], who: 'Departure',
      text: () => csShort() + ', contact Area Control now, good day.', rb: () => 'Contacting Control, good day, ' + csShort() + '.' },
    { id: 'cl', phase: 'CTR', auto: c => !c.g && c.alt > 24000 && A.done.ctr && Date.now() - (A.t.ctr || 0) > 20000, role: [], who: 'Control',
      text: () => csShort() + ', radar contact, climb and maintain ' + altS(crz()) + '.', rb: () => 'Climb and maintain ' + altS(crz()) + ', ' + csShort() + '.' },
    { id: 'desc', phase: 'ARR', auto: c => { const d = distTo(destApt()); return !c.g && A.maxAlt > 20000 && d != null && d < Math.max(40, (c.alt - 10000) / 1000 * 3.3 + 20) && c.alt > 11000; }, role: [], who: 'Control',
      text: () => { const d = destApt(); const w = wxNow(d ? d.icao : ''); return csShort() + ', descend to altitude ' + altS(10000).replace('one zero thousand', 'one zero thousand') + ', ' + qnhS(w) + '.'; }, rb: () => 'Descend to ' + altS(10000) + ', ' + csShort() + '.' },
    { id: 'app', phase: 'ARR', auto: c => { const d = distTo(destApt()); return !c.g && d != null && d < 50 && A.done.desc && c.alt < 15000; }, role: ['APP', 'DEP', 'TWR', 'A/D'], who: 'Approach', fromDest: true,
      text: () => { const r = arrRwy(); return csShort() + ', radar contact, descend to altitude ' + altS(4000) + (r ? ', expect I L S runway ' + rwyS(r.id) : '') + ', ' + qnhS(wxNow(destApt().icao)) + '.'; }, rb: () => { const r = arrRwy(); return 'Descend altitude ' + altS(4000) + (r ? ', expect I L S runway ' + rwyS(r.id) : '') + ', ' + csShort() + '.'; } },
    { id: 'ils', phase: 'ARR', auto: c => { const d = distTo(destApt()); return !c.g && d != null && d < 22 && A.done.app && c.a < 7000; }, role: ['APP', 'DEP', 'TWR', 'A/D'], who: 'Approach', fromDest: true,
      text: () => { const r = arrRwy(); return csShort() + ', ' + (r ? 'cleared I L S approach runway ' + rwyS(r.id) : 'cleared visual approach') + ', report established.'; }, rb: () => { const r = arrRwy(); return (r ? 'Cleared I L S approach runway ' + rwyS(r.id) : 'Cleared visual approach') + ', ' + csShort() + '.'; } },
    { id: 'twrc', phase: 'ARR', auto: c => { const d = distTo(destApt()); return !c.g && d != null && d < 11 && A.done.ils && c.a < 4000; }, role: ['TWR', 'A/D', 'ATF', 'CTAF'], who: 'Approach', fromDest: true,
      text: () => { const f = freqOf(destApt(), 'TWR', 'A/D', 'ATF', 'CTAF'); return csShort() + ', contact Tower' + (f ? ' on ' + freqS(f.mhz) : '') + '.'; }, rb: () => { const f = freqOf(destApt(), 'TWR', 'A/D'); return 'Contact Tower' + (f ? ' ' + freqS(f.mhz) : '') + ', ' + csShort() + '.'; } },
    { id: 'ldg', phase: 'ARR', auto: c => { const d = distTo(destApt()); return !c.g && d != null && d < 6 && A.done.twrc && c.a < 2500; }, role: ['TWR', 'A/D', 'ATF', 'CTAF'], who: 'Tower', fromDest: true,
      text: () => { const r = arrRwy(); return csShort() + ', ' + windS(wxNow(destApt().icao)) + ', runway ' + (r ? rwyS(r.id) : '') + ', cleared to land.'; }, rb: () => { const r = arrRwy(); return 'Runway ' + (r ? rwyS(r.id) : '') + ', cleared to land, ' + csShort() + '.'; } },
    { id: 'vac', phase: 'ARR', auto: c => c.g && A.landed && c.gs < 40 && A.done.ldg, role: ['TWR', 'A/D'], who: 'Tower', fromDest: true,
      text: () => { const f = freqOf(destApt(), 'GND', 'A/D', 'TWR'); return csShort() + ', vacate the runway when able, then contact Ground' + (f ? ' on ' + freqS(f.mhz) : '') + '.'; }, rb: () => { const f = freqOf(destApt(), 'GND', 'A/D', 'TWR'); return 'Vacating, Ground ' + (f ? freqS(f.mhz) : '') + ', ' + csShort() + '.'; } },
    { id: 'gate', phase: 'ARR', auto: c => c.g && A.done.vac && c.gs < 25 && Date.now() - (A.t.vac || 0) > 15000, role: ['GND', 'A/D', 'TWR'], who: 'Ground', fromDest: true,
      text: () => csShort() + ', taxi to the gate via the taxiways, report when parked.', rb: () => 'Taxi to the gate, ' + csShort() + '.' },
    { id: 'park', phase: 'ARR', auto: c => c.g && A.done.gate && c.gs < 1 && parkSet(), role: ['GND', 'A/D', 'TWR'], who: 'Ground', fromDest: true,
      text: () => csShort() + ', thank you for flying today, good day.', rb: () => 'Good day, ' + csShort() + '.' },
  ];
  const dg0 = s => String(s).toUpperCase().split('').join(' ');
  const stepApt = st => (st.fromDest ? destApt() : origApt());
  const stepFreq = st => { const f = freqOf(stepApt(st), ...(st.role || [])); return f ? f.mhz : null; };
  const stepById = id => STEPS.find(s => s.id === id);
  const nextStep = () => STEPS.find(s => !A.done[s.id]);

  async function runStep(st, byPilot) {
    if (A.busy || A.done[st.id]) return; A.busy = true; A.done[st.id] = true; A.t[st.id] = Date.now(); drawTab();
    try {
      const apt = stepApt(st), f = stepFreq(st), name = (apt ? shortName(apt) + ' ' : '') + st.who, tag = name + (f ? ' ' + f.toFixed(3) : '');
      if (apt && apt.icao && !WX[apt.icao]) { try { await metar(apt.icao); } catch (e) { /* ignore */ } }
      if (st.pilot && st.req_t && (byPilot || S.auto)) await say('pilot', st.req_t());
      await say('atc', st.text(), tag);
      if (S.readback && st.rb) await say('pilot', st.rb());
    } catch (e) { log('SYS', 'ATC error: ' + e.message); }
    A.busy = false; drawTab();
  }
  function atcTick() {
    const c = cur(); if (!c.g) { A.everAir = true; A.maxAlt = Math.max(A.maxAlt, c.alt); } if (A.everAir && c.g && c.gs > 1 && !A.landed && A.done.ldg !== undefined) A.landed = true; if (A.everAir && c.g && A.maxAlt > 3000) A.landed = true;
    const mark = ids => ids.forEach(i => { if (!A.done[i]) { A.done[i] = true; A.t[i] = A.t[i] || Date.now() - 60000; } });
    if (!c.g && c.a > 600) mark(['clr', 'push', 'taxi', 'rdy']); if (!c.g && c.alt > 12000) mark(['dep', 'rc']); if (A.landed && c.g) mark(STEPS.slice(0, STEPS.findIndex(x => x.id === 'vac')).map(x => x.id));
    if (A.busy || !S.voiceOn) return;
    // load airports named in the CDU
    const F = fmc(); if (F) [F.orig, F.dest].forEach(i => { i = (i || '').toUpperCase(); if (/^[A-Z0-9]{4}$/.test(i) && !APT[i] && !A.loading) { A.loading = true; loadAirport(i).then(a => { log('SYS', 'Loaded ' + i + ' ' + a.name); return metar(i); }).catch(e => log('SYS', i + ': ' + e.message)).finally(() => { A.loading = false; drawTab(); }); } });
    const st = nextStep(); if (!st) return;
    if (!st.pilot || S.auto) { let ok = false; try { ok = st.auto(c); } catch (e) { /* ignore */ } if (ok && Date.now() - (A.t.__last || 0) > 4000) { A.t.__last = Date.now(); runStep(st, false); } }
  }
  function newFlight() { A.done = {}; A.t = {}; A.everAir = false; A.landed = false; A.maxAlt = 0; S.sq = ''; log('SYS', 'ATC reset for a new flight'); drawTab(); }

  async function atis(icao) {
    icao = (icao || '').toUpperCase(); try { const a = await loadAirport(icao); const wx = await metar(icao) || wxNow(icao); const r = bestRwy(a, wx); const d = new Date(), t = pad(d.getUTCHours()) + pad(d.getUTCMinutes());
      const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[(d.getUTCHours() + 7) % 26], txt = shortName(a) + ' information ' + L + ', time ' + dg(t) + ' Zulu. ' + (r ? 'Runway in use ' + rwyS(r.id) + '. ' : '') + windS(wx) + '. ' + (wx.vis ? 'Visibility ' + (wx.vis >= 9999 ? 'ten kilometres or more' : dg(wx.vis) + ' metres') + '. ' : '') + qnhS(wx) + '. Advise on first contact you have information ' + L + '.';
      const f = freqOf(a, 'ATIS'); await say('atc', txt, shortName(a) + ' ATIS' + (f ? ' ' + f.mhz.toFixed(3) : '')); try { const st = safe(() => LO().state, null); if (st && wx.qnh) { st.baro.qnh = wx.qnh; } } catch (e) { /* ignore */ }
    } catch (e) { log('SYS', 'ATIS: ' + e.message); }
  }

  /* ───────────────────────── CDU pages (DEP/ARR) ───────────────────────── */
  function installPages() {
    const L = LO(); if (!L || !L.pages || !L.kit) return false; const { cell, lk, act, info, rows6 } = L.kit; const P = L.pages, F = L.fmc;
    const icaoOf = k => (F[k] || '').toUpperCase();
    P.DEPARR = () => ({ title: 'DEP/ARR INDEX', rows: rows6([
      [info('DEP', icaoOf('orig') || '----', 'g'), info('ARR', icaoOf('dest') || '----', 'g')],
      [lk('<SID', 'DEPLIST'), lk('STAR/APP>', 'ARRLIST')],
      [act('', '<LOAD ' + (icaoOf('orig') || '----'), () => loadAptMsg(icaoOf('orig')), 'm'), act('', 'LOAD ' + (icaoOf('dest') || '----') + '>', () => loadAptMsg(icaoOf('dest')), 'm')],
      [info('RWY', (depRwy() || {}).id || '---'), info('RWY', (arrRwy() || {}).id || '---')],
      [info('NOTE', 'GEN = RUNWAY GEOMETRY', 'a'), null], [lk('<INDEX', 'INITREF'), lk('LEGS>', 'LEGS')]]) });
    const listPage = (key, title, types) => c => {
      const ic = icaoOf(key), list = types.flatMap(t => procList(ic, t)), rw = (key === 'orig' ? depRwy() : arrRwy()), n = list.length, count = Math.max(1, Math.ceil(n / 5)), r = [];
      if (!n) r.push([info('NO PROCEDURES', 'LOAD ' + (ic || 'ARPT') + ' FIRST', 'a'), null]);
      for (let k = 0; k < 5 && c.pg * 5 + k < n; k++) { const p = list[c.pg * 5 + k], ok = !p.rwy.length || !rw || p.rwy.includes(rw.id) || p.rwy.includes(rw.id.replace(/^0/, '')); r.push([cell(p.src + (p.trans ? ' ' + p.trans : ''), p.name, { c: ok ? 'w' : 'a', act: () => (apply(ic, p) ? p.t + ' LOADED - SEE LEGS' : 'LOAD FAILED') }), info('RWY', p.rwy.join(',') || 'ALL', ok ? 'g' : 'a')]); }
      while (r.length < 5) r.push([null, null]); r.push([lk('<DEP/ARR', 'DEPARR'), lk('LEGS>', 'LEGS')]);
      return { title: title + ' ' + ic, count, rows: r };
    };
    P.DEPLIST = listPage('orig', 'SIDS', ['SID']); P.ARRLIST = listPage('dest', 'ARR', ['STAR', 'APP']);
    L.keypage.deparr = 'DEPARR'; return true;
  }
  function loadAptMsg(icao) { if (!icao) return 'ENTER ORIGIN/DEST IN RTE'; loadAirport(icao).then(a => { log('SYS', 'Loaded ' + icao + ' ' + a.name); metar(icao); drawTab(); safe(() => LO().cdus.forEach(c => { c.msg = icao + ' DATA LOADED'; })); }).catch(e => safe(() => LO().cdus.forEach(c => { c.msg = 'NO DATA: ' + e.message.slice(0, 18).toUpperCase(); }))); return 'LOADING ' + icao + '...'; }

  /* ───────────────────────── UI ───────────────────────── */
  const CSS = `
  #gfn-root,#gfn-root *{box-sizing:border-box}#gfn-root{position:fixed;z-index:99985;display:none;width:min(500px,98vw);font:600 11px system-ui,sans-serif;color:#dde4ea;background:#1d2125;border:2px solid #000;border-radius:10px;box-shadow:0 10px 36px #000c;-webkit-user-select:none;user-select:none;touch-action:manipulation;max-height:calc(100dvh - 20px);overflow:hidden}
  #gfn-root.open{display:block}.gnb{display:flex;align-items:center;gap:6px;padding:5px 8px;background:linear-gradient(#3a3f44,#2a2e32);cursor:grab;touch-action:none;letter-spacing:.12em;font-size:10px}.gnb b{flex:1;color:#f1f4f6}
  #gfn-root button{all:unset;cursor:pointer;padding:7px 10px;border-radius:5px;background:#3b4046;border:1px solid #0d0f11;font-size:10px;letter-spacing:.05em;color:#dfe5e9;text-align:center;box-sizing:border-box}#gfn-root button.on{background:#1f3b57;color:#fff}#gfn-root button.go{background:#1d4d2e;color:#bfffd2}#gfn-root button.warn{background:#5a2420;color:#ffd0ca}
  .gnt{display:flex;gap:4px;padding:5px 8px;background:#14181c;flex-wrap:wrap}.gnbody{padding:10px;max-height:66vh;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
  .gnr{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}#gfn-root input[type=text],#gfn-root select,#gfn-root textarea{font:600 16px ui-monospace,monospace;background:#0f1215;color:#dfe;border:1px solid #444;border-radius:4px;padding:5px 7px;-webkit-user-select:text;user-select:text;text-transform:uppercase;max-width:100%}#gfn-root textarea{width:100%;height:110px;text-transform:none;font-size:12px}
  #gfn-log{background:#0b0e10;padding:6px 8px;border-top:1px solid #000;max-height:150px;overflow:auto;font:500 10.5px ui-monospace,monospace;line-height:1.45}#gfn-log div{margin:1px 0}#gfn-log .a{color:#8fd7ff}#gfn-log .m{color:#ffe28a}#gfn-log .w{color:#ffb36a}
  .gnt2{color:#9fb3c0;font-size:9.5px;letter-spacing:.1em;margin-top:6px}.gnnote{color:#8da0ad;font-weight:500;line-height:1.4;margin:6px 0}.gncard{background:#12161a;border:1px solid #2c333a;border-radius:6px;padding:7px 9px;margin:6px 0}.gncard b{color:#fff}
  .gnnext{background:#10261a;border:1px solid #2d6b45;border-radius:6px;padding:8px;margin:6px 0}
  #gfn-tab{position:fixed;left:0;top:44%;z-index:99984;writing-mode:vertical-rl;transform:rotate(180deg);background:#2a2e32;color:#cfe;border:1px solid #000;border-radius:0 6px 6px 0;padding:10px 5px;font:700 10px system-ui;letter-spacing:.2em;cursor:pointer;touch-action:manipulation}
  @media (pointer:coarse),(hover:none){#gfn-root button{padding:10px 12px;font-size:12px;min-height:38px}}`;
  let root = null;
  const sel = (path, opts, c) => `<select data-s="${path}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === c ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const chk = (path, label) => `<label><input type="checkbox" data-s="${path}"${getp(S, path) ? ' checked' : ''}> ${label}</label>`;
  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'gfn-root';
    root.innerHTML = `<div class="gnb" id="gfn-bar"><b>NAV DATA &amp; ATC</b><button data-a="close">✕</button></div><div class="gnt" id="gfn-tabs"></div><div class="gnbody" id="gfn-body"></div><div id="gfn-log"></div>`;
    document.body.appendChild(root);
    const tb = document.createElement('div'); tb.id = 'gfn-tab'; tb.textContent = 'NAV / ATC'; tb.addEventListener('click', () => toggle()); document.body.appendChild(tb);
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'wheel', 'keydown', 'keyup'].forEach(t => root.addEventListener(t, e => e.stopPropagation(), { passive: true }));
    root.addEventListener('click', onClick); root.addEventListener('change', onChange);
    const bar = $('#gfn-bar', root); let dr = null;
    bar.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; dr = { dx: e.clientX - S.x, dy: e.clientY - S.y }; try { bar.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
    bar.addEventListener('pointermove', e => { if (!dr) return; S.x = clamp(e.clientX - dr.dx, 0, innerWidth - 80); S.y = clamp(e.clientY - dr.dy, 0, innerHeight - 40); place(); });
    bar.addEventListener('pointerup', () => { dr = null; save(); });
    place(); applyOpen(); drawTab(); drawLog();
  }
  const place = () => { if (root) { root.style.left = S.x + 'px'; root.style.top = S.y + 'px'; } };
  const applyOpen = () => { if (root) root.classList.toggle('open', S.open); };
  const toggle = f => { S.open = typeof f === 'boolean' ? f : !S.open; save(); applyOpen(); unlock(); drawTab(); };
  const TABS = ['ATC', 'DATA', 'PROC', 'SET'];
  function drawLog() { const el = $('#gfn-log'); if (!el) return; el.innerHTML = logLines.slice(0, 14).map(l => `<div class="${l.who === 'ME' ? 'm' : l.who === 'SYS' || l.who === 'NAV' ? 'w' : 'a'}">${pad(new Date(l.t).getUTCHours())}${pad(new Date(l.t).getUTCMinutes())}Z [${esc(l.who)}] ${esc(l.text)}</div>`).join('') || '<div class="w">Tap anywhere once to unlock speech. Set ORIGIN/DEST in the CDU RTE page and the airports load automatically.</div>'; }
  const aptSummary = a => !a ? '<div class="gnnote">Not loaded.</div>' : `<div class="gncard"><b>${esc(a.icao)}</b> ${esc(a.name)} · ${esc(a.city || '')} · elev ${Math.round(a.elev)} ft<br>${a.rwys.map(r => `${esc(r.id)} ${r.hdg}° ${r.len ? Math.round(r.len * .3048) + 'm' : ''} ${esc(r.surf || '')}`).join(' · ')}<br><span class="gnt2">FREQUENCIES</span><br>${a.freqs.map(f => `${esc(f.type)} ${f.mhz != null ? f.mhz.toFixed(3) : ''}`).join(' · ') || 'none listed'}</div>`;
  function drawTab() {
    const tabs = $('#gfn-tabs'), body = $('#gfn-body'); if (!tabs || !body || !S.open) return;
    tabs.innerHTML = TABS.map(t => `<button data-t="${t}" class="${S.tab === t ? 'on' : ''}">${t}</button>`).join('');
    const F = F0(), oi = (F.orig || '').toUpperCase(), di = (F.dest || '').toUpperCase(); let h = '';
    if (S.tab === 'ATC') {
      const nx = nextStep(), c = cur(), od = origApt(), de = destApt();
      h += `<div class="gncard">${oi || '----'} ${od ? '✓' : '·'} → ${di || '----'} ${de ? '✓' : '·'} · CALLSIGN <b>${esc(callsign())}</b> · DEP RWY <b>${(depRwy() || {}).id || '—'}</b> · ARR RWY <b>${(arrRwy() || {}).id || '—'}</b></div>`;
      if (nx) { const f = stepFreq(nx); h += `<div class="gnext gnnext"><div class="gnt2">NEXT · ${esc(nx.who.toUpperCase())}${f ? ' ' + f.toFixed(3) : ''}</div>${nx.pilot ? `<button class="go" data-a="step">${esc(nx.req.toUpperCase())}</button>` : `<div class="gnnote">ATC will call you automatically (${esc(nx.who)}). <button data-a="step">CALL NOW</button></div>`}</div>`; }
      else h += '<div class="gnnext">Flight complete. <button data-a="newflight">NEW FLIGHT</button></div>';
      h += `<div class="gnr"><button data-a="atis-o">ATIS ${oi || 'ORIG'}</button><button data-a="atis-d">ATIS ${di || 'DEST'}</button><button data-a="skip">SKIP STEP</button><button data-a="newflight">RESET</button><button data-a="repeat">SAY AGAIN</button></div>`;
      h += `<div class="gnr">${chk('auto', 'Auto pilot requests (I request things for you)')}${chk('readback', 'Pilot readbacks')}</div><div class="gnnote">PHASE ${c.g ? 'GROUND' : 'AIRBORNE'} · ${A.busy ? 'transmitting…' : 'idle'}</div>`;
    } else if (S.tab === 'DATA') {
      h += `<div class="gnr"><input type="text" id="gfn-apt" value="${esc(S.apt || oi)}" maxlength="4" placeholder="ICAO" size="6" autocapitalize="characters" autocorrect="off"><button class="go" data-a="load">LOAD</button><button data-a="reload">RE-FETCH</button><button data-a="setorig">AS DEP</button><button data-a="setdest">AS ARR</button></div>`;
      const a = APT[(S.apt || oi || '').toUpperCase()]; h += aptSummary(a); const w = a && WX[a.icao]; h += w ? `<div class="gncard"><span class="gnt2">METAR</span><br>${esc(w.raw)}</div>` : '';
      h += `<div class="gnnote">Data: OurAirports (public domain), fetched by your browser on first use and cached locally. Needs internet access from your browser.</div>`;
    } else if (S.tab === 'PROC') {
      const ic = (S.apt || oi || '').toUpperCase(), a = APT[ic];
      h += `<div class="gnr"><input type="text" id="gfn-apt" value="${esc(ic)}" maxlength="4" size="6" placeholder="ICAO" autocapitalize="characters" autocorrect="off"><button data-a="pt-SID" class="${S.proc.t === 'SID' ? 'on' : ''}">SID</button><button data-a="pt-STAR" class="${S.proc.t === 'STAR' ? 'on' : ''}">STAR</button><button data-a="pt-APP" class="${S.proc.t === 'APP' ? 'on' : ''}">APPROACH</button></div>`;
      const list = a || loadProcs(ic).length ? procList(ic, S.proc.t) : []; h += list.length ? list.map((p, i) => `<div class="gncard"><b>${esc(p.name)}</b> ${esc(p.trans)} · RWY ${esc(p.rwy.join(',') || 'ALL')} · ${esc(p.src)} · ${p.legs.length} fixes<br><span class="gnnote">${p.legs.map(l => l.id).join(' ')}</span><br><button class="go" data-a="apply-${i}">INSERT INTO CDU LEGS</button></div>`).join('') : `<div class="gnnote">${a ? 'No ' + S.proc.t + ' available. Import data below.' : 'Load the airport on the DATA tab first (needed for generated procedures and runway data).'}</div>`;
      h += `<div class="gnt2">IMPORT ARINC 424 FILE (e.g. FAA CIFP)</div><div class="gnr"><input type="file" id="gfn-file" style="font-size:12px;max-width:100%"><button data-a="arinc">IMPORT FOR ${ic || 'AIRPORT'}</button></div>`;
      h += `<div class="gnt2">PASTE PROCEDURE TEXT</div><textarea id="gfn-txt" placeholder="# SID WSSS 02L SENJO1A&#10;SENJO 1.2345 103.9876 5000 250&#10;ABCDE N012345 E1035900 FL100"></textarea><div class="gnr"><button data-a="text">ADD PROCEDURE(S)</button><button class="warn" data-a="clearproc">DELETE IMPORTED FOR ${ic || '—'}</button></div>`;
      h += `<div class="gnnote">Text format: header line <b>#&nbsp;SID|STAR|APP&nbsp;ICAO&nbsp;RWY[,RWY]|*&nbsp;NAME&nbsp;[TRANS]</b>, then one fix per line: <b>IDENT lat lon [alt] [speed]</b>. Coordinates: decimal degrees (S/W negative) or N012345 / E1035900. Procedures you type are only as accurate as your chart.</div>`;
    } else {
      const vs = TTS.voices, opts = [['', 'Auto']].concat(vs.map(v => [v.voiceURI, v.name + ' (' + v.lang + ')']));
      h += `<div class="gnr">${chk('voiceOn', 'Voice on')}${chk('radio', 'Radio squelch sound')}</div><div class="gnr"><label>CONTROLLER ${sel('atcVoice', opts, S.atcVoice)}</label></div><div class="gnr"><label>PILOT ${sel('pilotVoice', opts, S.pilotVoice)}</label></div>
        <div class="gnr"><label>CALLSIGN <input type="text" data-s="callsign" value="${esc(S.callsign)}" placeholder="from CDU FLT NO" size="10" autocapitalize="characters" autocorrect="off"></label><label>SPEED <input type="range" data-s="rate" min=".7" max="1.5" step=".05" value="${S.rate}"></label><label>VOLUME <input type="range" data-s="vol" min="0" max="1" step=".05" value="${S.vol}"></label></div>
        <div class="gnr"><label>DEP RWY <input type="text" data-s="rwyDep" value="${esc(S.rwyDep)}" size="4" placeholder="auto"></label><label>ARR RWY <input type="text" data-s="rwyArr" value="${esc(S.rwyArr)}" size="4" placeholder="auto"></label></div>
        <div class="gnnote">${TTS.ok ? vs.length + ' voices found.' : 'Speech not available - text only.'} Controller tone is simulated; not real ATC. "Control" (en-route) has no frequency in the data.</div>`;
    }
    body.innerHTML = h;
  }
  async function onClick(e) {
    const b = e.target.closest('button'); if (!b) return; unlock(); const a = b.dataset.a, F = F0();
    if (b.dataset.t) { S.tab = b.dataset.t; save(); return drawTab(); }
    const apt = () => { const i = $('#gfn-apt'); const v = ((i && i.value) || S.apt || '').toUpperCase().trim(); S.apt = v; save(); return v; };
    try {
      if (a === 'close') toggle(false);
      else if (a === 'step') { const s = nextStep(); if (s) runStep(s, true); }
      else if (a === 'skip') { const s = nextStep(); if (s) { A.done[s.id] = true; A.t[s.id] = Date.now(); drawTab(); } }
      else if (a === 'repeat') { const l = logLines.find(x => x.who !== 'ME' && x.who !== 'SYS' && x.who !== 'NAV'); if (l) say('atc', l.text.replace(/^/, ''), 'ATC (again)'); }
      else if (a === 'newflight') newFlight();
      else if (a === 'atis-o') atis(F.orig); else if (a === 'atis-d') atis(F.dest);
      else if (a === 'load' || a === 'reload') { const i = apt(); log('SYS', 'Loading ' + i + '…'); const ap = await loadAirport(i, a === 'reload'); await metar(i); log('SYS', 'Loaded ' + i + ' ' + ap.name); drawTab(); }
      else if (a === 'setorig' || a === 'setdest') { const i = apt(); if (F) { F[a === 'setorig' ? 'orig' : 'dest'] = i; F.rteActive = false; safe(() => LO().save()); } if (!APT[i]) await loadAirport(i).catch(() => 0); drawTab(); }
      else if (a && a.startsWith('pt-')) { S.proc.t = a.slice(3); save(); drawTab(); }
      else if (a && a.startsWith('apply-')) { const ic = apt(), list = procList(ic, S.proc.t); apply(ic, list[+a.slice(6)]); }
      else if (a === 'text') { const t = $('#gfn-txt').value, ps = parseText(t); if (!ps.length) return log('SYS', 'No valid procedure found. Check the header line and coordinates.'); const by = {}; ps.forEach(p => (by[p.icao] = by[p.icao] || []).push(p)); Object.entries(by).forEach(([ic, l]) => addProcs(ic, l)); log('SYS', 'Added ' + ps.length + ' procedure(s)'); drawTab(); }
      else if (a === 'clearproc') { const ic = apt(); PROCS[ic] = (PROCS[ic] || loadProcs(ic)).filter(p => p.src === 'GEN'); saveProcs(ic); log('SYS', 'Cleared imported procedures for ' + ic); drawTab(); }
      else if (a === 'arinc') { const ic = apt(), f = $('#gfn-file') && $('#gfn-file').files[0]; if (!f) return log('SYS', 'Choose an ARINC 424 file first'); const wanted = [ic, (F.orig || '').toUpperCase(), (F.dest || '').toUpperCase()].filter(x => /^[A-Z0-9]{4}$/.test(x)); log('SYS', 'Importing for ' + wanted.join(', ') + '…'); const { out, skipped } = await importArincFile(f, wanted);
        addProcsMulti(out, ic); log('SYS', 'Imported ' + out.length + ' procedure variants; ' + skipped + ' legs without a fixed position skipped'); drawTab(); }
    } catch (err) { log('SYS', (a || 'error') + ': ' + (err && err.message ? err.message : err)); }
  }
  function addProcsMulti(out, fallback) { const by = {}; out.forEach(p => { const i = p.ap || fallback; (by[i] = by[i] || []).push(p); }); Object.entries(by).forEach(([i, l]) => addProcs(i, l, 'ARINC')); }
  function onChange(e) {
    const el = e.target.closest('[data-s]'); if (!el) return; const p = el.dataset.s; let v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value; if (el.type === 'text' && (p === 'rwyDep' || p === 'rwyArr')) v = v.toUpperCase().trim();
    setp(S, p, v); save();
  }
  document.addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyN') { e.preventDefault(); toggle(); } });

  /* ───────────────────────── boot ───────────────────────── */
  function boot() {
    if (!document.body || !document.head) return setTimeout(boot, 800);
    if (!safe(() => window.geofs && geofs.animation && geofs.animation.values, null)) return setTimeout(boot, 1500);
    build();
    let tries = 0; const iv = setInterval(() => { if (installPages() || ++tries > 40) clearInterval(iv); }, 1500);
    setInterval(() => { try { if (!window.GeoFSATC) atcTick(); } catch (e) { /* ignore */ } }, 1000);
    window.GeoFSNavATC = { version: VERSION, open: () => toggle(true), close: () => toggle(false), loadAirport, metar, parseText, parseArinc: txt => buildArinc(arincLines(String(txt).split(/\r?\n/), new Set(['*']))), generated, apply, procs: PROCS, atis, state: S, atc: A, steps: STEPS, newFlight, say, apt: APT, wx: WX, freqOf, bestRwy, rwy, shortName, procList, _internals: { arincLines, buildArinc, coord, csv } };
    console.log('[GeoFS Nav/ATC] loaded. Alt+N = panel, CDU DEP ARR key = procedures.');
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
GeoFSDock.add('#gfn-tab', 5);
