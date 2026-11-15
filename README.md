# GEOFS-ADDON-PACK-777W-
Overhead (Alt+O). The overhead panel. It simulates APU, electrics (generators, buses, battery), hydraulics, pressurisation, engines, fuel pumps, lights, anti-ice and warnings.

Lower Panel (Pedestal). Three CDUs, with the FMC route, LNAV, V-speeds and fuel/weights. It also holds the radios (VHF 1–3, HF 1–2), transponder, baro and the pedestal controls.

EICAS (Alt+I). Engine gauges and alerts on top, plus eight pages: ENG, ELEC, HYD, FUEL, AIR, GEAR, FCTL and STAT. Gear, flaps and brake positions are real. N1, N2, EGT, fuel flow and fuel quantity are modelled from the throttle, because GeoFS exposes no engine data.

EFB. Live moving map, performance and notes.

Crew (VOICE and CLOCK). Checklist callouts, cabin announcements and sounds, and the UTC clock.

Nav Data (Alt+N). Airports, runways, SIDs, STARs and METAR through the CDU.

PERF (a CDU page, no tab). Trip and performance estimates. It warns DESCENT NOW and INSUFFICIENT FUEL.

SimBrief (Alt+B). Fetches your latest plan, or takes pasted JSON, and loads route, SID/STAR, weights and fuel into the CDU.

CrewLink (Alt+J). Links two devices peer-to-peer: the guest mirrors the host’s cockpit, CDU and radios. Optional extras are shared flight controls and same-aircraft motion mirroring, both experimental.

Turnaround (Alt+G, new). Runs deplane, clean, cater, fuel, bags, boarding and doors. Fuel fills the EICAS tanks to your CDU or SimBrief figure, and the ground crew speak their callouts. At 10x a full turn takes about 6 minutes, and it pauses if the aircraft moves. GeoFS has no ground vehicles or doors, so nothing appears outside.

ATC (Alt+T). The big one, with these tabs:

COMMS. Free-text transmissions with readback checking, plus request buttons for clearance, pushback, taxi, takeoff, centre check-in and the rest.
AIRSPACE. Live map with FIR boundaries and oceanic zones, and which FIR you are in.
RADIO, TCAS, CPDLC, GATE, SET.
Weather. ATIS comes from the real METAR, and the in-game wind is used instead if you turn that on in SET.

New in this version:

Datalink clearance (DCL). A request button at large airports. The clearance, squawk and frequency arrive as a CPDLC message, and accepting it moves you on to pushback. This also fixes an old bug where pushback and taxi never appeared after clearance.
Oceanic. Log on with the centre code (CDU ATC → LOGON/STATUS), make position reports, SELCAL checks and HF tuning.
Controller behaviour.
Holds, at about a 15% chance (setting in SET).
STAR altitude checks.
Runway crossings: hold short, then cross after about 9 s, with incursion warnings.
Runway changes when the wind shifts.
Other aircraft chatter on the frequency.
Frequencies. A bulk-paste import box in SET (WMFC 132.55, or KZAK HF 8.891) and an OpenAIP lookup.
