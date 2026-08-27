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
  offRouteMeters,
  autoWaypoints,
} from "./geo.js";

const STORE_KEY = "trail-track-v1";
const TRAIL_KEY = "trail-plan-v1"; // jalur rencana (dari file) persist
const MIN_MOVE_M = 2; // abaikan titik yg terlalu dekat (kurangi noise)
const MAX_TILES = 4000; // batas download area (etika OSM)

const map = L.map("map", {
  zoomControl: false, // kita taruh manual di bottomright biar tak tabrakan dgn ☰/kompas
  rotate: true,
  rotateControl: false,
  touchRotate: true, // aktifkan rotasi dua jari di layar sentuh
  dragRotate: true,
  shiftKeyRotate: true,
}).setView([-6.92, 109.99], 12); // default: Kendal (jika kosong)
L.control.zoom({ position: "bottomleft" }).addTo(map);

// Dua base layer: OSM (default) + OpenTopoMap (ada hillshade + kontur = 3D-ish)
const baseOSM = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "© OpenStreetMap",
  subdomains: "abc",
});
const baseTopo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  maxZoom: 17,
  attribution: "© OpenStreetMap, © OpenTopoMap",
  subdomains: "abc",
});
let currentBase = localStorage.getItem("baseLayer") === "topo" ? baseTopo : baseOSM;
currentBase.addTo(map);

function toggleBaseLayer() {
  map.removeLayer(currentBase);
  currentBase = currentBase === baseOSM ? baseTopo : baseOSM;
  currentBase.addTo(map);
  // pindah ke bawah semua overlay (track/trail)
  trackLine.bringToFront();
  trailLine.bringToFront();
  meMarker && meMarker.bringToFront();
  localStorage.setItem("baseLayer", currentBase === baseTopo ? "topo" : "osm");
  el("statusText").textContent =
    "Peta: " + (currentBase === baseTopo ? "Topo (relief)" : "OSM");
}

// Fix: di flexbox peta kadang ke-init pas kontainer masih 0 tinggi,
// menyebabkan pan/drag rusak. Recalc ukuran setelah layout stabil.
window.addEventListener("load", () => map.invalidateSize());
setTimeout(() => map.invalidateSize(), 300);
if (window.ResizeObserver) {
  new ResizeObserver(() => map.invalidateSize()).observe(
    document.getElementById("map")
  );
}

let track = []; // { lat, lng, alt, acc, t }
let totalDist = 0;
let watchId = null;
let followMode = true; // peta otomatis ngikutin posisi saat rekam
let recStart = 0; // timestamp mulai rekam (ms)
let recAccum = 0; // detik terakumulasi (pause-aware)
let recTimer = null; // interval update durasi
let heading = 0; // arah hadap HP (derajat, 0 = utara)
let trackLine = L.polyline([], { color: "#22c55e", weight: 4 }).addTo(map);
let trailLine = L.polyline([], {
  color: "#3b82f6",
  weight: 3,
  dashArray: "6,6",
}).addTo(map); // jalur rencana (dari file)
let marker = null;
let meMarker = null; // dot biru "you are here"
let meCircle = null; // lingkaran akurasi
let lastMe = null; // simpan posisi GPS terakhir buat re-posisi setelah rotasi
const el = (id) => document.getElementById(id);

// Tampilkan penanda lokasi saya (dot biru) + lingkaran akurasi.
function showMyLocation(lat, lng, acc) {
  lastMe = { lat, lng, acc };
  if (!meMarker) {
    meMarker = L.circleMarker([lat, lng], {
      radius: 8,
      color: "#3b82f6",
      weight: 2,
      fillColor: "#3b82f6",
      fillOpacity: 0.9,
    }).addTo(map);
  } else {
    meMarker.setLatLng([lat, lng]);
  }
  if (meCircle) map.removeLayer(meCircle);
  if (acc && acc > 0) {
    meCircle = L.circle([lat, lng], {
      radius: acc,
      color: "#3b82f6",
      weight: 1,
      fillColor: "#3b82f6",
      fillOpacity: 0.15,
    }).addTo(map);
  }
}

// Hindari dot biru "geser sendiri" saat peta di-rotate.
// Pakai pointer/touch events langsung (bukan event Leaflet yg kadang tdk fire):
// saat >=2 jari menyentuh = gesture rotate -> sembunyikan dot, tampilkan lagi saat lepas.
function hideMe() {
  if (meMarker) meMarker.setOpacity(0);
  if (meCircle) meCircle.setStyle({ opacity: 0, fillOpacity: 0 });
}
function showMe() {
  if (lastMe && meMarker) {
    meMarker.setLatLng([lastMe.lat, lastMe.lng]).setOpacity(1);
    if (meCircle) {
      meCircle.setLatLng([lastMe.lat, lastMe.lng]);
      meCircle.setStyle({ opacity: 1, fillOpacity: 0.15 });
    }
  }
}
const mapEl = document.getElementById("map");
if (mapEl) {
  mapEl.addEventListener("touchstart", (e) => {
    if (e.touches && e.touches.length >= 2) hideMe();
  });
  mapEl.addEventListener("touchend", (e) => {
    if (e.touches && e.touches.length < 2) showMe();
  });
  mapEl.addEventListener("touchcancel", (e) => {
    if (e.touches && e.touches.length < 2) showMe();
  });
}

// ---- Service Worker ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .then((reg) => {
      // Kalau ada SW versi baru ter-install, reload otomatis sekali
      // biar user langsung dapet kode terbaru (hindari cache lama).
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            location.reload();
          }
        });
      });
    })
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
function saveTrail() {
  try {
    localStorage.setItem(
      TRAIL_KEY,
      JSON.stringify({
        track: trailLine.getLatLngs(),
        waypoints: waypointData,
      })
    );
  } catch (e) {}
}
function loadTrailSaved() {
  try {
    const raw = localStorage.getItem(TRAIL_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    const pts = Array.isArray(data) ? data : data.track; // kompatibel lama
    if (!pts || !pts.length) return false;
    trailLine.setLatLngs(pts);
    const savedWps = Array.isArray(data) ? [] : data.waypoints || [];
    // jika GPX asli tak punya wpt, regenerate auto-waypoint dari track
    const wps = savedWps.length ? savedWps : autoWaypoints(pts.map((p) => ({ lat: p[0], lng: p[1] })));
    drawWaypoints(wps);
    return true;
  } catch (e) {}
  return false;
}
// Lompat ke area trail rencana (jika ada).
function focusTrail() {
  if (trailLine.getLatLngs().length) {
    map.fitBounds(trailLine.getBounds());
    el("statusText").textContent = "Menuju area trail rencana (biru)";
  } else {
    alert("Belum ada trail yang dimuat.");
  }
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
  const durSec = recAccum + (recStart ? (Date.now() - recStart) / 1000 : 0);
  el("dur").textContent = formatDur(durSec);
  // pace hanya bermakna kalau sudah jalan > 50m
  if (totalDist > 50 && durSec > 1) {
    const paceMinKm = durSec / 60 / (totalDist / 1000);
    el("pace").textContent = paceMinKm.toFixed(1) + " mnt/km";
    const kmh = (totalDist / 1000) / (durSec / 3600);
    el("speed").textContent = kmh.toFixed(1) + " km/j";
  } else {
    el("pace").textContent = "–";
    el("speed").textContent = "–";
  }
  const last = track[track.length - 1];
  if (last) {
    el("acc").textContent = last.acc ? "±" + Math.round(last.acc) + " m" : "–";
    el("ll").textContent = last.lat.toFixed(5) + ", " + last.lng.toFixed(5);
  }
}

function formatDur(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
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
  showMyLocation(lat, lng, acc);
  checkOffRoute(lat, lng);
  saveTrack();
  updateReadout();
}
// Peringatan kalau menyimpang dari trail rencana (biru).
const OFFROUTE_M = 50; // ambang simpangan (meter)
let offRouteActive = false;
let lastVibrate = 0;
function checkOffRoute(lat, lng) {
  const line = trailLine.getLatLngs();
  if (line.length < 2) {
    hideOffRoute();
    return;
  }
  const d = offRouteMeters({ lat, lng }, line);
  if (d > OFFROUTE_M) {
    if (!offRouteActive) {
      offRouteActive = true;
      el("offroute").hidden = false;
      el("offroute").textContent =
        "⚠️ KELUAR JALUR " + Math.round(d) + " m — kembali ke trail biru!";
      // getar HP (jika didukung & diizinkan)
      if (navigator.vibrate) {
        const now = Date.now();
        if (now - lastVibrate > 1500) {
          navigator.vibrate([200, 100, 200]);
          lastVibrate = now;
        }
      }
    } else {
      el("offroute").textContent =
        "⚠️ KELUAR JALUR " + Math.round(d) + " m — kembali ke trail biru!";
    }
  } else {
    hideOffRoute();
  }
}
function hideOffRoute() {
  if (offRouteActive) {
    offRouteActive = false;
    el("offroute").hidden = true;
  }
}
function onPositionError(err) {
  el("statusText").textContent = "GPS error: " + err.message;
}

function startRecording() {
  if (!navigator.geolocation) {
    alert("Browser tidak mendukung Geolocation.");
    return;
  }
  if (!recStart) recAccum = 0;
  recStart = Date.now();
  if (recTimer) clearInterval(recTimer);
  recTimer = setInterval(updateReadout, 1000);
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 10000,
  });
  el("btnStart").disabled = true;
  el("btnStop").disabled = false;
  el("panel").classList.add("open"); // auto-buka biar durasi kelihatan
  el("statusText").textContent = "Merekam…";
}
function stopRecording() {
  if (recTimer) {
    clearInterval(recTimer);
    recTimer = null;
  }
  if (recStart) {
    recAccum += (Date.now() - recStart) / 1000;
    recStart = 0;
  }
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  el("btnStart").disabled = false;
  el("btnStop").disabled = true;
  saveTrack();
  updateReadout();
  el("statusText").textContent = "Rekam dihentikan";
}

function centerOnMe() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (p) => {
      map.setView(
        [p.coords.latitude, p.coords.longitude],
        Math.max(map.getZoom(), 15)
      );
      showMyLocation(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
    },
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
      const { track: pts, waypoints } = parseTrack(reader.result, file.name);
      if (!pts.length) {
        alert("Tidak ada titik track di file ini (GeoJSON/GPX).");
        return;
      }
      trailLine.setLatLngs(pts.map((p) => [p.lat, p.lng]));
      // waypoint: dari file (wpt/trkpt name) + auto (start/puncak/finish)
      const wps = waypoints.concat(autoWaypoints(pts));
      drawWaypoints(wps);
      map.fitBounds(trailLine.getBounds());
      saveTrail();
      el("statusText").textContent =
        "Trail dimuat (" + (/\.gpx$/i.test(file.name) ? "GPX" : "GeoJSON") +
        "): " + pts.length + " titik" +
        (waypoints.length ? ", " + waypoints.length + " pos" : "") +
        " (biru = rencana)";
    } catch (e) {
      alert("Gagal parse file: " + e.message);
    }
  };
  reader.readAsText(file);
}

// --- Waypoint / POI (pos, puncak) dari GPX <wpt> ---
let waypointData = []; // [{lat,lng,name}]
const waypointLayer = L.layerGroup().addTo(map);
function drawWaypoints(list) {
  waypointData = list || [];
  waypointLayer.clearLayers();
  for (const w of waypointData) {
    const isPeak = /puncak|peak|summit|gunung/i.test(w.name);
    const color = isPeak ? "#f97316" : "#22c55e"; // puncak oranye, pos hijau
    const m = L.circleMarker([w.lat, w.lng], {
      radius: 7,
      color: "#0b0f14",
      weight: 2,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(waypointLayer);
    m.bindPopup("<b>" + w.name + "</b>");
    m.bindTooltip(w.name, { direction: "top", offset: [0, -6] });
  }
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
  recStart = 0;
  recAccum = 0;
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  trackLine.setLatLngs([]);
  if (marker) {
    map.removeLayer(marker);
    marker = null;
  }
  localStorage.removeItem(STORE_KEY);
  localStorage.removeItem(TRAIL_KEY);
  trailLine.setLatLngs([]);
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
el("btnResetRot").addEventListener("click", () => {
  if (map.getBearing) map.setBearing(0); // leaflet-rotate API
});
el("btnTrail").addEventListener("click", focusTrail);
el("btnMenu").addEventListener("click", () => {
  el("panel").classList.toggle("open");
});
el("btnMap").addEventListener("click", toggleBaseLayer);

// ---- Kompas: arah hadap HP (deviceorientation) ----
function onOrientation(e) {
  // iOS 13+ pakai e.webkitCompassHeading; lainnya e.alpha (perlu dikurangi bearing peta)
  const h = e.webkitCompassHeading != null ? e.webkitCompassHeading : (360 - (e.alpha || 0));
  heading = h;
  const arrow = el("compassArrow");
  if (arrow) arrow.style.transform = `rotate(${-h}deg)`;
  el("compassDeg").textContent = Math.round(h) + "°";
}
function enableCompass() {
  if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) {
    // iOS 13+ minta izin dulu
    DeviceOrientationEvent.requestPermission()
      .then((state) => {
        if (state === "granted") window.addEventListener("deviceorientation", onOrientation);
      })
      .catch(() => {});
  } else {
    window.addEventListener("deviceorientation", onOrientation);
  }
}
enableCompass();

updateOnline();
loadTrack();
// Saat startup: prioritas trail rencana -> track tersimpan -> default Bandung.
if (loadTrailSaved()) {
  map.fitBounds(trailLine.getBounds());
  el("statusText").textContent = "Trail rencana dimuat dari penyimpanan (biru)";
} else if (track.length) {
  map.fitBounds(trackLine.getBounds());
}
