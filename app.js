// app.js — Trail GPS: rekam jalur pendakian offline via GPS + Leaflet + Service Worker.
import {
  lon2tile,
  lat2tile,
  tileRangeForBounds,
  buildGeoJSON,
  buildGPX,
  parseGeoJSON,
  parseTrack,
  elevationGain,
  distanceMeters,
} from "./geo.js";

const STORE_KEY = "trail-track-v1";
const MIN_MOVE_M = 2; // abaikan titik yg terlalu dekat (kurangi noise)
const MAX_TILES = 4000; // batas download area (etika OSM)

const map = L.map("map", { zoomControl: true }).setView([-6.9, 107.6], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "© OpenStreetMap",
}).addTo(map);

let track = []; // { lat, lng, alt, acc, t }
let totalDist = 0;
let watchId = null;
let followMode = true; // peta otomatis ngikutin posisi saat rekam
let trackLine = L.polyline([], { color: "#22c55e", weight: 4 }).addTo(map);
let trailLine = L.polyline([], {
  color: "#3b82f6",
  weight: 3,
  dashArray: "6,6",
}).addTo(map); // jalur rencana (dari file)
let marker = null;
const el = (id) => document.getElementById(id);

// ---- Service Worker ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .catch((e) => console.warn("SW gagal:", e));
}

// ---- Status jaringan ----
function updateOnline() {
  const on = navigator.onLine;
  el("onlineDot").className = "dot " + (on ? "online" : "offline");
  el("statusText").textContent = on
    ? "Online — tile akan di-cache otomatis"
    : "Offline — pakai tile dari cache";
}
window.addEventListener("online", updateOnline);
window.addEventListener("offline", updateOnline);

// ---- Simpan / muat track ----
function saveTrack() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(track));
  } catch (e) {}
}
function loadTrack() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      track = JSON.parse(raw);
      redraw();
      recomputeDist();
    }
  } catch (e) {}
  updateReadout();
}
function redraw() {
  trackLine.setLatLngs(track.map((p) => [p.lat, p.lng]));
}
function recomputeDist() {
  totalDist = 0;
  for (let i = 1; i < track.length; i++) {
    totalDist += distanceMeters(track[i - 1], track[i]);
  }
}

function updateReadout() {
  el("ptCount").textContent = track.length;
  el("dist").textContent =
    totalDist >= 1000
      ? (totalDist / 1000).toFixed(2) + " km"
      : Math.round(totalDist) + " m";
  const gain = elevationGain(track.map((p) => ({ alt: p.alt })));
  el("gain").textContent = gain > 0 ? "↑ " + Math.round(gain) + " m" : "0 m";
  const last = track[track.length - 1];
  if (last) {
    el("acc").textContent = last.acc ? "±" + Math.round(last.acc) + " m" : "–";
    el("ll").textContent = last.lat.toFixed(5) + ", " + last.lng.toFixed(5);
  }
}

// ---- GPS ----
function onPosition(pos) {
  const { latitude: lat, longitude: lng, altitude: alt, accuracy: acc } =
    pos.coords;
  if (
    track.length &&
    distanceMeters(track[track.length - 1], { lat, lng }) < MIN_MOVE_M
  ) {
    return; // terlalu dekat, skip
  }
  const point = { lat, lng, alt: alt ?? null, acc: acc ?? null, t: Date.now() };
  if (track.length) totalDist += distanceMeters(track[track.length - 1], point);
  track.push(point);
  redraw();
  if (!marker) {
    marker = L.circleMarker([lat, lng], {
      radius: 6,
      color: "#22c55e",
      fillColor: "#22c55e",
      fillOpacity: 1,
    }).addTo(map);
  } else {
    marker.setLatLng([lat, lng]);
  }
  if (followMode) map.panTo([lat, lng]);
  saveTrack();
  updateReadout();
}
function onPositionError(err) {
  el("statusText").textContent = "GPS error: " + err.message;
}

function startRecording() {
  if (!navigator.geolocation) {
    alert("Browser tidak mendukung Geolocation.");
    return;
  }
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 10000,
  });
  el("btnStart").disabled = true;
  el("btnStop").disabled = false;
  el("statusText").textContent = "Merekam…";
}
function stopRecording() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  el("btnStart").disabled = false;
  el("btnStop").disabled = true;
  saveTrack();
  el("statusText").textContent = "Rekam dihentikan";
}

function centerOnMe() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (p) =>
      map.setView(
        [p.coords.latitude, p.coords.longitude],
        Math.max(map.getZoom(), 15)
      ),
    onPositionError,
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ---- Live-follow toggle ----
function toggleFollow() {
  followMode = !followMode;
  el("btnFollow").textContent = followMode ? "🧭 Ikuti: ON" : "🧭 Ikuti: OFF";
}

// ---- Muat trail dari file GeoJSON / GPX (jalur rencana) ----
function loadTrail(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const pts = parseTrack(reader.result, file.name);
      if (!pts.length) {
        alert("Tidak ada titik track di file ini (GeoJSON/GPX).");
        return;
      }
      trailLine.setLatLngs(pts.map((p) => [p.lat, p.lng]));
      map.fitBounds(trailLine.getBounds());
      el("statusText").textContent =
        "Trail dimuat (" + (/\.gpx$/i.test(file.name) ? "GPX" : "GeoJSON") +
        "): " + pts.length + " titik (biru = rencana)";
    } catch (e) {
      alert("Gagal parse file: " + e.message);
    }
  };
  reader.readAsText(file);
}

// ---- Export GeoJSON ----
function exportGeoJSON() {
  if (!track.length) {
    alert("Belum ada titik untuk diekspor.");
    return;
  }
  const gj = buildGeoJSON(track);
  const blob = new Blob([JSON.stringify(gj, null, 2)], {
    type: "application/geo+json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download =
    "track-" +
    new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") +
    ".geojson";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- Export GPX ----
function exportGPX() {
  if (!track.length) {
    alert("Belum ada titik untuk diekspor.");
    return;
  }
  const gpx = buildGPX(track);
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download =
    "track-" +
    new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") +
    ".gpx";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- Download area (pre-cache tiles) ----
async function downloadArea() {
  const b = map.getBounds();
  const z0 = Math.max(10, map.getZoom() - 1);
  const z1 = Math.min(16, map.getZoom() + 1);
  const range = tileRangeForBounds(
    {
      west: b.getWest(),
      east: b.getEast(),
      north: b.getNorth(),
      south: b.getSouth(),
    },
    z0,
    z1
  );
  let total = 0;
  for (let z = z0; z <= z1; z++) {
    const r = range[z];
    total += (r.xMax - r.xMin + 1) * (r.yMax - r.yMin + 1);
  }
  if (total > MAX_TILES) {
    alert(
      "Area terlalu besar (" +
        total +
        " tile). Perkecil zoom / area dulu (maks " +
        MAX_TILES +
        ")."
    );
    return;
  }
  el("progress").hidden = false;
  let done = 0;
  for (let z = z0; z <= z1; z++) {
    const r = range[z];
    for (let x = r.xMin; x <= r.xMax; x++) {
      for (let y = r.yMin; y <= r.yMax; y++) {
        const url = `https://a.tile.openstreetmap.org/${z}/${x}/${y}.png`;
        try {
          await fetch(url, { mode: "no-cors" }); // SW akan cache-nya
        } catch (e) {}
        done++;
        if (done % 25 === 0) {
          el("progress").textContent = `Download peta: ${done}/${total} tile…`;
          await new Promise((res) => setTimeout(res, 30)); // etika OSM
        }
      }
    }
  }
  el("progress").textContent = `Selesai: ${total} tile tersimpan di cache (bisa dipakai offline).`;
}

function clearTrack() {
  if (!confirm("Hapus jalur yang terekam?")) return;
  stopRecording();
  track = [];
  totalDist = 0;
  trackLine.setLatLngs([]);
  if (marker) {
    map.removeLayer(marker);
    marker = null;
  }
  localStorage.removeItem(STORE_KEY);
  updateReadout();
  el("progress").hidden = true;
}

// ---- Wire up ----
el("btnStart").addEventListener("click", startRecording);
el("btnStop").addEventListener("click", stopRecording);
el("btnCenter").addEventListener("click", centerOnMe);
el("btnFollow").addEventListener("click", toggleFollow);
el("btnLoad").addEventListener("click", () => el("fileInput").click());
el("fileInput").addEventListener("change", (e) => loadTrail(e.target.files[0]));
el("btnExport").addEventListener("click", exportGeoJSON);
el("btnExportGpx").addEventListener("click", exportGPX);
el("btnDownload").addEventListener("click", downloadArea);
el("btnClear").addEventListener("click", clearTrack);

updateOnline();
loadTrack();
