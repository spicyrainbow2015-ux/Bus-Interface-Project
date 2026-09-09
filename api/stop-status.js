// GET /api/stop-status?stopId=20976&routes=21,42
//
// Combines three of SEPTA's public feeds into the one shape the rider
// screen actually needs, since no single SEPTA endpoint gives "minutes
// until THIS bus reaches THIS stop":
//
//   1. The static GTFS schedule (gtfs_public.zip) tells us the scheduled
//      time each trip is due at our stop.
//   2. TransitView (live) tells us how many minutes early/late that
//      trip is running right now, plus its estimated seat availability.
//   3. BusDetours (live) gives any active service disruption text.
//
// ETA = scheduled time at our stop + live delay.
//
// Known simplification: SEPTA's live "trip updates" feed (the more
// standard source for per-stop ETAs) was found to be unreliable during
// testing — it didn't consistently include routes 21/42 even while they
// had active buses. This schedule+delay approach avoids depending on
// that feed at all.
//
// Ramp/wheelchair-lift status is not published anywhere by SEPTA and
// stays simulated in the frontend — that's not a gap in this file.

const JSZip = require('jszip');
const PRECOMPUTED = require('./schedule-cache.json');

const GTFS_ZIP_URL = 'https://www3.septa.org/developer/gtfs_public.zip';
const TRANSIT_VIEW_URL = 'https://www3.septa.org/api/TransitView/index.php';
const BUS_DETOURS_URL = 'https://www3.septa.org/api/BusDetours/index.php';

// Cached in module scope so a warm serverless instance reuses it
// instead of re-downloading/re-parsing the GTFS zip on every request.
// A cold start (or a new route list) rebuilds it. If this project ever
// needs to scale past a handful of routes/stops, this in-memory cache
// should move to a real store (e.g. Vercel KV) — module-scope caching
// isn't guaranteed to persist between invocations.
let scheduleCache = null; // { key, tripToInfo: Map<tripId, {seconds, route}>, builtAt }

// Downloading + unzipping SEPTA's ~21MB GTFS zip on every cold serverless
// start was slow enough to occasionally blow past the function's execution
// timeout, which left the live site stuck on "Loading…" forever (the fetch
// just failed silently). For any stop/route combo precomputed by
// scripts/build-schedule-cache.js, read the small local JSON instead —
// near-instant, no network call, no timeout risk. Anything not in that
// file falls back to the live download below (slower, but still correct).
function precomputedLookup(routeIds, stopId) {
  const key = routeIds.slice().sort().join(',') + '|' + stopId;
  const raw = PRECOMPUTED.cache && PRECOMPUTED.cache[key];
  if (!raw) return null;
  return new Map(Object.entries(raw).map(([tripId, info]) => [tripId, { seconds: info.seconds, route: info.route }]));
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseTimeToSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

async function buildScheduleLookup(routeIds, stopId) {
  const key = routeIds.slice().sort().join(',') + '|' + stopId;

  const precomputed = precomputedLookup(routeIds, stopId);
  if (precomputed) return precomputed;

  const isFresh = scheduleCache && scheduleCache.key === key && (Date.now() - scheduleCache.builtAt) < 6 * 60 * 60 * 1000;
  if (isFresh) return scheduleCache.tripToInfo;

  const zipRes = await fetch(GTFS_ZIP_URL);
  if (!zipRes.ok) throw new Error('Could not download GTFS static schedule (' + zipRes.status + ')');
  const zipBuf = await zipRes.arrayBuffer();
  const outerZip = await JSZip.loadAsync(zipBuf);
  // gtfs_public.zip is a zip of zips — the bus schedule is nested inside.
  const busZipBuf = await outerZip.file('google_bus.zip').async('nodebuffer');
  const zip = await JSZip.loadAsync(busZipBuf);

  // 1. trips.txt -> which trip_ids belong to our routes, and which route each is
  const tripsText = await zip.file('trips.txt').async('string');
  const tripLines = tripsText.split(/\r?\n/).filter(Boolean);
  const tripsHeader = splitCsvLine(tripLines[0]);
  const routeIdCol = tripsHeader.indexOf('route_id');
  const tripIdColT = tripsHeader.indexOf('trip_id');
  const routeIdSet = new Set(routeIds);
  const tripIdToRoute = new Map();
  for (let i = 1; i < tripLines.length; i++) {
    const cols = splitCsvLine(tripLines[i]);
    if (routeIdSet.has(cols[routeIdCol])) tripIdToRoute.set(cols[tripIdColT], cols[routeIdCol]);
  }

  // 2. stop_times.txt -> for those trips, what time do they hit our stop
  const stopTimesText = await zip.file('stop_times.txt').async('string');
  const stLines = stopTimesText.split(/\r?\n/).filter(Boolean);
  const stHeader = splitCsvLine(stLines[0]);
  const tripIdColS = stHeader.indexOf('trip_id');
  const stopIdCol = stHeader.indexOf('stop_id');
  const arrivalCol = stHeader.indexOf('arrival_time');

  const tripToInfo = new Map();
  // Cheap substring pre-check before splitting every line — stop_times.txt
  // covers the whole system and can be large; most lines aren't ours.
  const stopNeedle = ',' + stopId + ',';
  for (let i = 1; i < stLines.length; i++) {
    const line = stLines[i];
    if (!line.includes(stopNeedle)) continue;
    const cols = splitCsvLine(line);
    if (cols[stopIdCol] !== stopId) continue;
    const route = tripIdToRoute.get(cols[tripIdColS]);
    if (!route) continue;
    tripToInfo.set(cols[tripIdColS], { seconds: parseTimeToSeconds(cols[arrivalCol]), route });
  }

  scheduleCache = { key, tripToInfo, builtAt: Date.now() };
  return tripToInfo;
}

// SEPTA's schedule times are wall-clock Eastern time. This finds the UTC
// instant of Eastern midnight "today" without pulling in a timezone
// library — reconstruct "now" as formatted for America/New_York, read
// its hours/min/sec, and subtract that from the real current instant.
function easternMidnightUtcMs() {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const secondsSinceMidnight = eastern.getHours() * 3600 + eastern.getMinutes() * 60 + eastern.getSeconds();
  return now.getTime() - secondsSinceMidnight * 1000;
}

const SEAT_TO_FULLNESS = {
  EMPTY: 'available',
  MANY_SEATS_AVAILABLE: 'available',
  FEW_SEATS_AVAILABLE: 'holding',
  STANDING_ROOM_ONLY: 'full',
  CRUSHED_STANDING_ROOM_ONLY: 'full',
  FULL: 'full',
};

async function fetchTransitView(route) {
  const res = await fetch(`${TRANSIT_VIEW_URL}?route=${encodeURIComponent(route)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.bus) ? data.bus : [];
}

async function fetchDetours(route) {
  const res = await fetch(`${BUS_DETOURS_URL}?route=${encodeURIComponent(route)}`);
  if (!res.ok) return [];
  const data = await res.json();
  const entry = Array.isArray(data) ? data[0] : null;
  if (!entry || !Array.isArray(entry.route_info)) return [];
  return entry.route_info
    .filter(r => r.current_message && r.current_message.trim())
    .map(r => ({ route, message: r.current_message.trim() }));
}

module.exports = async (req, res) => {
  const stopId = String(req.query.stopId || '20976');
  const routes = String(req.query.routes || '21,42').split(',').map(s => s.trim()).filter(Boolean);

  res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=40');

  try {
    const [tripToInfo, transitViewByRoute, detoursByRoute] = await Promise.all([
      buildScheduleLookup(routes, stopId),
      Promise.all(routes.map(fetchTransitView)),
      Promise.all(routes.map(fetchDetours)),
    ]);

    const midnightUtcMs = easternMidnightUtcMs();
    const arrivals = [];
    const matchedTripIds = new Set();

    // Pass 1: buses SEPTA is actively tracking right now — real ETA
    // (scheduled time + live delay) and real seat availability.
    routes.forEach((route, i) => {
      for (const v of transitViewByRoute[i]) {
        if (!v.VehicleID || v.VehicleID === 'None') continue; // known TransitView placeholder rows
        if (typeof v.late !== 'number' || Math.abs(v.late) > 180) continue;

        const info = tripToInfo.get(v.trip);
        if (!info) continue; // this trip doesn't serve our stop

        const scheduledMs = midnightUtcMs + info.seconds * 1000;
        const arrivalMs = scheduledMs + v.late * 60000;
        const etaMinutes = Math.round((arrivalMs - Date.now()) / 60000);
        if (etaMinutes < -3 || etaMinutes > 90) continue; // already passed, or too far out to trust

        matchedTripIds.add(v.trip);
        arrivals.push({
          route,
          vehicleId: v.VehicleID,
          etaMinutes,
          arrivalTimeIso: new Date(arrivalMs).toISOString(),
          live: true,
          direction: v.Direction || null,
          destination: v.destination || null,
          fullness: SEAT_TO_FULLNESS[v.estimated_seat_availability] || null,
          seatAvailabilityRaw: v.estimated_seat_availability || null,
        });
      }
    });

    // Pass 2: SEPTA hasn't dispatched/tracked a vehicle for a trip yet
    // (common for a bus a while out), but the schedule still says it's
    // coming — show that rather than nothing. No live delay to apply,
    // so this is the timetable's word, not a real-time read.
    //
    // Guard: never let a scheduled guess claim to arrive sooner than a bus
    // SEPTA is actually tracking right now. A trip that should have been
    // dispatched by now but isn't live yet is more likely running late (or
    // skipped) than genuinely "0 min away" — trust the live read over the
    // timetable whenever both are in play.
    const liveEtas = arrivals.filter(a => a.live).map(a => a.etaMinutes);
    const earliestLiveEta = liveEtas.length ? Math.min(...liveEtas) : null;

    for (const [tripId, info] of tripToInfo) {
      if (matchedTripIds.has(tripId)) continue;
      const scheduledMs = midnightUtcMs + info.seconds * 1000;
      const etaMinutes = Math.round((scheduledMs - Date.now()) / 60000);
      if (etaMinutes < -3 || etaMinutes > 90) continue;
      if (earliestLiveEta !== null && etaMinutes <= earliestLiveEta) continue;

      arrivals.push({
        route: info.route,
        vehicleId: null,
        etaMinutes,
        arrivalTimeIso: new Date(scheduledMs).toISOString(),
        live: false,
        direction: null,
        destination: null,
        fullness: null,
        seatAvailabilityRaw: null,
      });
    }

    arrivals.sort((a, b) => a.etaMinutes - b.etaMinutes);

    const disruptions = detoursByRoute.flat();

    res.status(200).json({
      stopId,
      fetchedAt: new Date().toISOString(),
      arrivals,
      disruptions,
    });
  } catch (err) {
    console.error('stop-status error:', err);
    res.status(200).json({
      stopId,
      fetchedAt: new Date().toISOString(),
      arrivals: [],
      disruptions: [],
      error: 'Live SEPTA data temporarily unavailable.',
    });
  }
};
