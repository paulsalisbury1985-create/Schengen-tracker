# Schengen-tracker

Offline PWA that tracks Schengen days (90 days in any rolling 180-day window).

## Tabs

- **Dashboard / Trips / Planner / Backup**: log trips by hand, see the days you've used and plan ahead.
- **Scan**: works out which country you were in on each day from:
  - **Photos**: reads the EXIF date and GPS from JPEG/HEIC files. You can pick photos or a whole folder.
  - **Google Maps Timeline**: the new on-device export (Android `Timeline.json` and the iOS export), plus older Takeout `Records.json` and *Semantic Location History* files.
  - **Google Photos Takeout** `.json` sidecar files, **GPX** tracks and **KML** files.

  It then lists the Schengen trips it found, which you can add to your trips, along with a country-by-country timeline and how many days you spent in each country per year.

Everything runs in the browser. Countries are looked up from the bundled Natural Earth boundaries in `data/countries-50m.json`, so your locations never leave the device.

Notes:
- Days count by local date. A day you spent partly in Schengen counts as a Schengen day.
- If a gap has the same country on both sides, the app fills it in (7 days by default, and you can change this). This covers stretches with no photos.
- Overseas territories (French Guiana, Réunion, Svalbard, etc.) don't count as Schengen. Monaco, San Marino and the Vatican do count.
- Overlapping trips are only counted once.

## Development

Serve the folder with any static server (`python3 -m http.server`) and open `index.html`.

Tests: `node --test tests/locate.test.js`

Third-party: `vendor/exifr.lite.umd.js` ([exifr](https://github.com/MikeKovarik/exifr), MIT), `data/countries-50m.json` ([world-atlas](https://github.com/topojson/world-atlas), ISC / Natural Earth public domain).
