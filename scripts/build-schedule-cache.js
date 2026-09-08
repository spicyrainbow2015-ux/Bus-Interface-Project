// Run this manually (node scripts/build-schedule-cache.js) whenever the
// tracked stop/route combos change, or if SEPTA publishes a new schedule
// season and the arrivals start looking off (a few times a year at most).
//
// Why this exists: api/stop-status.js originally downloaded and parsed
// SEPTA's ~21MB GTFS zip on every cold serverless start. That's slow and,
// worse, occasionally slow enough to blow past the function's execution
// timeout — which is exactly what caused the live site to get stuck on
// "Loading…" (the fetch failed/timed out, and the frontend had nothing to
// fall back to). Precomputing the lookup here and committing the small
// result means the deployed function reads a local JSON file instead of
// downloading anything for this part — fast and reliable.
//
// Add a new stop/route combo by adding it to TARGETS below and re-running.

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TARGETS = [
  { stopId: '590', routes: ['21'] }, // Chestnut St & 43rd St
];

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

async function main() {
  console.log('Downloading SEPTA GTFS static schedule...');
  const zipRes = await fetch('https://www3.septa.org/developer/gtfs_public.zip');
  if (!zipRes.ok) throw new Error('Download failed: ' + zipRes.status);
  const outerZip = await JSZip.loadAsync(await zipRes.arrayBuffer());
  const busZipBuf = await outerZip.file('google_bus.zip').async('nodebuffer');
  const zip = await JSZip.loadAsync(busZipBuf);

  const tripsText = await zip.file('trips.txt').async('string');
  const tripLines = tripsText.split(/\r?\n/).filter(Boolean);
  const tripsHeader = splitCsvLine(tripLines[0]);
  const routeIdCol = tripsHeader.indexOf('route_id');
  const tripIdColT = tripsHeader.indexOf('trip_id');

  const stopTimesText = await zip.file('stop_times.txt').async('string');
  const stLines = stopTimesText.split(/\r?\n/).filter(Boolean);
  const stHeader = splitCsvLine(stLines[0]);
  const tripIdColS = stHeader.indexOf('trip_id');
  const stopIdCol = stHeader.indexOf('stop_id');
  const arrivalCol = stHeader.indexOf('arrival_time');

  const cache = {};

  for (const { stopId, routes } of TARGETS) {
    console.log(`Building lookup for stop ${stopId}, routes ${routes.join(',')}...`);
    const routeIdSet = new Set(routes);
    const tripIdSet = new Set();
    for (let i = 1; i < tripLines.length; i++) {
      const cols = splitCsvLine(tripLines[i]);
      if (routeIdSet.has(cols[routeIdCol])) tripIdSet.add(cols[tripIdColT]);
    }

    const tripToSeconds = {};
    const stopNeedle = ',' + stopId + ',';
    for (let i = 1; i < stLines.length; i++) {
      const line = stLines[i];
      if (!line.includes(stopNeedle)) continue;
      const cols = splitCsvLine(line);
      if (cols[stopIdCol] !== stopId) continue;
      if (!tripIdSet.has(cols[tripIdColS])) continue;
      const [h, m, s] = cols[arrivalCol].split(':').map(Number);
      tripToSeconds[cols[tripIdColS]] = h * 3600 + m * 60 + s;
    }

    const key = routes.slice().sort().join(',') + '|' + stopId;
    cache[key] = tripToSeconds;
    console.log(`  -> ${Object.keys(tripToSeconds).length} trips found`);
  }

  const out = { generatedAt: new Date().toISOString(), cache };
  const outPath = path.join(__dirname, '..', 'api', 'schedule-cache.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('Wrote ' + outPath);
}

main().catch(err => { console.error(err); process.exit(1); });
