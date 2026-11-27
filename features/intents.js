/**
 * Deteksi niat pesan chat wa-assistant (Bahasa Indonesia santai + sedikit Inggris).
 *
 * Modul ESM murni: tanpa dependency, tanpa I/O, tanpa efek samping.
 * Hanya mencocokkan pola di AWAL kalimat (setelah trim, case-insensitive)
 * supaya obrolan biasa tidak salah terdeteksi sebagai perintah.
 *
 * @param {unknown} text
 * @returns {{ intent: string, arg: string } | null}
 */
export function detectIntent(text) {
  if (typeof text !== 'string') return null;

  const s = text.trim();
  if (!s) return null;

  let m;

  // todoDone — paling spesifik, harus dicek sebelum `todo <arg>` biasa.
  m = /^(?:todo\s+(?:done|selesai)\s+|selesaikan\s+todo\s+)(\S[\s\S]*)$/i.exec(s);
  if (m) return { intent: 'todoDone', arg: m[1].trim() };

  // todoList — perintah tanpa argumen.
  if (/^(?:lihat\s+todo|daftar\s+todo|todo)\s*[?!]?$/i.test(s)) {
    return { intent: 'todoList', arg: '' };
  }

  // todo — butuh argumen.
  m = /^(?:todo\s*[：:]\s*|todo\s+|tambah\s+todo\s+)(\S[\s\S]*)$/i.exec(s);
  if (m) return { intent: 'todo', arg: m[1].trim() };

  // notes — daftar catatan; lebih dulu dari `note` agar `catatan` tidak
  // salah terbaca sebagai `catat` + argumen "an".
  if (/^(?:lihat\s+catatan|daftar\s+catatan|catatan)\s*[?!]?$/i.test(s)) {
    return { intent: 'notes', arg: '' };
  }

  // note — butuh argumen.
  m = /^(?:catat\s*[：:]\s*|catat\s+|\.save\s+|ingatkan\s+aku\s*[：:]\s*)(\S[\s\S]*)$/i.exec(s);
  if (m) return { intent: 'note', arg: m[1].trim() };

  // summarize — tanpa argumen.
  if (/^(?:ringkas(?:\s+obrolan)?|summarize)\s*[?!]?$/i.test(s)) {
    return { intent: 'summarize', arg: '' };
  }

  // translate — butuh argumen. Frasa `ke <bahasa>` di akhir dibuang;
  // arg yang dikembalikan adalah teks sumber saja.
  m = /^(?:terjemahkan|terjemahin|translate)\s+(\S[\s\S]*)$/i.exec(s);
  if (m) {
    const arg = m[1]
      .trim()
      .replace(/\s+ke\s+(?:bahasa\s+)?[\p{L}][\p{L}\-]*(?:\s+[\p{L}][\p{L}\-]*)?\s*$/iu, '')
      .trim();
    if (!arg) return null;
    return { intent: 'translate', arg };
  }

  return null;
}
