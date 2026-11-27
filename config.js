export const CONFIG = {
  // === AUTO-REPLY: hanya grup yang masuk daftar ini ===
  // Isi dengan JID lengkap (@g.us) atau hanya angka sebelum @g.us.
  // Contoh: ['120363431298378142@g.us'] atau ['120363431298378142']
  // Kosong = auto-reply MATI (proxy kirim tetap jalan).
  // ['*'] = semua grup (tidak disarankan).
  replyGroups: [],

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
