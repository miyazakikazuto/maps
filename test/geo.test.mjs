// test/geo.test.mjs — pure-logic tests for geo.js (run: node test/geo.test.mjs)
import assert from "node:assert";
import {
  lon2tile,
  lat2tile,
  tileRangeForBounds,
  buildGeoJSON,
  parseGeoJSON,
  elevationGain,
  distanceMeters,
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

// distance: two close points -> small positive meters
const d = distanceMeters({ lat: -6.2, lng: 106.8 }, { lat: -6.21, lng: 106.81 });
assert.ok(d > 0 && d < 100000);

// distance zero for identical point
assert.strictEqual(distanceMeters({ lat: 1, lng: 1 }, { lat: 1, lng: 1 }), 0);

console.log("ALL GEO TESTS PASSED ✅");
