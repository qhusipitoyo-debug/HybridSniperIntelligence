# SniperNews Intelligence ⚡
### Hybrid Macro News Intelligence & Precision Technical Multi-Scanner

Terminal hibrida terpadu yang menggabungkan:
1. **News Intelligence Core**: Kalender ekonomi global (Forex Factory + TradingView), deteksi sentimen makro (Fear & Greed Index, Risk-On/Risk-Off bias), hitung mundur rilis berita dunia (*Next Catalyst*), serta perlindungan otomatis terhadap lonjakan volatilitas ekstrim (*News Window Protection*).
2. **Sniper Technical Execution Core**: Scanner 14 instrumen (Forex Majors, JPY Crosses, US Indices, Gold XAU, Crypto BTC/ETH) berbasis WebSocket streaming real-time (Binance & Deriv), SL dinamis berbasis Swing struktural & ATR, TP bertingkat (TP1 50% parsial + TP2), dan manajemen risiko lot otomatis.

---

## Fitur Utama

- **Radar Makro & Hitung Mundur Rilis**: Memberi peringatan sebelum berita berdampak tinggi dirilis (*CPI, NFP, Suku Bunga Fed, PMI*) dan memblokir order teknikal 15 menit menjelang rilis agar terhindar dari *stop-hunt*.
- **Matrix 14 Pasangan Pasar (Live Real-Time)**: Memantau harga *mid/bid/ask*, skor momentum, trend EMA, dan status filter pasar secara paralel setiap detik.
- **Sistem Gembok Order (🔒 ENTRY Valid)**: Menampilkan titik entry yang terkunci ketika konfirmasi teknikal mencapai 100% dan kondisi pasar lolos filter efisiensi tren (*Efficiency Ratio*).
- **Simulasi & Replay Backtest Lokal**: Alat verifikasi matematis offline (`tools/pair_stats.js`) berbasis ribuan baris data tick pasar riil.
- **Dukungan Bridge Broker MT5**: Terintegrasi dengan bridge lokal Python (`scripts/mt5_quotes.py`) untuk membaca kuotasi harga broker riil FBS.

---

## Cara Menjalankan Secara Lokal

1. **Jalankan Terminal Web**:
   Buka file `index.html` di browser Anda (atau gunakan local web server seperti `npx serve .` atau `python3 -m http.server 8080`).
2. **Perbarui Kalender Ekonomi & Sentimen**:
   ```bash
   node tools/fetch_context.js
   ```
   Atau untuk kalender lengkap TradingView:
   ```bash
   node scripts/fetch-calendar.mjs
   ```
3. **Uji Replay Backtest**:
   ```bash
   node tools/pair_stats.js --modes balanced,momentum
   ```
4. **Uji Signal Lock Engine (M15)**:
   ```bash
   node tools/lock_test.js
   ```

---

## Signal Lock Engine (`lock.js`)

Gerbang akhir sebelum order: dipanggil **hanya saat candle M15 close** (dibangun otomatis dari tick Binance/Deriv di `app.js`). Alur: filter kualitas (spike, RVOL, spread, makro/news/FNG/DXY) → konfirmasi 2 candle close berturut-turut searah → **level dibekukan** (entry/SL/TP1/TP2 tidak berubah). Kelola posisi: TP1 → close 50% + SL digeser ke entry (BE), sisa ditarik ke TP2; SL konservatif dicek lebih dulu; plan kedaluwarsa setelah TTL 4 jam (status `TIME`). Hasil `CLOSED` masuk ke jurnal eksekusi & tabel "Riwayat Order Terkunci".

---

## Lisensi & Catatan
Sistem ini dirancang untuk analisis pasar dan manajemen risiko mandiri. Pastikan selalu memperhatikan manajemen modal (*Money Management*) sebelum melakukan eksekusi di akun riil.
