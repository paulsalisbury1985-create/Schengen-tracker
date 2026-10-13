// ── LOCATE ───────────────────────────────────────────────────────────────────
// Turns photo EXIF, Google Maps Timeline exports, GPX and KML files into a
// per-day log of which countries you were in. Everything runs on-device:
// country lookup uses bundled Natural Earth boundaries (data/countries-50m.json),
// so no coordinates ever leave the browser.
(function (root) {
'use strict';

// Schengen members (as of 2025: incl. Bulgaria, Romania, Croatia) by Natural
// Earth name. Åland is Finnish; Monaco, San Marino and the Vatican have open
// borders with Schengen states, so days there count in practice.
const SCHENGEN = new Set([
  'Austria','Belgium','Bulgaria','Croatia','Czechia','Denmark','Estonia','Finland',
  'France','Germany','Greece','Hungary','Iceland','Italy','Latvia','Liechtenstein',
  'Lithuania','Luxembourg','Malta','Netherlands','Norway','Poland','Portugal',
  'Romania','Slovakia','Slovenia','Spain','Sweden','Switzerland','Åland',
  'Monaco','San Marino','Vatican',
]);
// Overseas parts of Schengen states (French Guiana, Réunion, Svalbard...) are
// outside the Schengen area. Canaries, Azores and Madeira are inside this box.
function inSchengenBox(lat, lon) { return lat >= 27 && lat <= 72 && lon >= -32 && lon <= 45; }

const NAME_FIX = {
  'United States of America':'United States', 'Bosnia and Herz.':'Bosnia and Herzegovina',
  'Dominican Rep.':'Dominican Republic', 'Czechia':'Czechia', 'Macedonia':'North Macedonia',
  'Dem. Rep. Congo':'DR Congo', 'Central African Rep.':'Central African Republic',
  'Eq. Guinea':'Equatorial Guinea', 'S. Sudan':'South Sudan', 'Faeroe Is.':'Faroe Islands',
  'N. Cyprus':'Northern Cyprus', 'W. Sahara':'Western Sahara', 'eSwatini':'Eswatini',
};

// ── COUNTRY LOOKUP ───────────────────────────────────────────────────────────
let countries = null;           // [{name, bbox, rings:[Float64Array]}]
const cache = new Map();

function decodeTopo(topo) {
  const tf = topo.transform;
  const arcs = topo.arcs.map(arc => {
    const out = new Float64Array(arc.length * 2);
    let x = 0, y = 0;
    for (let i = 0; i < arc.length; i++) {
      if (tf) { x += arc[i][0]; y += arc[i][1];
        out[i*2] = x * tf.scale[0] + tf.translate[0]; out[i*2+1] = y * tf.scale[1] + tf.translate[1]; }
      else { out[i*2] = arc[i][0]; out[i*2+1] = arc[i][1]; }
    }
    return out;
  });
  function ring(idxs) {
    const pts = [];
    idxs.forEach((ai, k) => {
      const a = arcs[ai < 0 ? ~ai : ai], n = a.length / 2;
      for (let j = 0; j < n; j++) {
        const p = ai < 0 ? n - 1 - j : j;
        if (k > 0 && j === 0) continue;   // shared vertex with previous arc
        pts.push(a[p*2], a[p*2+1]);
      }
    });
    return Float64Array.from(pts);
  }
  return topo.objects.countries.geometries.flatMap(g => {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
    const rings = polys.flatMap(p => p.map(ring));
    if (!rings.length) return [];
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    rings.forEach(r => { for (let i = 0; i < r.length; i += 2) {
      if (r[i] < bbox[0]) bbox[0] = r[i]; if (r[i+1] < bbox[1]) bbox[1] = r[i+1];
      if (r[i] > bbox[2]) bbox[2] = r[i]; if (r[i+1] > bbox[3]) bbox[3] = r[i+1]; } });
    const raw = g.properties.name;
    return [{ name: NAME_FIX[raw] || raw, raw, bbox, rings }];
  });
}

// Smallest first, so enclaves (Vatican, San Marino, Lesotho) win over the
// country around them when the simplified outlines overlap.
function setBoundaries(topo) {
  const area = c => (c.bbox[2] - c.bbox[0]) * (c.bbox[3] - c.bbox[1]);
  countries = decodeTopo(topo).sort((a, b) => area(a) - area(b));
  cache.clear();
}

let loading = null;
function loadBoundaries(url) {
  if (countries) return Promise.resolve();
  if (!loading) loading = fetch(url || 'data/countries-50m.json')
    .then(r => { if (!r.ok) throw new Error('Could not load country boundaries'); return r.json(); })
    .then(setBoundaries)
    .catch(e => { loading = null; throw e; });
  return loading;
}

function inside(c, lon, lat) {
  let hit = false;   // even-odd over all rings handles holes and multipolygons
  for (const r of c.rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i+1], yj = r[j+1];
      if ((yi > lat) !== (yj > lat) && lon < (r[j] - r[i]) * (lat - yi) / (yj - yi) + r[i]) hit = !hit;
    }
  }
  return hit;
}

// Approximate km from a point to a country's border (for coastal / harbour fixes
// that fall just outside the simplified coastline).
function distKm(c, lon, lat) {
  const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
  let best = Infinity;
  for (const r of c.rings) {
    for (let i = 2; i < r.length; i += 2) {
      const ax = (r[i-2] - lon) * kx, ay = (r[i-1] - lat) * ky;
      const bx = (r[i] - lon) * kx,   by = (r[i+1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, L = dx*dx + dy*dy;
      const t = L ? Math.max(0, Math.min(1, -(ax*dx + ay*dy) / L)) : 0;
      const px = ax + t*dx, py = ay + t*dy, d = px*px + py*py;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

const NEAR_KM = 25;

function lookup(lat, lon) {
  if (!countries) throw new Error('Boundaries not loaded');
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;    // "no location" placeholder
  const key = Math.round(lat * 200) + ',' + Math.round(lon * 200);   // ~500 m grid
  if (cache.has(key)) return cache.get(key);
  let found = null;
  for (const c of countries) {
    const b = c.bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    if (inside(c, lon, lat)) { found = c; break; }
  }
  if (!found) {
    let best = NEAR_KM, pad = NEAR_KM / 50;
    for (const c of countries) {
      const b = c.bbox;
      if (lon < b[0] - pad || lon > b[2] + pad || lat < b[1] - pad || lat > b[3] + pad) continue;
      const d = distKm(c, lon, lat);
      if (d < best) { best = d; found = c; }
    }
  }
  let res = null;
  if (found) {
    const sch = SCHENGEN.has(found.raw);
    res = sch && !inSchengenBox(lat, lon)
      ? { country: found.name + ' (overseas)', schengen: false }
      : { country: found.name, schengen: sch };
  }
  cache.set(key, res);
  return res;
}

function isSchengen(country) {
  return SCHENGEN.has(country) || [...SCHENGEN].some(s => (NAME_FIX[s] || s) === country);
}

// ── DATES ────────────────────────────────────────────────────────────────────
// We want the *local* calendar date at the place you were, because that is what
// Schengen day counting uses.
function pad(n) { return String(n).padStart(2, '0'); }
function utcDay(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`; }

// ISO timestamp → local date. With an explicit offset we can read the date as
// written; for UTC ("Z") we approximate local time from longitude (15° ≈ 1 h).
function localDate(ts, lon) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number' || /^\d{10,13}$/.test(ts)) {
    let ms = +ts; if (ms < 1e11) ms *= 1000;
    return utcDay(ms + (lon || 0) / 15 * 3600000);
  }
  const s = String(ts).trim();
  const m = s.match(/^(\d{4})[-:](\d{2})[-:](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) { const ms = Date.parse(s); return isNaN(ms) ? null : utcDay(ms + (lon || 0) / 15 * 3600000); }
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[7] && m[7].toUpperCase() === 'Z' && m[4] != null) {
    const ms = Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0));
    return utcDay(ms + (lon || 0) / 15 * 3600000);
  }
  return date;    // explicit offset or naive local time (EXIF): date as written
}

function addDay(d, n) {
  const t = Date.UTC(+d.slice(0,4), +d.slice(5,7)-1, +d.slice(8,10)) + n * 86400000;
  return utcDay(t);
}
function daysBetween(a, b) {
  return Math.round((Date.UTC(+b.slice(0,4), +b.slice(5,7)-1, +b.slice(8,10)) -
                     Date.UTC(+a.slice(0,4), +a.slice(5,7)-1, +a.slice(8,10))) / 86400000);
}
function validDay(d) { return typeof d === 'string' && /^(19[7-9]\d|20\d\d)-\d\d-\d\d$/.test(d); }

// ── PARSERS ──────────────────────────────────────────────────────────────────
// Every parser yields points: {date:'YYYY-MM-DD', lat, lon, src:'photo'|'timeline'}

function parseLatLng(s) {
  if (s == null) return null;
  if (typeof s === 'object') {
    if ('latitudeE7' in s) return [s.latitudeE7 / 1e7, s.longitudeE7 / 1e7];
    if ('latE7' in s) return [s.latE7 / 1e7, s.lngE7 / 1e7];
    if ('latitude' in s) return [+s.latitude, +s.longitude];
    if ('LatLng' in s) return parseLatLng(s.LatLng);
    if ('latLng' in s) return parseLatLng(s.latLng);
    return null;
  }
  const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)/);   // "48.85°, 2.35°" / "geo:48.85,2.35"
  return m ? [+m[1], +m[2]] : null;
}

const MAX_SPAN = 62;   // ignore implausible multi-month "visits"

function pushSpan(out, ll, start, end, src) {
  if (!ll) return;
  const a = localDate(start, ll[1]), b = localDate(end, ll[1]) || a;
  if (!validDay(a)) return;
  const n = validDay(b) ? Math.min(Math.max(daysBetween(a, b), 0), MAX_SPAN) : 0;
  for (let i = 0; i <= n; i++) out.push({ date: addDay(a, i), lat: ll[0], lon: ll[1], src });
}
function pushPoint(out, ll, ts, src) {
  if (!ll) return;
  const d = localDate(ts, ll[1]);
  if (validDay(d)) out.push({ date: d, lat: ll[0], lon: ll[1], src });
}

function parseJSON(data) {
  const out = [], T = 'timeline';
  // Google Takeout "Records.json" (raw location history)
  if (data && Array.isArray(data.locations)) {
    for (const l of data.locations) pushPoint(out, parseLatLng(l), l.timestamp || l.timestampMs, T);
    return { kind: 'Google Location History (Records.json)', points: out };
  }
  // Google Takeout "Semantic Location History" monthly files
  if (data && Array.isArray(data.timelineObjects)) {
    for (const o of data.timelineObjects) {
      const v = o.placeVisit, a = o.activitySegment;
      if (v) pushSpan(out, parseLatLng(v.location), v.duration?.startTimestamp || v.duration?.startTimestampMs,
                      v.duration?.endTimestamp || v.duration?.endTimestampMs, T);
      if (a) {
        pushPoint(out, parseLatLng(a.startLocation), a.duration?.startTimestamp || a.duration?.startTimestampMs, T);
        pushPoint(out, parseLatLng(a.endLocation), a.duration?.endTimestamp || a.duration?.endTimestampMs, T);
        for (const p of a.simplifiedRawPath?.points || []) pushPoint(out, parseLatLng(p), p.timestamp || p.timestampMs, T);
        for (const p of a.waypointPath?.waypoints || []) pushPoint(out, parseLatLng(p), a.duration?.startTimestamp, T);
      }
    }
    return { kind: 'Google Semantic Location History', points: out };
  }
  // On-device Timeline export (Android 2024+): {semanticSegments, rawSignals}
  if (data && (Array.isArray(data.semanticSegments) || Array.isArray(data.rawSignals))) {
    for (const s of data.semanticSegments || []) segment(out, s);
    for (const r of data.rawSignals || []) if (r.position) pushPoint(out, parseLatLng(r.position.LatLng || r.position.latLng), r.position.timestamp, T);
    return { kind: 'Google Maps Timeline (on-device export)', points: out };
  }
  // iOS Timeline export: top-level array of segments with "geo:" strings
  if (Array.isArray(data) && data.some(s => s && (s.visit || s.activity || s.timelinePath) && s.startTime)) {
    for (const s of data) segment(out, s);
    return { kind: 'Google Maps Timeline (iOS export)', points: out };
  }
  // Google Photos Takeout sidecar
  if (data && data.photoTakenTime && (data.geoData || data.geoDataExif)) {
    const g = data.geoData && (data.geoData.latitude || data.geoData.longitude) ? data.geoData : data.geoDataExif;
    pushPoint(out, g && (g.latitude || g.longitude) ? [+g.latitude, +g.longitude] : null, data.photoTakenTime.timestamp, 'photo');
    return { kind: 'Google Photos metadata', points: out };
  }
  return { kind: null, points: out };
}

function segment(out, s) {
  const T = 'timeline';
  if (s.visit) {
    const pc = s.visit.topCandidate?.placeLocation;
    pushSpan(out, parseLatLng(pc && (pc.latLng || pc)), s.startTime, s.endTime, T);
  }
  if (s.activity) {
    pushPoint(out, parseLatLng(s.activity.start?.latLng || s.activity.start), s.startTime, T);
    pushPoint(out, parseLatLng(s.activity.end?.latLng || s.activity.end), s.endTime, T);
  }
  if (Array.isArray(s.timelinePath)) {
    const t0 = Date.parse(s.startTime);
    for (const p of s.timelinePath) {
      const ll = parseLatLng(p.point);
      if (p.time) pushPoint(out, ll, p.time, T);
      else if (p.durationMinutesOffsetFromStartTime != null && !isNaN(t0) && ll) {
        // keep the source offset so the local date stays right
        const off = (String(s.startTime).match(/([+-]\d{2}:?\d{2}|Z)$/) || [,'Z'])[1];
        const ms = t0 + (+p.durationMinutesOffsetFromStartTime) * 60000;
        pushPoint(out, ll, off === 'Z' ? new Date(ms).toISOString() : shiftIso(ms, off), T);
      }
    }
  }
}
function shiftIso(ms, off) {
  const sign = off[0] === '-' ? -1 : 1, hm = off.slice(1).replace(':', '');
  const mins = sign * (+hm.slice(0,2) * 60 + +hm.slice(2,4));
  return new Date(ms + mins * 60000).toISOString().slice(0, 19) + off;
}

function attrs(s) {
  const o = {}; s.replace(/([\w:]+)\s*=\s*["']([^"']*)["']/g, (_, k, v) => { o[k] = v; }); return o;
}

function parseGPX(text) {
  const out = [];
  const re = /<(trkpt|wpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(text))) {
    const a = attrs(m[2]), t = (m[4] || '').match(/<time>([^<]+)<\/time>/);
    if (t) pushPoint(out, [+a.lat, +a.lon], t[1].trim(), 'timeline');
  }
  return { kind: 'GPX track', points: out };
}

function parseKML(text) {
  const out = [];
  // gx:Track — parallel <when> and <gx:coord> lists
  for (const tr of text.match(/<gx:Track\b[\s\S]*?<\/gx:Track>/g) || []) {
    const whens = [...tr.matchAll(/<when>([^<]+)<\/when>/g)].map(x => x[1].trim());
    const coords = [...tr.matchAll(/<gx:coord>([^<]+)<\/gx:coord>/g)].map(x => x[1].trim().split(/\s+/).map(Number));
    whens.forEach((w, i) => coords[i] && pushPoint(out, [coords[i][1], coords[i][0]], w, 'timeline'));
  }
  // Placemarks with TimeSpan/TimeStamp + coordinates
  for (const pm of text.replace(/<gx:Track\b[\s\S]*?<\/gx:Track>/g, '').match(/<Placemark\b[\s\S]*?<\/Placemark>/g) || []) {
    const begin = (pm.match(/<begin>([^<]+)<\/begin>/) || pm.match(/<when>([^<]+)<\/when>/) || [])[1];
    const end = (pm.match(/<end>([^<]+)<\/end>/) || [])[1];
    const c = (pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/) || [])[1];
    if (!begin || !c) continue;
    const pts = c.trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(p => p.length >= 2);
    if (!pts.length) continue;
    const first = [pts[0][1], pts[0][0]], last = [pts[pts.length-1][1], pts[pts.length-1][0]];
    if (pts.length === 1) pushSpan(out, first, begin.trim(), end && end.trim(), 'timeline');
    else { pushPoint(out, first, begin.trim(), 'timeline'); pushPoint(out, last, (end || begin).trim(), 'timeline'); }
  }
  return { kind: 'KML', points: out };
}

// EXIF via exifr (vendor/exifr.lite.umd.js). Returns a point or a reason.
const EXIF_OPTS = {
  ifd0: false, ifd1: false, interop: false, xmp: false, icc: false, iptc: false,
  exif: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal'],
  gps: ['GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef', 'GPSDateStamp', 'GPSTimeStamp'],
  reviveValues: false,
};
function exifToPoint(tags) {
  if (!tags) return { reason: 'nometa' };
  let lat = tags.latitude, lon = tags.longitude;
  if (lat == null && Array.isArray(tags.GPSLatitude)) {
    const dms = a => a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600;
    lat = dms(tags.GPSLatitude) * (tags.GPSLatitudeRef === 'S' ? -1 : 1);
    lon = dms(tags.GPSLongitude) * (tags.GPSLongitudeRef === 'W' ? -1 : 1);
  }
  if (lat == null || lon == null || (lat === 0 && lon === 0)) return { reason: 'nogps' };
  let date = localDate(tags.DateTimeOriginal || tags.CreateDate, lon);
  if (!validDay(date) && tags.GPSDateStamp) date = localDate(String(tags.GPSDateStamp).replace(/:/g, '-') + 'T12:00:00Z', lon);
  if (!validDay(date)) return { reason: 'nodate' };
  return { point: { date, lat, lon, src: 'photo' } };
}

async function parseFile(file, exifr) {
  const name = (file.name || '').toLowerCase();
  if (/\.(json)$/.test(name)) {
    let data; try { data = JSON.parse(await file.text()); } catch { return { kind: null, points: [], error: 'Invalid JSON' }; }
    return parseJSON(data);
  }
  if (/\.gpx$/.test(name)) return parseGPX(await file.text());
  if (/\.kml$/.test(name)) return parseKML(await file.text());
  if (/\.(jpe?g|heic|heif|tiff?|png|webp|avif|dng)$/.test(name) || /^image\//.test(file.type || '')) {
    let tags = null;
    try { tags = await exifr.parse(file, EXIF_OPTS); } catch { tags = null; }
    const r = exifToPoint(tags);
    return { kind: 'photo', points: r.point ? [r.point] : [], reason: r.reason };
  }
  return { kind: null, points: [] };
}

// ── DAY LOG ──────────────────────────────────────────────────────────────────
// log = { 'YYYY-MM-DD': { 'France': {p: photoHits, t: timelineHits} } }
function addPoints(log, points) {
  let added = 0;
  const seen = new Set();
  for (const pt of points) {
    // thin dense GPS traces: one lookup per ~1 km cell per day
    const k = pt.date + '|' + Math.round(pt.lat * 100) + '|' + Math.round(pt.lon * 100) + '|' + pt.src;
    if (seen.has(k)) continue;
    seen.add(k);
    const r = lookup(pt.lat, pt.lon);
    if (!r) continue;
    const day = log[pt.date] || (log[pt.date] = {});
    const e = day[r.country] || (day[r.country] = { p: 0, t: 0 });
    e[pt.src === 'photo' ? 'p' : 't']++;
    added++;
  }
  return added;
}

// Expand the log into one entry per day from first to last evidence. Days with
// no evidence are filled when the same country is seen on both sides of a gap of
// at most `fillGap` days (e.g. a week in a hotel where you took no photos).
function expandDays(log, fillGap) {
  const dates = Object.keys(log).filter(validDay).sort();
  const days = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    days.push({ date: d, countries: Object.keys(log[d]), inferred: false });
    const nx = dates[i + 1];
    if (!nx) break;
    const gap = daysBetween(d, nx) - 1;
    if (gap > 0 && gap <= fillGap) {
      const shared = Object.keys(log[d]).filter(c => c in log[nx]);
      if (shared.length) for (let g = 1; g <= gap; g++) days.push({ date: addDay(d, g), countries: shared, inferred: true });
    }
  }
  return days;
}

// Consecutive runs per country: [{country, start, end, days, inferred, schengen}]
function stays(days) {
  const open = new Map(), out = [];
  let prev = null;
  const close = (c) => { out.push(open.get(c)); open.delete(c); };
  for (const d of days) {
    if (prev && daysBetween(prev, d.date) !== 1) [...open.keys()].forEach(close);
    for (const c of [...open.keys()]) if (!d.countries.includes(c)) close(c);
    for (const c of d.countries) {
      const s = open.get(c);
      if (s) { s.end = d.date; s.days++; if (d.inferred) s.inferred++; }
      else open.set(c, { country: c, start: d.date, end: d.date, days: 1, inferred: d.inferred ? 1 : 0, schengen: isSchengen(c) });
    }
    prev = d.date;
  }
  [...open.keys()].forEach(close);
  return out.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.country < b.country ? -1 : 1);
}

// Consecutive days with any Schengen presence → trips in the tracker's format.
function schengenTrips(days) {
  const out = [];
  let cur = null, prev = null;
  for (const d of days) {
    const sch = d.countries.filter(isSchengen);
    if (sch.length && cur && prev && daysBetween(prev, d.date) === 1) {
      cur.exit = d.date; sch.forEach(c => cur.countries.includes(c) || cur.countries.push(c));
      if (d.inferred) cur.inferred++;
    } else if (sch.length) {
      cur = { enter: d.date, exit: d.date, countries: sch.slice(), inferred: d.inferred ? 1 : 0 };
      out.push(cur);
    } else cur = null;
    prev = d.date;
  }
  return out.map(t => ({ ...t, days: daysBetween(t.enter, t.exit) + 1,
    label: t.countries.length > 3 ? t.countries.slice(0, 3).join(' / ') + ' +' + (t.countries.length - 3) : t.countries.join(' / ') }));
}

const api = { SCHENGEN, isSchengen, setBoundaries, loadBoundaries, lookup, localDate, addDay, daysBetween,
  parseLatLng, parseJSON, parseGPX, parseKML, exifToPoint, parseFile, EXIF_OPTS,
  addPoints, expandDays, stays, schengenTrips };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Locate = api;
})(typeof self !== 'undefined' ? self : this);
