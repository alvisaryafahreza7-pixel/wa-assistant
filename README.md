# WA Assistant — proxy + command bot (nomor utama)

Satu koneksi Baileys untuk nomor utama. Fungsi utama:

1. **Proxy kirim** — satu pesan, lewat API, dengan alur preview → konfirmasi.
2. **Command bot** — menu, game teks, koin/RPG ringan, moderasi grup (hanya di grup whitelist).
3. **Auto-reply AI** — masih ada tapi default mati (`replyGroups: []`). Untuk grup AI 25 persona, pakai `extras/wa-ai-group-berasa/` dengan nomor cadangan.

Semua fitur muat di paket Free 256 MB (Baileys tanpa browser, tanpa FFmpeg/API key berbayar).

Kenapa dipisah: satu nomor WA hanya boleh satu koneksi Baileys aktif.
`wa-proxy/` dan `wa-ai-group/` sudah diarsipkan ke `extras/_archive/`.
`wa-ai-group-berasa/` memakai nomor cadangan — jangan jalankan dengan nomor yang sama dengan ini.

## Isi folder

| File | Fungsi |
|---|---|
| `index.js` | socket WA + server HTTP |
| `config.js` | whitelist grup, pengaman AI, host/port |
| `skills.js` | 25 persona AI |
| `contacts.json` | nama → JID (16 grup + 5 kontak) |
| `auth/` | sesi WA — **jangan dihapus, jangan di GitHub** |
| `.token` | token API — **jangan kirim ke chat** |
| `.wa-version.json` | cache revisi WA |

> `contacts.json`, `db.json`, `.token`, dan `auth/` sengaja tidak masuk git.
> Upload manual lewat file manager saat deploy.

## Deploy ke bot-hosting.net

1. Buat project baru, runtime **Node.js 24**, entry file `index.js`.
2. Deploy dari repo GitHub **private** atau upload lewat file manager / SFTP. `auth/` sengaja tidak ikut.
   - `node_modules/` tidak perlu di-upload; hosting akan `npm install`.
3. Environment variables di panel:
   - `HOST=0.0.0.0`
   - `PORT=3000`
   - `WA_TOKEN=` → isi dengan isi file `.token` (baca di aplikasi, jangan tempel ke chat)
   - opsional `PAIR_PHONE=628xxx` → pakai **kode pairing**, bukan QR (nomor E.164 tanpa `+`)
   - `REPLY_GROUPS=120363...@g.us` → grup yang boleh pakai command bot (boleh isi `*` saat tes)
   - opsional `DRY_RUN=1` → auto-reply cuma di log, tidak kirim
4. Pairing:
   - Tanpa `PAIR_PHONE`: QR tampil di log → scan di WA → **Perangkat tertaut → Tautkan perangkat**.
   - Dengan `PAIR_PHONE`: kode 8 digit tampil di log → WA → **Perangkat tertaut → Tautkan dengan nomor telepon** → masukkan kode.
   - Kode expire ~3 menit; otomatis minta kode baru kalau belum selesai.
   - Setelah itu tunggu `✅ WA TERHUBUNG`. Auto-restart sudah dari hosting.
5. Paket **Free**: 256 MB RAM, 512 MB storage, 1 deployment, **renew manual tiap 4 hari**.

Catatan: kombinasi ini kira-kira 60–120 MB RAM (Baileys tanpa browser), muat di paket Free.

⚠️ **Sebelum bot hosting jalan, matikan helper lokal** (`warm.js`) — satu nomor hanya boleh satu koneksi Baileys. Helper lokal otomatis mati setelah 15 menit idle.

## Command bot

Aktif hanya di grup yang masuk `replyGroups`:

- Prefix `.`: `.menu` `.help` `.ping` `.info` `.ai <teks>`
- Game: `.kata` `.math` `.suit` (jawab dalam 60 detik)
- Ekonomi: `.koin` `.hunt` `.gacha` (5 koin) — tersimpan di `db.json`
- Grup (owner saja): `.absen` `.antilink on/off` `.welcome on/off`
- `.reset` hapus memori AI grup

### Asisten bahasa alami (titik opsional)

- `catat <teks>` / `catatan` — simpan & lihat catatan pribadi per pengirim
- `todo <teks>` / `todo` / `todo selesai <n>` — to-do list, maks. 30 item
- `ringkas` — rangkum 10 pesan terakhir grup lewat AI
- `terjemahkan <teks> [ke inggris]` — terjemah instan (default: Indonesia)

Catatan disimpan di `db.json` (maks. 20 catatan/orang). Reminder todo dikirim ke grup whitelist tiap 6 jam saat bot hidup. Semua fitur ini text-only, tanpa dependency tambahan, jadi tetap muat di paket Free 256 MB.

Perintah bahasa alami yang berhasil ditangani **tidak** diteruskan ke auto-reply AI, jadi tidak ada balasan ganda.

Owner diatur di `config.js` (`owner`). Perintah dari non-owner untuk `.antilink`/`.welcome` ditolak.

## Aktifkan auto-reply

Edit `config.js`:

```js
replyGroups: ['120363431298378142@g.us'], // Orang asik😜
```

Boleh pakai angka sebelum `@g.us`, atau `['*']` untuk semua grup (tidak disarankan).
Default `[]` = auto-reply mati.

## API

Base URL: `https://<project>.apps.bot-hosting.cloud` (atau `http://127.0.0.1:PORT` di HP).
Semua POST dari **luar container** butuh header `x-wa-token: <token>`.
Request dari **dalam container** (Shell panel, `127.0.0.1`) **tidak perlu token** — ini disengaja supaya tes dari Shell selalu jalan.

Token dibaca dari env `WA_TOKEN` (di-`trim()` otomatis), fallback ke file `.token` kalau ada.

```bash
GET  /health
GET  /inbox?since=0&limit=50&all=1     # pesan masuk; all=1 ikutkan pesan dari diri sendiri
GET  /contacts                          # daftar nama → JID (grup ditandai)
POST /preview  {"to":"Orang asik😜","text":"halo","allowGroup":true}
POST /send     {"to":"Orang asik😜","text":"halo","allowGroup":true,"confirmed":true,"replyTo":"<id pesan>"}
```

- `/preview` tidak menyentuh WA sama sekali.
- `/send` **menolak** kalau `confirmed` bukan `true`.
- `replyTo` opsional → balasan dikutip dari pesan di inbox. Kalau gagal, kirim biasa.
- `/inbox` dipakai "otak" (OpenCode) untuk baca chat lalu membalas lewat `/send`.
- Jeda antar kirim default 5 detik; ubah lewat env `MIN_GAP_MS`.
- Grup wajib `allowGroup: true`; broadcast/status selalu ditolak.

## Alur kirim dari HP

1. Aku panggil `/preview`, aku tunjukkan ke Bang.
2. Bang bilang "ya, kirim".
3. Baru aku panggil `/send` dengan `confirmed: true`.

## Sumber

- https://bot-hosting.net/pricing
- https://baileys.wiki/quickstart
