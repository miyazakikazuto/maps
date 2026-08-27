// geo.js — pure helper functions (no browser deps, testable in Node)
// Slippy-map tile math + GeoJSON builder/parser + haversine distance.

export function lon2tile(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

export function lat2tile(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
}

// b = { west, east, north, south }
export function tileRangeForBounds(b, minZoom, maxZoom) {
  const out = {};
  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = lon2tile(b.west, z);
    const xMax = lon2tile(b.east, z);
    const yMin = lat2tile(b.north, z);
    const yMax = lat2tile(b.south, z);
    out[z] = {
      xMin: Math.min(xMin, xMax),
      xMax: Math.max(xMin, xMax),
      yMin: Math.min(yMin, yMax),
      yMax: Math.max(yMin, yMax),
    };
  }
  return out;
}

export function buildGeoJSON(points, name = "Hiking Track") {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          name,
          points: points.length,
          startedAt: points[0]?.t ?? null,
          endedAt: points[points.length - 1]?.t ?? null,
        },
        geometry: {
          type: "LineString",
          coordinates: points.map((p) => [p.lng, p.lat, p.alt ?? null]),
        },
      },
    ],
  };
}

// Parse a GeoJSON (FeatureCollection with LineString) back into point array.
export function parseGeoJSON(gj) {
  const feats = (gj && gj.features ? gj.features : []).filter(
    (f) => f.geometry && f.geometry.type === "LineString"
  );
  const pts = [];
  for (const f of feats) {
    for (const c of f.geometry.coordinates) {
      pts.push({ lng: c[0], lat: c[1], alt: c[2] ?? null, t: null });
    }
  }
  return pts;
}

// Total positive elevation gain (meters) from a track with altitude.
export function elevationGain(points) {
  let gain = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].alt;
    const b = points[i].alt;
    if (a != null && b != null && b > a) gain += b - a;
  }
  return gain;
}

// ---- GPX support (XML, standar GPS Garmin/OsmAnd/dll) ----
function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );
}

export function buildGPX(points, name = "Hiking Track") {
  const seg = points
    .map((p) => {
      const ele = p.alt != null ? `      <ele>${p.alt}</ele>\n` : "";
      const time = p.t ? `      <time>${new Date(p.t).toISOString()}</time>\n` : "";
      return `    <trkpt lat="${p.lat}" lon="${p.lng}">\n${ele}${time}    </trkpt>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailGPS" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${seg}
    </trkseg>
  </trk>
</gpx>`;
}

export function parseGPX(xml) {
  const re =
    /<(?:trkpt|rtept|wpt)\s+lat="(-?\d+(?:\.\d+)?)"\s+lon="(-?\d+(?:\.\d+)?)"[^>]*>([\s\S]*?)<\/(?:trkpt|rtept|wpt)>/g;
  const pts = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    const inner = m[3];
    const eleM = /<ele>([\s\S]*?)<\/ele>/.exec(inner);
    const timeM = /<time>([\s\S]*?)<\/time>/.exec(inner);
    pts.push({
      lat,
      lng,
      alt: eleM ? parseFloat(eleM[1]) : null,
      t: timeM ? Date.parse(timeM[1]) : null,
    });
  }
  return pts;
}

// Auto-detect format from content + filename: GPX or GeoJSON.
export function parseTrack(content, filename = "") {
  const trimmed = (content || "").trim();
  const looksGpx =
    /<gpx|<trkpt|<rtept|<wpt/i.test(trimmed) || /\.gpx$/i.test(filename);
  if (looksGpx) return parseGPX(trimmed);
  // try GeoJSON first, fall back to GPX if it wasn't actually JSON
  try {
    return parseGeoJSON(JSON.parse(trimmed));
  } catch (e) {
    return parseGPX(trimmed);
  }
}

export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
