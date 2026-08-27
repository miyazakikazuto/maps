# Trail GPS — Pelacak Jalur Pendakian Offline

Aplikasi web (PWA) untuk merekam jalur pendakian menggunakan GPS perangkat
dan menampilkan peta OpenStreetMap yang **tetap bisa dipakai offline**.

## Cara kerja offline
- **GPS**: chip GPS di HP jalan tanpa sinyal seluler (cuma butuh langit terbuka).
- **Peta**: Service Worker (`sw.js`) mencegat tile OSM dan menyimpannya ke
  Cache API. Tile yang sudah pernah dilihat (atau di-download via tombol
  *Download Area*) bisa dibuka saat Airplane Mode.
- **Jalur**: titik `(lat, lng, alt, acc, waktu)` disimpan ke `localStorage`
  dan bisa diekspor sebagai GeoJSON.

## Struktur
| File | Fungsi |
|---|---|
| `index.html` | UI + peta |
| `app.js` | logika GPS, rekam, export, download area |
| `geo.js` | helper murni: tile math, GeoJSON, haversine (teruji di `test/`) |
| `sw.js` | Service Worker cache app shell + tile OSM |
| `styles.css` | tampilan |
| `manifest.webmanifest` | metadata PWA |
| `test/geo.test.mjs` | unit test logika `geo.js` |

## Jalankan secara lokal
Geolocation & Service Worker butuh *secure context* (HTTPS atau `localhost`):
```bash
cd maps
python3 -m http.server 8080
# buka http://localhost:8080 di HP (atau browser desktop)
```
Lalu:
1. Klik **📍 Lokasi Saya** untuk center ke posisimu.
2. Perbesar area gunung tujuan, lalu **⬇ Download Area** (cache peta).
3. Nyalakan Airplane Mode → peta & GPS tetap jalan.
4. **▶ Mulai Rekam** saat naik, **■ Stop** di puncak.
5. **⤓ Export GeoJSON** untuk simpan jalur.

## Tes logika
```bash
node test/geo.test.mjs
```

## Deploy ke GitHub Pages
Push ke branch `main`, lalu aktifkan Pages (Source: branch `main`, folder `/root`).
Aplikasi langsung bisa diakses di `https://<user>.github.io/maps/`.

## Catatan etika OSM
Jangan download ribuan tile berulang-ulang. Batas `MAX_TILES = 4000` per
download area sudah disiapkan. Untuk produksi, pertimbangkan provider tile
berlisensi (MapTiler, Thunderforest) sesuai kebutuhan.
