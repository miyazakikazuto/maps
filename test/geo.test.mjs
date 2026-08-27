// test/geo.test.mjs — pure-logic tests for geo.js (run: node test/geo.test.mjs)
import assert from "node:assert";
import {
  lon2tile,
  lat2tile,
  tileRangeForBounds,
  buildGeoJSON,
  buildGPX,
  parseGeoJSON,
  parseGPX,
  parseTrack,
  elevationGain,
  distanceMeters,
  offRouteMeters,
} from "../geo.js";

// Tile math — world bounds at zoom 0 is a single tile (0,0)
assert.strictEqual(lon2tile(0, 0), 0);
assert.strictEqual(lat2tile(0, 0), 0);
assert.strictEqual(lon2tile(0, 1), 1);

// Jakarta area tiles are integers and in range
const x = lon2tile(106.8, 13);
const y = lat2tile(-6.2, 13);
assert.ok(Number.isInteger(x) && Number.isInteger(y));

// tile range for a small bounds
const r = tileRangeForBounds(
  { west: 106.7, east: 106.9, north: -6.1, south: -6.3 },
  13,
  13
);
assert.ok(r[13].xMax >= r[13].xMin);
assert.ok(r[13].yMax >= r[13].yMin);

// GeoJSON builder
const pts = [
  { lat: -6.2, lng: 106.8, alt: 1000, t: 1 },
  { lat: -6.21, lng: 106.81, alt: 1010, t: 2 },
];
const gj = buildGeoJSON(pts, "Test");
assert.strictEqual(gj.type, "FeatureCollection");
assert.strictEqual(gj.features[0].geometry.type, "LineString");
assert.strictEqual(gj.features[0].geometry.coordinates.length, 2);
assert.deepStrictEqual(gj.features[0].geometry.coordinates[0], [106.8, -6.2, 1000]);

// GeoJSON round-trip: build -> parse
const back = parseGeoJSON(gj);
assert.strictEqual(back.length, 2);
assert.strictEqual(back[0].lat, -6.2);
assert.strictEqual(back[1].alt, 1010);

// parseGeoJSON ignores non-LineString features
const mixed = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] } },
    { type: "Feature", geometry: { type: "LineString", coordinates: [[1, 2, 3], [4, 5, 6]] } },
  ],
};
assert.strictEqual(parseGeoJSON(mixed).length, 2);

// elevationGain counts only positive deltas
assert.strictEqual(
  elevationGain([{ alt: 100 }, { alt: 110 }, { alt: 105 }, { alt: 120 }]),
  25
);
assert.strictEqual(elevationGain([{ alt: null }, { alt: 10 }]), 0);

// GPX build -> parse round-trip
const gpx = buildGPX(pts, "Gunung");
assert.ok(gpx.includes("<gpx"));
assert.ok(gpx.includes('lat="-6.2"'));
const gpxBack = parseGPX(gpx);
assert.strictEqual(gpxBack.length, 2);
assert.strictEqual(gpxBack[0].lat, -6.2);
assert.strictEqual(gpxBack[1].alt, 1010);

// GPX dengan namespace prefix + single quote + whitespace (Garmin/OsmAnd style)
const gpxNs = `<?xml version="1.0"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">
  <trk><trkseg>
    <gpxx:trkpt lat='-6.2' lon='106.8' >
      <ele> 1000 </ele>
    </gpxx:trkpt>
    <wpt lat='-6.21' lon='106.81'><ele>1010</ele></wpt>
  </trkseg></trk>
</gpx>`;
const nsBack = parseGPX(gpxNs);
assert.strictEqual(nsBack.length, 2);
assert.strictEqual(nsBack[0].lat, -6.2);
assert.strictEqual(nsBack[0].alt, 1000);
assert.strictEqual(nsBack[1].lng, 106.81);

// parseTrack auto-detects GPX vs GeoJSON by content + filename
assert.strictEqual(parseTrack(gpx, "x.gpx").length, 2);
assert.strictEqual(parseTrack(JSON.stringify(gj), "x.geojson").length, 2);
assert.strictEqual(parseTrack(gpx).length, 2); // content-only detection

// distance: two close points -> small positive meters
const d = distanceMeters({ lat: -6.2, lng: 106.8 }, { lat: -6.21, lng: 106.81 });
assert.ok(d > 0 && d < 100000);

// distance zero for identical point
assert.strictEqual(distanceMeters({ lat: 1, lng: 1 }, { lat: 1, lng: 1 }), 0);

// offRouteMeters: titik di atas garis -> ~0; titik jauh -> besar
const line = [
  { lat: -6.200, lng: 106.800 },
  { lat: -6.201, lng: 106.801 },
];
const onLine = { lat: -6.2005, lng: 106.8005 };
assert.ok(offRouteMeters(onLine, line) < 5);
const far = { lat: -6.210, lng: 106.810 };
assert.ok(offRouteMeters(far, line) > 1000);
// line kosong -> Infinity (tidak ada trail)
assert.strictEqual(offRouteMeters({ lat: 0, lng: 0 }, []), Infinity);

console.log("ALL GEO TESTS PASSED ✅");
