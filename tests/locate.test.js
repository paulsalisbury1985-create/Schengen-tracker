// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../locate.js');
const exifr = require('../vendor/exifr.lite.umd.js');

L.setBoundaries(JSON.parse(fs.readFileSync(path.join(__dirname, '../data/countries-50m.json'), 'utf8')));

test('country lookup', () => {
  const cases = [
    [48.8584, 2.2945, 'France', true],      // Paris
    [51.5007, -0.1246, 'United Kingdom', false],
    [43.9356, 12.4473, 'San Marino', true],
    [43.7384, 7.4246, 'Monaco', true],
    [47.1410, 9.5209, 'Liechtenstein', true],
    [35.8989, 14.5146, 'Malta', true],
    [28.1235, -15.4363, 'Spain', true],     // Las Palmas, Canaries
    [42.6977, 23.3219, 'Bulgaria', true],
    [34.6786, 33.0413, 'Cyprus', false],   // Limassol
    [53.3498, -6.2603, 'Ireland', false],
    [40.7484, -73.9857, 'United States', false],
    [43.2965, 5.3698, 'France', true],      // Marseille old port (coastal)
  ];
  for (const [lat, lon, name, sch] of cases) {
    const r = L.lookup(lat, lon);
    assert.ok(r, `no country for ${name}`);
    assert.equal(r.country, name);
    assert.equal(r.schengen, sch, name);
  }
  assert.deepEqual(L.lookup(4.9224, -52.3135), { country: 'France (overseas)', schengen: false }); // Cayenne
  assert.equal(L.lookup(78.2232, 15.6267).schengen, false);  // Svalbard
  assert.equal(L.lookup(40, -40), null);                     // mid-Atlantic
  assert.equal(L.lookup(0, 0), null);
});

test('local dates', () => {
  assert.equal(L.localDate('2025:06:03 23:50:00'), '2025-06-03');            // EXIF, naive local
  assert.equal(L.localDate('2025-06-03T23:30:00.000+02:00'), '2025-06-03');  // explicit offset
  assert.equal(L.localDate('2025-06-03T23:30:00Z', 30), '2025-06-04');      // UTC → east
  assert.equal(L.localDate('2025-06-04T02:00:00Z', -75), '2025-06-03');     // UTC → west
  assert.equal(L.localDate('1748995200000', 0), '2025-06-04');               // ms epoch
});

test('Records.json', () => {
  const r = L.parseJSON({ locations: [
    { latitudeE7: 488584000, longitudeE7: 22945000, timestamp: '2025-06-03T10:00:00Z' },
    { latitudeE7: 515007000, longitudeE7: -1246000, timestampMs: '1749117600000' },
  ]});
  assert.match(r.kind, /Records/);
  assert.deepEqual(r.points.map(p => p.date), ['2025-06-03', '2025-06-05']);
});

test('semantic location history spans multi-day visits', () => {
  const r = L.parseJSON({ timelineObjects: [
    { placeVisit: { location: { latitudeE7: 523676000, longitudeE7: 49041000 },
      duration: { startTimestamp: '2025-04-13T14:00:00Z', endTimestamp: '2025-04-16T09:00:00Z' } } },
    { activitySegment: { startLocation: { latitudeE7: 523676000, longitudeE7: 49041000 },
      endLocation: { latitudeE7: 515007000, longitudeE7: -1246000 },
      duration: { startTimestamp: '2025-04-16T09:00:00Z', endTimestamp: '2025-04-16T15:00:00Z' } } },
  ]});
  assert.deepEqual([...new Set(r.points.map(p => p.date))], ['2025-04-13', '2025-04-14', '2025-04-15', '2025-04-16']);
});

test('on-device Android export', () => {
  const r = L.parseJSON({ semanticSegments: [
    { startTime: '2025-08-01T10:00:00.000+02:00', endTime: '2025-08-03T09:00:00.000+02:00',
      visit: { topCandidate: { placeLocation: { latLng: '41.3874°, 2.1686°' } } } },
    { startTime: '2025-08-03T09:00:00.000+02:00', endTime: '2025-08-03T13:00:00.000+01:00',
      timelinePath: [{ point: '51.4700°, -0.4543°', time: '2025-08-03T12:00:00.000+01:00' }] },
  ], rawSignals: [{ position: { LatLng: '51.5°, -0.12°', timestamp: '2025-08-04T08:00:00.000+01:00' } }] });
  assert.match(r.kind, /on-device/);
  assert.deepEqual([...new Set(r.points.map(p => p.date))], ['2025-08-01', '2025-08-02', '2025-08-03', '2025-08-04']);
});

test('iOS export', () => {
  const r = L.parseJSON([
    { startTime: '2025-06-01T09:00:00.000+01:00', endTime: '2025-06-01T12:00:00.000+01:00',
      activity: { start: 'geo:51.470000,-0.454300', end: 'geo:38.774200,-9.134200' } },
    { startTime: '2025-06-01T12:00:00.000+01:00', endTime: '2025-06-01T20:00:00.000+01:00',
      timelinePath: [{ point: 'geo:38.72,-9.14', durationMinutesOffsetFromStartTime: '600' }] },
  ]);
  assert.match(r.kind, /iOS/);
  assert.deepEqual(r.points.map(p => p.date), ['2025-06-01', '2025-06-01', '2025-06-01']);
});

test('Google Photos sidecar', () => {
  const r = L.parseJSON({ photoTakenTime: { timestamp: '1749000000' }, geoData: { latitude: 55.6761, longitude: 12.5683 } });
  assert.equal(r.points[0].src, 'photo');
  assert.equal(r.points[0].date, '2025-06-04');
  assert.equal(L.parseJSON({ photoTakenTime: { timestamp: '1749000000' }, geoData: { latitude: 0, longitude: 0 } }).points.length, 0);
});

test('GPX and KML', () => {
  const gpx = `<gpx><trk><trkseg><trkpt lat="47.37" lon="8.54"><ele>400</ele><time>2025-02-10T08:00:00Z</time></trkpt>
    <trkpt lon="8.55" lat="47.38"><time>2025-02-11T08:00:00Z</time></trkpt></trkseg></trk></gpx>`;
  assert.deepEqual(L.parseGPX(gpx).points.map(p => [p.date, p.lat]), [['2025-02-10', 47.37], ['2025-02-11', 47.38]]);
  const kml = `<kml><Document><Placemark><name>Hotel</name><TimeSpan><begin>2025-03-01T15:00:00.000Z</begin><end>2025-03-03T10:00:00.000Z</end></TimeSpan>
    <Point><coordinates>16.37,48.21,0</coordinates></Point></Placemark>
    <Placemark><gx:Track><when>2025-03-05T10:00:00Z</when><gx:coord>19.04 47.50 0</gx:coord></gx:Track></Placemark></Document></kml>`;
  assert.deepEqual(L.parseKML(kml).points.map(p => p.date).sort(), ['2025-03-01', '2025-03-02', '2025-03-03', '2025-03-05']);
});

test('photo EXIF', async () => {
  const read = f => exifr.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f)), L.EXIF_OPTS);
  const paris = L.exifToPoint(await read('paris.jpg')).point;
  assert.equal(paris.date, '2025-06-03');
  assert.ok(Math.abs(paris.lat - 48.8584) < 1e-3 && Math.abs(paris.lon - 2.2945) < 1e-3);
  const nyc = L.exifToPoint(await read('nyc.jpg')).point;
  assert.ok(nyc.lon < -73, 'western longitude is negative');
  assert.equal(L.exifToPoint(await read('nogps.jpg')).reason !== undefined, true);
});

test('day log → stays and Schengen trips, with gap filling', () => {
  const log = {};
  const pts = [
    ['2025-06-01', 51.5, -0.12],    // London
    ['2025-06-02', 51.5, -0.12], ['2025-06-02', 48.85, 2.35],  // fly to Paris
    ['2025-06-03', 48.85, 2.35],
    ['2025-06-07', 48.85, 2.35],    // 3-day gap, same country both sides
    ['2025-06-08', 52.37, 4.9],     // Amsterdam
    ['2025-06-09', 51.5, -0.12],
    ['2025-07-01', 41.39, 2.17],    // Barcelona, far gap
  ].map(([date, lat, lon]) => ({ date, lat, lon, src: 'photo' }));
  L.addPoints(log, pts);
  const days = L.expandDays(log, 7);
  assert.equal(days.filter(d => d.inferred).length, 3);
  const trips = L.schengenTrips(days);
  assert.deepEqual(trips.map(t => [t.enter, t.exit, t.days, t.label]), [
    ['2025-06-02', '2025-06-08', 7, 'France / Netherlands'],
    ['2025-07-01', '2025-07-01', 1, 'Spain'],
  ]);
  const st = L.stays(days);
  assert.deepEqual(st.filter(s => s.country === 'United Kingdom').map(s => [s.start, s.end]),
    [['2025-06-01', '2025-06-02'], ['2025-06-09', '2025-06-09']]);
  assert.equal(L.schengenTrips(L.expandDays(log, 0))[0].exit, '2025-06-03');
});
