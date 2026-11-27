// Catatan & to-do untuk WA Assistant.
// db DITERIMA dari pemanggil (index.js urus baca/tulis db.json) — modul ini tak menyentuh file.

const MAX_NOTES = 20
const MAX_TODOS = 30
const MAX_LEN = 300

function whoOf(sender) {
  return String(sender ?? '').trim() || 'anon'
}

function clip(value) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN - 1)}…` : s
}

// Dipakai HANYA di jalur yang memang mengubah db.
function mutableList(db, key, who) {
  if (!db || typeof db !== 'object') return null
  if (!db[key] || typeof db[key] !== 'object' || Array.isArray(db[key])) db[key] = {}
  if (!Array.isArray(db[key][who])) db[key][who] = []
  return db[key][who]
}

// Versi baca-saja: tidak pernah menambah/mengubah db.
function readList(db, key, who) {
  if (!db || typeof db !== 'object') return []
  const root = db[key]
  if (!root || typeof root !== 'object' || Array.isArray(root)) return []
  return Array.isArray(root[who]) ? root[who] : []
}

function indexOfArg(arg) {
  const m = String(arg ?? '').trim().match(/^(\d+)\.?$/)
  return m ? Number(m[1]) : 0
}

function pushCapped(list, item, cap) {
  list.push(item)
  if (list.length > cap) list.splice(0, list.length - cap)
}

function result(reply, changed) {
  return { reply, changed }
}

export function handleNoteCommand(text, sender, db) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const body = raw.startsWith('.') ? raw.slice(1).trim() : raw
  if (!body) return null
  const lower = body.toLowerCase()
  const who = whoOf(sender)
  let m

  // --- hapus catatan
  m = body.match(/^hapus\s+catatan(?:\s+(.*))?$/i)
  if (m) {
    const n = indexOfArg(m[1])
    const notes = readList(db, 'notes', who)
    if (!n || n > notes.length) {
      return result('❌ Nomor catatan nggak valid. Cek `.catatan` dulu ya.', false)
    }
    const removed = notes[n - 1]
    mutableList(db, 'notes', who).splice(n - 1, 1)
    return result(`🗑️ Catatan ${n} dihapus: ${clip(removed && removed.text)}`, true)
  }

  // --- lihat catatan (boleh tanpa daftar, jangan mengubah db)
  if (/^(?:lihat\s+)?catatan(?:\s+.*)?$/i.test(body)) {
    const notes = readList(db, 'notes', who)
    if (!notes.length) return result('📝 Belum ada catatan. Tambah pakai `.catat <isi>`.', false)
    const lines = notes.map((item, i) => `${i + 1}. ${clip(item && item.text)}`)
    return result(`📝 Catatan kamu (${notes.length}):\n${lines.join('\n')}`, false)
  }

  // --- tambah catatan
  m = body.match(/^catat(?:\s+([\s\S]*))?$/i)
  if (m) {
    const isi = clip(m[1])
    if (!isi) return result('✍️ Cara pakai: `.catat <isi>` — misal `.catat beli susu`.', false)
    const notes = mutableList(db, 'notes', who)
    pushCapped(notes, { text: isi, at: Date.now() }, MAX_NOTES)
    return result(`📝 Catatan disimpan: ${isi}`, true)
  }

  // --- tandai todo selesai (cek sebelum "todo <isi>")
  m = body.match(/^(?:lihat\s+)?todo\s+(?:done|selesai)(?:\s+(.*))?$/i)
  if (m) {
    const n = indexOfArg(m[1])
    const todos = readList(db, 'todos', who)
    if (!n || n > todos.length) {
      return result('❌ Nomor todo nggak valid. Cek `.todo` dulu ya.', false)
    }
    const item = todos[n - 1]
    if (item && item.done) return result(`✅ Todo ${n} udah selesai dari tadi.`, false)
    mutableList(db, 'todos', who)[n - 1].done = true
    return result(`🎉 Selesai: ${clip(item && item.text)}`, true)
  }

  // --- lihat todo (baca-saja)
  if (/^(?:lihat\s+)?todo$/i.test(body)) {
    const todos = readList(db, 'todos', who)
    if (!todos.length) return result('✅ Belum ada todo. Tambah pakai `.todo <isi>`.', false)
    const lines = todos.map((item, i) => `${i + 1}. ${item && item.done ? '[x]' : '[ ]'} ${clip(item && item.text)}`)
    const sisa = todos.filter((item) => item && !item.done).length
    return result(`✅ Todo kamu (${sisa} belum selesai):\n${lines.join('\n')}`, false)
  }

  // --- tambah todo
  m = body.match(/^todo\s+([\s\S]+)$/i)
  if (m) {
    const isi = clip(m[1])
    if (!isi) return result('✍️ Cara pakai: `.todo <isi>` — misal `.todo bayar listrik`.', false)
    const todos = mutableList(db, 'todos', who)
    pushCapped(todos, { text: isi, at: Date.now(), done: false }, MAX_TODOS)
    return result(`✅ Todo ditambah: ${isi}`, true)
  }

  // Bukan perintah catatan/todo — biarkan handler lain yang ambil.
  return null
}

export function dailyReminder(db) {
  if (!db || typeof db !== 'object' || !db.todos || typeof db.todos !== 'object') return null
  const pending = []
  for (const key of Object.keys(db.todos)) {
    const list = db.todos[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (item && typeof item === 'object' && !item.done) {
        pending.push(clip(item.text))
      }
    }
  }
  if (!pending.length || !pending.some(Boolean)) return null
  const contoh = pending.find(Boolean)
  return `⏰ Ada ${pending.length} todo belum selesai.\nContoh: ${contoh}`
}
