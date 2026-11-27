// Helper sementara: panasin socket WA selama WARM_IDLE_MS, lalu exit sendiri.
// Kirim perintah lewat file .warm-queue.json, hasil di .warm-result.json.
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.join(dir, 'auth')
const CONTACTS_FILE = path.join(dir, 'contacts.json')
const VERSION_FILE = path.join(dir, '.wa-version.json')
const LAST_SENT_FILE = path.join(dir, '.last-sent.json')
const QUEUE_FILE = path.join(dir, '.warm-queue.json')
const RESULT_FILE = path.join(dir, '.warm-result.json')
const READY_FILE = path.join(dir, '.warm-ready.json')
const IDLE_MS = Number(process.env.WARM_IDLE_MS || 15 * 60 * 1000)
const GAP_MS = 90 * 1000

const logger = pino({ level: 'silent' })
let sock = null
let ready = false
let reconnecting = false
let lastActivity = Date.now()
let lastId = ''
let starting = false
let lastSentAt = 0
let sending = false
try {
  lastSentAt = Number(JSON.parse(fs.readFileSync(LAST_SENT_FILE, 'utf8')).at) || 0
} catch {}

function loadContacts() {
  try {
    return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function resolveJid(to) {
  const t = String(to || '').trim()
  if (!t) return null
  if (t.includes('@')) return t
  if (/^\d{8,15}$/.test(t)) return `${t}@s.whatsapp.net`
  const hit = Object.entries(loadContacts()).find(
    ([n, j]) => !n.startsWith('_') && j && n.toLowerCase() === t.toLowerCase(),
  )
  return hit ? hit[1] : null
}
function gapMs() {
  if (!Number.isFinite(lastSentAt) || !lastSentAt) return 0
  return Math.max(0, GAP_MS - (Date.now() - lastSentAt))
}
async function latestWaVersion() {
  try {
    const c = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'))
    if (Array.isArray(c.version) && c.at && Date.now() - c.at < 86400000) return c.version
  } catch {}
  try {
    const res = await fetch('https://web.whatsapp.com/sw.js', {
      signal: AbortSignal.timeout(8000),
      headers: {
        'sec-fetch-site': 'none',
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    })
    const m = (await res.text()).match(/client_revision"?\s*:\s*(\d+)/)
    if (m?.[1]) {
      const v = [2, 3000, Number(m[1])]
      fs.writeFileSync(VERSION_FILE, JSON.stringify({ at: Date.now(), version: v }))
      return v
    }
  } catch {}
  return undefined
}

function writeResult(obj) {
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ ...obj, at: Date.now() }))
}

async function connect() {
  try {
    const live = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'))
    if (live?.pid && live.pid !== process.pid) {
      try {
        process.kill(live.pid, 0)
        console.error('❌ helper warm.js lain masih aktif (pid', live.pid, ') — hentikan dulu.')
        process.exit(1)
      } catch (e) {
        if (e.code !== 'ESRCH') {
          console.error('❌ tidak bisa cek helper warm.js lain — hentikan dulu.')
          process.exit(1)
        }
      }
    }
  } catch {}
  if (starting) return
  starting = true
  try {
    const version = await latestWaVersion()
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    sock = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      ...(version ? { version } : {}),
      markOnlineOnConnect: false,
      logger,
    })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (u) => {
      if (u.qr) {
        console.log('\n📱 Helper belum tertaut — scan QR ini di WA (Perangkat tertaut):')
        qrcode.generate(u.qr, { small: true })
      }
      if (u.connection === 'open') {
        ready = true
        reconnecting = false
        fs.writeFileSync(READY_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }))
        console.log('✅ WA SIAP (helper aktif)')
      }
      if (u.connection === 'close') {
        ready = false
        const code = u.lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          try { fs.unlinkSync(READY_FILE) } catch {}
          writeResult({ error: 'Sesi logout — pairing ulang' })
          process.exit(1)
        }
        if (!reconnecting) {
          reconnecting = true
          console.log('Putus', code, '- reconnect 4 detik')
          setTimeout(() => {
            sock = null
            starting = false
            connect()
          }, 4000)
        }
      }
    })
  } finally {
    starting = false
  }
}

async function handle(cmd) {
  if (cmd.confirmed !== true) {
    writeResult({ id: cmd.id, error: 'Belum dikonfirmasi (confirmed: true)' })
    return
  }
  const jid = resolveJid(cmd.to)
  if (!jid) {
    writeResult({ id: cmd.id, error: `Kontak "${cmd.to}" tidak ditemukan` })
    return
  }
  if (jid.includes('broadcast') || jid === 'status@broadcast') {
    writeResult({ id: cmd.id, error: 'Broadcast ditolak' })
    return
  }
  if (jid.endsWith('@g.us') && cmd.allowGroup !== true) {
    writeResult({ id: cmd.id, error: 'Grup butuh allowGroup: true' })
    return
  }
  const text = String(cmd.text || '').trim()
  if (!text || text.length > 1000) {
    writeResult({ id: cmd.id, error: 'Pesan kosong / >1000 karakter' })
    return
  }
  const sisa = gapMs()
  if (sisa > 0) {
    writeResult({ id: cmd.id, error: `Anti-spam: ${Math.ceil(sisa / 1000)} detik lagi` })
    return
  }
  if (sending) {
    writeResult({ id: cmd.id, error: 'Ada pengiriman lain masih berjalan' })
    return
  }
  sending = true
  lastSentAt = Date.now()
  fs.writeFileSync(LAST_SENT_FILE, JSON.stringify({ at: lastSentAt, to: jid }))
  try {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {})
    await new Promise((r) => setTimeout(r, 600 + Math.floor(Math.random() * 700)))
    await sock.sendMessage(jid, { text })
    await sock.sendPresenceUpdate('paused', jid).catch(() => {})
    writeResult({ id: cmd.id, sent: true, to: jid, text })
    console.log('✅ TERKIRIM', jid, text)
  } catch (err) {
    writeResult({ id: cmd.id, error: err.message })
  } finally {
    sending = false
  }
}

const timer = setInterval(async () => {
  if (ready) {
    try {
      const cmd = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
      if (cmd?.id && cmd.id !== lastId) {
        lastId = cmd.id
        lastActivity = Date.now()
        await handle(cmd)
      }
    } catch {}
  }
  const idle = Date.now() - lastActivity
  if (idle >= IDLE_MS) {
    try { fs.unlinkSync(READY_FILE) } catch {}
    writeResult({ stopped: true, reason: 'idle timeout' })
    console.log('⏹️  Idle', Math.round(IDLE_MS / 60000), 'menit — helper mati sendiri.')
    clearInterval(timer)
    setTimeout(() => process.exit(0), 200)
  }
}, 1000)

connect()
