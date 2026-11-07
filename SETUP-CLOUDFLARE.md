# Panduan Deploy ke Cloudflare Pages + GitHub

Isi repo:
- `public/`            : tampilan (index.html, vendor/, robots.txt, _headers) -> situs statis
- `functions/api/[[path]].js` : API (Pages Function, route /api/*)
- `lib/`, `scripts/`   : kode bersama dan skrip sinkron Coda
- `.github/workflows/coda-sync.yml` : sinkron Coda terjadwal lewat GitHub Actions
- `package.json`, `.gitignore`

Cara kerja singkat: Cloudflare Pages menyajikan tampilan dan API, data disimpan di Workers KV. Sinkron Coda dijalankan GitHub Actions (di luar batas CPU Workers gratis) dan menulis hasilnya ke KV.

## 1. Siapkan repo GitHub
1. Buat repo baru (atau pakai repo lama, hapus isi lama: `netlify/`, `netlify.toml`, `index.html` di root).
2. Upload isi zip ke repo. Jika lewat web GitHub (Add file > Upload files), seret folder `public`, `functions`, `lib`, `scripts`, serta file `package.json` dan `.gitignore`.
3. Folder tersembunyi `.github` sering tidak ikut ter-upload lewat drag & drop. Buat lewat web: Add file > Create new file, ketik nama `.github/workflows/coda-sync.yml` (garis miring otomatis membuat folder), tempel isi file `coda-sync.yml` dari zip, lalu Commit.
4. Pastikan branch utama bernama `main`.

## 2. Buat KV namespace (penyimpanan data)
Cloudflare Dashboard > Storage & Databases > KV > Create namespace.
- Buat `productivity-apps` (produksi).
- Opsional, untuk data uji terpisah di preview: `productivity-apps-uji`.
Catat **Namespace ID** produksi. Catat juga **Account ID** (terlihat di halaman Workers & Pages, kolom kanan).

## 3. Buat proyek Pages dari GitHub
Dashboard > Workers & Pages > Create > tab Pages > Connect to Git > pilih repo.
- Production branch: `main`
- Framework preset: None
- Build command: (kosongkan)
- Build output directory: `public`
Klik Save and Deploy. Deploy pertama akan menampilkan error API sampai langkah 4-5 selesai, itu normal.

## 4. Pasang binding KV
Proyek Pages > Settings > Bindings (atau Functions) > Add > **KV namespace**:
- Variable name: `KV`
- Production: pilih `productivity-apps`
- Preview: pilih `productivity-apps-uji` (jika dibuat; bila tidak, pakai yang sama dan JANGAN upload data di alamat preview)

## 5. Variabel dan secret (Settings > Variables and Secrets)
Tambahkan di Production (dan Preview bila perlu), tipe **Secret** untuk yang rahasia:
| Nama | Wajib? | Isi |
|---|---|---|
| `ADMIN_PIN` | wajib | PIN admin awal |
| `VIEW_PIN` | opsional | PIN akses baca awal (bisa juga diatur dari aplikasi) |
| `CODA_API_TOKEN` | opsional | token Coda bila tidak diisi lewat menu Integrasi Coda |
| `GH_REPO` | untuk tombol "Sinkron sekarang" | `pemilik/nama-repo` |
| `GH_TOKEN` | untuk tombol "Sinkron sekarang" | GitHub fine-grained token, repo ini saja, izin **Actions: Read and write** |
| `GH_REF` | opsional | nama branch, default `main` |
| `ENV_LABEL` | opsional | isi `uji` di Preview agar muncul lencana "UJI" |
Setelah menambah binding/variabel: Deployments > pilih deploy terakhir > **Retry deployment**.

## 6. Siapkan GitHub Actions (sinkron Coda)
1. Cloudflare: My Profile > API Tokens > Create Token > Create Custom Token. Izin: **Account > Workers KV Storage > Edit**. Salin token.
2. GitHub repo > Settings > Secrets and variables > Actions > New repository secret:
   - `CF_ACCOUNT_ID` : Account ID
   - `CF_KV_NAMESPACE_ID` : Namespace ID produksi
   - `CF_API_TOKEN` : token langkah 1
   - `CODA_API_TOKEN` : (opsional) token Coda
3. Tab Actions > "Sinkron Coda" > Run workflow untuk mencoba.
Jadwal bawaan: tiap jam. Repo public boleh mengubah baris cron di workflow menjadi `*/15 * * * *`. Repo private sebaiknya tiap jam atau lebih jarang (jatah menit gratis terbatas).

## 7. Uji setelah deploy (sekitar 5 menit)
1. Buka alamat `https://<nama-proyek>.pages.dev` (Ctrl+F5): dashboard tampil tanpa error.
2. Login admin dengan `ADMIN_PIN`. Upload satu file Excel: angka dashboard berubah.
3. Upload file kedua, buka Riwayat versi: muncul versi pertama. Coba Pulihkan.
4. Ganti PIN: tombol Ganti PIN > atur PIN akses dan PIN admin.
5. Isi Integrasi Coda (link, tabel, token), Simpan, lalu Sinkron sekarang. Cek tab Actions di GitHub, lalu status di aplikasi.
6. Buka dari jendela lain/perangkat lain: data sama.
7. Coba Kualitas data, Pivot, Kanban, Gantt, dan kedua tab Dokumen belum ada bobot.

## 8. Alur kerja hemat (branch dev)
- Kerja di branch `dev`. Setiap push ke branch selain `main` otomatis menjadi preview deploy di alamat `<hash-atau-branch>.<proyek>.pages.dev`, dengan lencana "UJI" dan, bila binding Preview diisi namespace uji, data terpisah dari produksi.
- Gabungkan ke `main` (Pull request > Merge) bila sudah beres. Batas gratis: 500 build per bulan (setiap push = 1 build), jauh lebih longgar daripada kuota deploy Netlify.

## 9. Pindah dari Netlify: data apa yang ikut?
Tidak ada yang ikut otomatis. Setelah deploy:
- Data utama: sinkron dari Coda, atau upload ulang file Excel.
- Master PIC dan Pengecualian: diambil lagi dari sheet "Master PIC" di file Excel yang diupload, atau isi ulang di menu Master PIC dan Pengecualian.
- Pengaturan Coda dan PIN dibuat ulang (PIN admin awal dari `ADMIN_PIN`).
Setelah semua beres, domain lama bisa diarahkan ke Cloudflare (Pages > Custom domains).

## 10. Batas dan catatan (paket gratis)
- 100.000 request/hari dan 10 ms CPU per request untuk Functions. Karena itu sinkron Coda dan pengolahan data besar dilakukan GitHub Actions, dan server hanya memeriksa format gzip saat upload.
- KV: 100.000 baca dan 1.000 tulis per hari. KV bersifat eventually consistent: perubahan bisa butuh hingga sekitar 1 menit terlihat di semua lokasi (di lokasi yang sama biasanya langsung).
- Batas data terkompres 20 MB (batas nilai KV 25 MB).
- 5 kali PIN salah mengunci satu IP selama 15 menit (per IP, jadi satu kantor yang berbagi IP ikut terkunci).
- Lupa PIN admin yang diganti di aplikasi: tambah variabel `ADMIN_PIN_RESET` (isi bebas), Retry deployment, login dengan `ADMIN_PIN` dari variabel, ganti PIN di aplikasi, lalu HAPUS `ADMIN_PIN_RESET` dan deploy ulang.
- GitHub menonaktifkan jadwal workflow di repo public yang tidak aktif 60 hari. Aktifkan lagi dari tab Actions.
- Rollback: Pages > Deployments > pilih deploy sebelumnya > Rollback to this deployment.
