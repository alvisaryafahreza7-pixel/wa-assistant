export const CONFIG = {
  // === AUTO-REPLY: hanya grup yang masuk daftar ini ===
  // Bisa diisi lewat env REPLY_GROUPS (dipisah koma) tanpa edit file.
  // JID lengkap (@g.us) atau hanya angka sebelum @g.us.
  // Contoh: REPLY_GROUPS=120363...@g.us  atau  REPLY_GROUPS=120363...,120364...
  // Kosong = auto-reply MATI (proxy kirim tetap jalan).
  // * = semua grup (boleh untuk tes, tidak disarankan permanen).
  replyGroups: String(process.env.REPLY_GROUPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  personasPerReply: 3,
  typingDelay: 1400,
  dryRun: process.env.DRY_RUN === '1',

  // Pengaman WA /Pollinations (jangan dikecilin sembarangan)
  globalCooldown: 50000,
  jitterMs: 7000,
  replyChance: 0.65,
  maxAgeMs: 30000,
  maxBatchesPerHour: 8,
  reactionChance: 0.18,
  reactionCooldown: 45000,

  // === PROXY KIRIM ===
  minGapMs: 90 * 1000, // jeda antar pengiriman lewat proxy

  // === COMMAND BOT ===
  prefix: '.',
  owner: '6288271501421@s.whatsapp.net', // nomor utama Bang

  // === SERVER ===
  // Di bot-hosting.net: HOST=0.0.0.0, PORT=3000, WA_TOKEN=<isi dari file .token>
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  token: process.env.WA_TOKEN || '',

  // Pairing code (opsional): nomor WA E.164 tanpa '+' — kalau diisi, pakai kode, bukan QR.
  pairPhone: String(process.env.PAIR_PHONE || '').replace(/\D/g, ''),
}
