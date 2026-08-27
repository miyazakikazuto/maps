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

// Parse GPX: pisahkan track (trkpt/rtept) dari waypoint (wpt) yang punya nama.
// Mengembalikan { track: [{lat,lng,alt,t}], waypoints: [{lat,lng,name}] }
export function parseGPX(xml) {
  const re =
    /<(?:[\w-]+:)?(?:wpt|trkpt|rtept)\b[^>]*?\slat\s*=\s*["'](-?\d+(?:\.\d+)?)["'][^>]*?\slon\s*=\s*["'](-?\d+(?:\.\d+)?)["'][^>]*>([\s\S]*?)<\/(?:[\w-]+:)?(?:wpt|trkpt|rtept)>/gi;
  const track = [];
  const waypoints = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    const inner = m[3];
    const eleM = /<ele>\s*([\s\S]*?)\s*<\/ele>/i.exec(inner);
    const timeM = /<time>\s*([\s\S]*?)\s*<\/time>/i.exec(inner);
    const nameM = /<name>\s*([\s\S]*?)\s*<\/name>/i.exec(inner);
    const isWpt = /wpt/i.test(m[0]);
    if (nameM) {
      // apapun yang punya <name> -> waypoint (pos / puncak), jangan di track
      waypoints.push({ lat, lng, name: nameM[1].trim() });
    } else if (!isWpt) {
      // trkpt/rtept tanpa nama -> track biasa
      track.push({
        lat,
        lng,
        alt: eleM ? parseFloat(eleM[1]) : null,
        t: timeM ? Date.parse(timeM[1]) : null,
      });
    }
    // wpt tanpa nama: abaikan (biasanya cuma tichel)
  }
  return { track, waypoints };
}

// Auto-detect format from content + filename: GPX or GeoJSON.
// GPX mengembalikan { track, waypoints }; GeoJSON hanya track (waypoints=[]).
export function parseTrack(content, filename = "") {
  const trimmed = (content || "").trim();
  const looksGpx =
    /<gpx|<trkpt|<rtept|<wpt/i.test(trimmed) || /\.gpx$/i.test(filename);
  if (looksGpx) {
    const { track, waypoints } = parseGPX(trimmed);
    return { track, waypoints };
  }
  // try GeoJSON first, fall back to GPX if it wasn't actually JSON
  try {
    return { track: parseGeoJSON(JSON.parse(trimmed)), waypoints: [] };
  } catch (e) {
    const { track, waypoints } = parseGPX(trimmed);
    return { track, waypoints };
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

// Proyeksi titik p ke segmen AB (meter). Appro planar — akurat untuk jarak < ~10km.
function pointToSegmentMeters(p, a, b) {
  if (distanceMeters(a, b) < 1e-6) return distanceMeters(p, a);
  const denom = (b.lat - a.lat) ** 2 + (b.lng - a.lng) ** 2;
  if (denom < 1e-12) return distanceMeters(p, a);
  let t = ((p.lat - a.lat) * (b.lat - a.lat) + (p.lng - a.lng) * (b.lng - a.lng)) / denom;
  t = Math.max(0, Math.min(1, t));
  const proj = {
    lat: a.lat + t * (b.lat - a.lat),
    lng: a.lng + t * (b.lng - a.lng),
  };
  return distanceMeters(p, proj);
}

// Auto-generate waypoints dari track jika GPX tidak punya <wpt>:
// - titik pertama (Start), titik tertinggi (Puncak), titik terakhir (Finish)
export function autoWaypoints(track) {
  if (!track || track.length < 2) return [];
  const out = [];
  const first = track[0];
  out.push({ lat: first.lat, lng: first.lng, name: "Start" });
  let peak = track[0];
  for (const p of track) if (p.alt != null && (peak.alt == null || p.alt > peak.alt)) peak = p;
  if (peak !== first && peak !== track[track.length - 1]) {
    out.push({
      lat: peak.lat,
      lng: peak.lng,
      name: "Puncak (" + Math.round(peak.alt) + " m)",
    });
  }
  const last = track[track.length - 1];
  if (last !== first) {
    // jika titik terakhir adalah puncak, namai Puncak bukan Finish
    if (last === peak) {
      out[out.length - 1] = { lat: last.lat, lng: last.lng, name: "Puncak (" + Math.round(last.alt) + " m)" };
    } else {
      out.push({ lat: last.lat, lng: last.lng, name: "Finish" });
    }
  }
  return out;
}

// Jarak terpendek titik p ke polyline (array {lat,lng}). Infinity jika <2 titik.
export function offRouteMeters(p, line) {
  if (!line || line.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = pointToSegmentMeters(p, line[i - 1], line[i]);
    if (d < min) min = d;
  }
  return min;
}
