// WA Assistant — SATU proses, SATU koneksi Baileys:
//  - proxy: kirim satu pesan lewat HTTP (preview -> confirmed)
//  - auto-reply AI: HANYA grup yang masuk whitelist
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { AI_SKILLS } from './skills.js'
import { CONFIG } from './config.js'
import { handleNoteCommand, dailyReminder } from './features/notes.js'
import { summarize, translate } from './features/ai-tools.js'
import { detectIntent } from './features/intents.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.join(dir, 'auth')
const CONTACTS_FILE = path.join(dir, 'contacts.json')
const VERSION_FILE = path.join(dir, '.wa-version.json')
const LAST_SENT_FILE = path.join(dir, '.last-sent.json')
const READY_FILE = path.join(dir, '.warm-ready.json')
const TOKEN_FILE = path.join(dir, '.token')
const DB_FILE = path.join(dir, 'db.json')
const startedAt = Date.now()

let db = {}
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
} catch {}
function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
}
function groupCfg(jid) {
  if (!db.groups) db.groups = {}
  if (!db.groups[jid]) db.groups[jid] = { antilink: false, welcome: false }
  return db.groups[jid]
}
function userData(jid) {
  if (!db.users) db.users = {}
  if (!db.users[jid]) db.users[jid] = { coins: 0, lastHunt: 0 }
  return db.users[jid]
}

if (!CONFIG.token && fs.existsSync(TOKEN_FILE)) {
  CONFIG.token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
}

const logger = pino({ level: 'silent' })
let sock = null
let reminderTimer = null
let readyAt = 0
let starting = false
let sendInFlight = false
let lastSentAt = 0
try {
  lastSentAt = Number(JSON.parse(fs.readFileSync(LAST_SENT_FILE, 'utf8')).at) || 0
} catch {}

// ---------------------------------------------------------------- proxy
function loadContacts() {
  try {
    return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function resolveJid(to, contacts) {
  const target = String(to || '').trim()
  if (!target) return null
  if (/@(broadcast|newsletter)$/.test(target)) return null
  if (target.includes('@')) {
    if (Object.values(contacts).includes(target)) return target
    if (/^\d{8,15}@s\.whatsapp\.net$/.test(target)) return target
    return null
  }
  if (/^\d{8,15}$/.test(target)) return `${target}@s.whatsapp.net`
  const entry = Object.entries(contacts).find(
    ([name, jid]) =>
      !name.startsWith('_') && jid && name.toLowerCase() === target.toLowerCase(),
  )
  return entry ? entry[1] : null
}

function resolveTarget(to, allowGroup) {
  const jid = resolveJid(to, loadContacts())
  if (!jid) throw new Error(`Kontak "${to}" tidak ditemukan di contacts.json`)
  if (jid.includes('broadcast') || jid === 'status@broadcast') {
    throw new Error('Broadcast/status ditolak')
  }
  if (jid.endsWith('@g.us') && !allowGroup) {
    throw new Error('Tujuan adalah grup — sertakan allowGroup: true')
  }
  return jid
}

function gapRemainingMs() {
  if (!Number.isFinite(lastSentAt) || !lastSentAt) return 0
  return Math.max(0, CONFIG.minGapMs - (Date.now() - lastSentAt))
}

async function latestWaVersion() {
  try {
    const c = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'))
    if (Array.isArray(c.version) && c.at && Date.now() - c.at < 86400000) return c.version
  } catch {}
  try {
    const res = await fetch('https://web.whatsapp.com/sw.js', {
      headers: {
        'sec-fetch-site': 'none',
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    })
    const m = (await res.text()).match(/client_revision"?\s*:\s*(\d+)/)
    if (m?.[1]) {
      const version = [2, 3000, Number(m[1])]
      fs.writeFileSync(VERSION_FILE, JSON.stringify({ at: Date.now(), version }))
      return version
    }
  } catch {}
  return undefined
}

async function sendOne(jid, text) {
  if (!sock?.user) throw new Error('WA belum siap (masih connecting)')
  lastSentAt = Date.now()
  fs.writeFileSync(LAST_SENT_FILE, JSON.stringify({ at: lastSentAt, to: jid }))
  await sock.sendPresenceUpdate('composing', jid).catch(() => {})
  await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 1200)))
  await sock.sendMessage(jid, { text })
  await sock.sendPresenceUpdate('paused', jid).catch(() => {})
}

// ---------------------------------------------------------------- auto-reply
const NAMES = Object.keys(AI_SKILLS)
const EMOJI = ['😂', '🔥', '👀', '💯', '🤝', '😅', '✨', '👍']
const history = new Map()
const batchLog = new Map()
const lastReaction = new Map()
const seenIds = new Map()
let lastAiAt = 0

const PERSONA_LIST = NAMES.map(
  (n) => `${n} (${AI_SKILLS[n].co}) - ${AI_SKILLS[n].skill}: ${AI_SKILLS[n].prompt}`,
).join('\n')

const SYSTEM = `Kamu adalah mesin obrolan grup WhatsApp yang isinya asisten-asisten AI dengan karakter berbeda.
Tugas kamu: bikin obrolan grup yang terasa hidup, bukan jawaban robot kaku.

ATURAN:
- Pilih TEPAT ${CONFIG.personasPerReply} nama dari daftar kandidat yang diberikan.
- Setiap persona jawab dengan karakternya sendiri. Boleh setuju, boleh debat, boleh ngegodain.
- Pakai Bahasa Indonesia WA santai: singkat, 1-2 kalimat, boleh emoji secukupnya.
- Jangan semua jawab sama persis. Jangan pakai markdown, jangan pakai tabel.
- JANGAN mengaku sedang dibuat oleh model lain. Jangan menjelaskan bahwa ini roleplay.
- Balas HANYA JSON array seperti: [{"name":"Grok","text":"..."},{"name":"Claude","text":"..."}]

DAFTAR PERSONA:
${PERSONA_LIST}`

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function shuffle(list) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function isAllowedGroup(jid) {
  const list = CONFIG.replyGroups || []
  if (!list.length) return false
  if (list.includes('*')) return String(jid).endsWith('@g.us')
  const base = String(jid).split('@')[0]
  return list.some((g) => String(g).split('@')[0] === base)
}
function getHistory(jid) {
  if (!history.has(jid)) history.set(jid, [])
  return history.get(jid)
}
function remember(jid, role, content) {
  const h = getHistory(jid)
  h.push({ role, content: content.slice(0, 800) })
  if (h.length > 10) h.splice(0, h.length - 10)
}
function isFresh(msg) {
  const ts = Number(msg.messageTimestamp)
  if (!Number.isFinite(ts)) return true
  const age = Date.now() - ts * 1000
  return age >= -5000 && age <= CONFIG.maxAgeMs
}
function isDuplicate(msg) {
  const id = msg.key?.id
  if (!id) return false
  const now = Date.now()
  for (const [key, at] of seenIds) if (now - at > 5 * 60 * 1000) seenIds.delete(key)
  if (seenIds.has(id)) return true
  seenIds.set(id, now)
  if (seenIds.size > 500) seenIds.delete(seenIds.keys().next().value)
  return false
}
function canBatch(jid) {
  const now = Date.now()
  const arr = (batchLog.get(jid) || []).filter((t) => now - t < 60 * 60 * 1000)
  batchLog.set(jid, arr)
  return arr.length < CONFIG.maxBatchesPerHour
}
function markBatch(jid) {
  const arr = batchLog.get(jid) || []
  arr.push(Date.now())
  batchLog.set(jid, arr)
}
function parseReplies(raw) {
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a !== -1 && b > a) s = s.slice(a, b + 1)
  try {
    const arr = JSON.parse(s)
    if (!Array.isArray(arr)) throw new Error('bukan array')
    const clean = arr
      .filter((x) => x && typeof x.name === 'string' && typeof x.text === 'string')
      .map((x) => ({
        name: NAMES.includes(x.name) ? x.name : 'ChatGPT',
        text: x.text.trim().slice(0, 400),
      }))
      .slice(0, CONFIG.personasPerReply)
    if (!clean.length) throw new Error('kosong')
    return clean
  } catch {
    return [{ name: 'ChatGPT', text: String(raw).trim().slice(0, 300) || 'Hmm, coba lagi ya.' }]
  }
}
async function askAI(jid, userText) {
  const candidates = shuffle(NAMES).slice(0, CONFIG.personasPerReply + 3)
  const messages = [
    {
      role: 'system',
      content: SYSTEM + `\n\nKANDIDAT (pilih ${CONFIG.personasPerReply}): ${candidates.join(', ')}`,
    },
    ...getHistory(jid),
    { role: 'user', content: userText },
  ]
  const res = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai', messages }),
  })
  if (!res.ok) {
    console.warn('AI HTTP', res.status)
    return null
  }
  const data = await res.json()
  const raw = data.choices?.[0]?.message?.content
  if (!raw) return null
  const replies = parseReplies(raw)
  remember(jid, 'user', userText)
  remember(jid, 'assistant', replies.map((r) => `[${r.name}] ${r.text}`).join('\n'))
  return replies
}
async function safeSend(jid, content) {
  if (CONFIG.dryRun) {
    console.log('🧪 PREVIEW →', jid, JSON.stringify(content).slice(0, 200))
    return undefined
  }
  return sock.sendMessage(jid, content)
}
async function handleSmartCommand(jid, sender, text) {
  try {
    const intent = detectIntent(text)
    if (!intent) return false

    if (
      intent.intent === 'note' ||
      intent.intent === 'notes' ||
      intent.intent === 'todo' ||
      intent.intent === 'todoList' ||
      intent.intent === 'todoDone'
    ) {
      const result = handleNoteCommand(text, sender, db)
      if (!result) return false
      if (result.changed) saveDb()
      await safeSend(jid, { text: result.reply })
      return true
    }

    if (intent.intent === 'summarize') {
      const out = await summarize(getHistory(jid).slice(-10))
      await safeSend(jid, { text: out || 'Belum ada obrolan cukup untuk diringkas.' })
      return true
    }

    if (intent.intent === 'translate') {
      const m = /ke\s+([a-z]+)\s*$/i.exec(text)
      const target = m ? m[1] : 'Indonesia'
      const out = await translate(intent.arg, target)
      await safeSend(jid, { text: out || 'Terjemahan gagal, coba lagi nanti.' })
      return true
    }

    return false
  } catch {
    console.warn('Smart command gagal')
    return false
  }
}
async function presence(jid, state) {
  if (CONFIG.dryRun) return
  try {
    await sock.sendPresenceUpdate(state, jid)
  } catch {}
}
async function sendReplies(jid, replies) {
  for (const r of replies) {
    try {
      await presence(jid, 'composing')
      await wait(CONFIG.typingDelay + rand(0, 600))
      const co = AI_SKILLS[r.name]?.co || 'AI'
      await safeSend(jid, { text: `*${r.name} · ${co}*\n${r.text}` })
      await presence(jid, 'paused')
    } catch (err) {
      console.warn('Gagal kirim AI:', err.message)
    }
  }
}
async function reactMaybe(msg, jid) {
  if (Math.random() > CONFIG.reactionChance) return
  const now = Date.now()
  if (now - (lastReaction.get(jid) || 0) < CONFIG.reactionCooldown) return
  lastReaction.set(jid, now)
  try {
    await safeSend(jid, {
      react: { text: EMOJI[rand(0, EMOJI.length - 1)], key: msg.key },
    })
  } catch {}
}
async function replyTo(jid, text, force = false) {
  if (!force && Math.random() > CONFIG.replyChance) return
  if (!canBatch(jid)) return
  const now = Date.now()
  if (now - lastAiAt < CONFIG.globalCooldown + rand(0, CONFIG.jitterMs)) return
  lastAiAt = now
  markBatch(jid)
  const replies = await askAI(jid, text)
  if (replies) await sendReplies(jid, replies)
}

// ---------------------------------------------------------------- command bot
const gameState = new Map()
const WORDS = ['kopi', 'kucing', 'sepeda', 'buku', 'hujan', 'pantai', 'rumah', 'kampus', 'meja', 'botol']
const ITEMS = ['koin tua', 'peda kayu', 'topi ajaib', 'buku harian', 'kunci karat', 'kucing kertas']
const MENU = `🤖 *WA Assistant*\n\n` +
  `⚙️ Umum\n.menu .ping .info .ai <teks>\n\n` +
  `🎮 Game\n.kata .math .suit\n\n` +
  `💰 Ekonomi\n.koin .hunt .gacha\n\n` +
  `🛡️ Grup (owner)\n.absen .antilink on/off .welcome on/off\n\n` +
  `.reset hapus memori AI`

function scramble(w) {
  const a = [...w]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.join('')
}
function ownerOf(sender) {
  return String(sender || '').split('@')[0] === CONFIG.owner.split('@')[0]
}

async function checkGame(jid, text) {
  const g = gameState.get(jid)
  if (!g) return false
  if (Date.now() - g.at > 60_000) {
    gameState.delete(jid)
    return false
  }
  const jawab = text.trim().toLowerCase()
  if (g.type === 'kata' || g.type === 'math') {
    if (jawab !== String(g.answer).toLowerCase()) return false
    gameState.delete(jid)
    const u = userData(jid)
    u.coins += 2
    saveDb()
    await safeSend(jid, { text: `✅ Betul! +2 koin (total ${u.coins})` })
    return true
  }
  if (g.type === 'suit') {
    const pilihan = ['batu', 'kertas', 'gunting']
    if (!pilihan.includes(jawab)) return false
    gameState.delete(jid)
    const bot = pilihan[rand(0, 2)]
    const menang =
      (jawab === 'batu' && bot === 'gunting') ||
      (jawab === 'kertas' && bot === 'batu') ||
      (jawab === 'gunting' && bot === 'kertas')
    const u = userData(jid)
    if (menang) {
      u.coins += 1
      saveDb()
    }
    await safeSend(jid, {
      text: `Kamu: ${jawab} · Bot: ${bot} → ${menang ? `Menang! +1 koin (${u.coins})` : 'Seri/kalah'}`,
    })
    return true
  }
  return false
}

async function handleCommand(jid, sender, text, msg) {
  const raw = String(text || '').trim()
  if (!raw.startsWith(CONFIG.prefix)) return false
  const parts = raw.slice(CONFIG.prefix.length).trim().split(/\s+/)
  const cmd = (parts.shift() || '').toLowerCase()
  const arg = parts.join(' ').trim()
  const isOwner = ownerOf(sender)
  const gc = groupCfg(jid)

  if (cmd === 'menu' || cmd === 'help') {
    await safeSend(jid, { text: MENU })
    return true
  }
  if (cmd === 'reset') {
    history.delete(jid)
    await safeSend(jid, { text: '🧠 Memori AI grup di-reset.' })
    return true
  }
  if (cmd === 'ping') {
    await safeSend(jid, {
      text: `🏓 Pong · uptime ${Math.round((Date.now() - startedAt) / 1000)} detik · RAM ringan`,
    })
    return true
  }
  if (cmd === 'info') {
    await safeSend(jid, {
      text: 'WA Assistant — proxy + AI dalam satu koneksi. Baileys, tanpa API key berbayar.',
    })
    return true
  }
  if (cmd === 'ai') {
    if (!arg) {
      await safeSend(jid, { text: 'Contoh: `.ai kasih ide judul singkat`' })
      return true
    }
    await replyTo(jid, arg, true)
    return true
  }
  if (cmd === 'kata') {
    const w = WORDS[rand(0, WORDS.length - 1)]
    gameState.set(jid, { type: 'kata', answer: w, at: Date.now() })
    await safeSend(jid, { text: `🔤 Tebak kata: *${scramble(w)}* (jawab dalam 60 detik)` })
    return true
  }
  if (cmd === 'math') {
    const a = rand(2, 20)
    const b = rand(2, 20)
    gameState.set(jid, { type: 'math', answer: a + b, at: Date.now() })
    await safeSend(jid, { text: `🧮 ${a} + ${b} = ? (jawab dalam 60 detik)` })
    return true
  }
  if (cmd === 'suit') {
    gameState.set(jid, { type: 'suit', at: Date.now() })
    await safeSend(jid, { text: '✊ Batu / ✋ Kertas / ✌️ Gunting? (balas dalam 60 detik)' })
    return true
  }
  if (cmd === 'koin') {
    const u = userData(jid)
    await safeSend(jid, { text: `💰 Koin kamu: ${u.coins}` })
    return true
  }
  if (cmd === 'hunt') {
    const u = userData(jid)
    if (Date.now() - u.lastHunt < 60_000) {
      await safeSend(jid, { text: '⏳ Hunt lagi 1 menit ya.' })
      return true
    }
    u.lastHunt = Date.now()
    const dapet = rand(1, 8)
    u.coins += dapet
    saveDb()
    await safeSend(jid, { text: `🏹 Nemu ${dapet} koin! Total ${u.coins}` })
    return true
  }
  if (cmd === 'gacha') {
    const u = userData(jid)
    if (u.coins < 5) {
      await safeSend(jid, { text: '❌ Butuh 5 koin. Coba `.hunt`.' })
      return true
    }
    u.coins -= 5
    saveDb()
    await safeSend(jid, { text: `🎁 Dapat: *${ITEMS[rand(0, ITEMS.length - 1)]}* 🎉` })
    return true
  }
  if (cmd === 'absen') {
    if (!isOwner) {
      await safeSend(jid, { text: '❌ Perintah owner saja.' })
      return true
    }
    try {
      const meta = await sock.groupMetadata(jid)
      const names = (meta.participants || []).slice(0, 15).map((p) => `• ${String(p.id).split('@')[0]}`)
      await safeSend(jid, {
        text: `📋 ${meta.subject || 'Grup'} — ${(meta.participants || []).length} anggota\n${names.join('\n')}`,
      })
    } catch (e) {
      await safeSend(jid, { text: 'Gagal baca anggota grup.' })
    }
    return true
  }
  if (cmd === 'antilink' || cmd === 'welcome') {
    if (!isOwner) {
      await safeSend(jid, { text: '❌ Perintah owner saja.' })
      return true
    }
    const on = /^(on|1|true|ya)$/i.test(arg)
    const off = /^(off|0|false|nggak)$/i.test(arg)
    if (!on && !off) {
      await safeSend(jid, { text: `Contoh: \`.${cmd} on\` / \`.${cmd} off\`` })
      return true
    }
    gc[cmd] = on
    saveDb()
    await safeSend(jid, { text: `✅ .${cmd} ${on ? 'AKTIF' : 'MATI'}` })
    return true
  }
  return false
}

// ---------------------------------------------------------------- WA
async function startBot() {
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
    sock.ev.on('group-participants.update', async (event) => {
      if (event.action !== 'add' || !isAllowedGroup(event.id)) return
      if (!groupCfg(event.id).welcome) return
      const self = String(sock.user?.id || '').split('@')[0]
      const newcomers = (event.participants || []).filter(
        (p) => String(p).split('@')[0] !== self,
      )
      if (!newcomers.length) return
      const tags = newcomers.map((p) => `@${String(p).split('@')[0]}`).join(' ')
      await safeSend(event.id, {
        text: `Halo ${tags}! Selamat datang 🎉`,
        mentions: newcomers,
      })
    })

    let reconnecting = false
    sock.ev.on('connection.update', (u) => {
      if (u.qr) console.log('\n📱 Sesi belum tertaut — lakukan pairing ulang.\n')
      if (u.connection === 'open') {
        reconnecting = false
        readyAt = Date.now() + 8000
        console.log('✅ WA TERHUBUNG')
        console.log(
          'Auto-reply:',
          CONFIG.replyGroups.length ? `AKTIF di ${CONFIG.replyGroups.length} grup` : 'MATI (whitelist kosong)',
        )
        console.log('Dry-run:', CONFIG.dryRun ? 'AKTIF' : 'MATI')
        if (reminderTimer) {
          clearInterval(reminderTimer)
          reminderTimer = null
        }
        reminderTimer = setInterval(async () => {
          try {
            if (!sock?.user || !CONFIG.replyGroups.length) return
            const reminder = dailyReminder(db)
            if (!reminder) return
            for (const jid of CONFIG.replyGroups) {
              await safeSend(jid, { text: reminder })
            }
          } catch {
            console.warn('Reminder gagal')
          }
        }, 6 * 60 * 60 * 1000)
        reminderTimer.unref?.()
      }
      if (u.connection === 'close') {
        if (reminderTimer) {
          clearInterval(reminderTimer)
          reminderTimer = null
        }
        const code = u.lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          console.error('❌ Sesi logout — hapus auth/ lalu pairing ulang.')
          return
        }
        if (!reconnecting) {
          reconnecting = true
          console.log('Putus (code', code, '), reconnect 5 detik...')
          setTimeout(() => {
            sock = null
            starting = false
            startBot()
          }, 5000)
        }
      }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
      if (!CONFIG.replyGroups.length || Date.now() < readyAt) return
      const msg = messages?.[0]
      if (!msg?.message || msg.key.fromMe) return
      if (isDuplicate(msg)) return
      if (!isFresh(msg)) return
      const jid = msg.key.remoteJid
      if (!jid || jid.includes('@broadcast') || jid === 'status@broadcast') return
      if (!jid.endsWith('@g.us') || !isAllowedGroup(jid)) return

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ''
      const sender = msg.key.participant || msg.key.remoteJid
      const gc = groupCfg(jid)
      if (
        gc.antilink &&
        /https?:\/\//i.test(text) &&
        !ownerOf(sender)
      ) {
        try {
          await sock.sendMessage(jid, { delete: msg.key })
        } catch {}
        await safeSend(jid, { text: '⚠️ Link tidak diizinkan di grup ini.' })
        return
      }

      if (await handleCommand(jid, sender, text, msg)) return
      if (await handleSmartCommand(jid, sender, text)) return
      if (await checkGame(jid, text)) return
      await reactMaybe(msg, jid)
      if (!text.trim()) return
      console.log('Chat grup:', text.slice(0, 100))
      await replyTo(jid, text.trim().slice(0, 800))
    })
  } finally {
    starting = false
  }
}

// ---------------------------------------------------------------- HTTP API
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      wa: sock?.user ? 'open' : 'connecting',
      autoReplyGroups: CONFIG.replyGroups.length,
      dryRun: CONFIG.dryRun,
    })
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'POST saja' })
  if (!CONFIG.token || req.headers['x-wa-token'] !== CONFIG.token) {
    return json(res, 401, { error: 'Token salah' })
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 10000) return json(res, 413, { error: 'Body terlalu besar' })
    chunks.push(chunk)
  }
  let a
  try {
    a = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return json(res, 400, { error: 'JSON invalid' })
  }

  const text = String(a.text || '')
  if (!text.trim()) return json(res, 400, { error: 'Isi pesan kosong' })
  if (text.length > 1000) return json(res, 400, { error: 'Pesan max 1000 karakter' })

  let jid
  try {
    jid = resolveTarget(a.to, a.allowGroup === true)
  } catch (err) {
    return json(res, 400, { error: err.message })
  }

  if (url.pathname === '/preview') {
    return json(res, 200, {
      mode: 'PREVIEW — tidak dikirim',
      to: jid,
      text,
      grup: jid.endsWith('@g.us'),
    })
  }

  if (url.pathname === '/send') {
    if (a.confirmed !== true) {
      return json(res, 403, { error: 'Belum dikonfirmasi. Perlu confirmed: true' })
    }
    const sisa = gapRemainingMs()
    if (sisa > 0) {
      return json(res, 429, { error: `Anti-spam: tunggu ${Math.ceil(sisa / 1000)} detik` })
    }
    try {
      await sendOne(jid, text)
      return json(res, 200, { sent: true, to: jid })
    } catch (err) {
      return json(res, 500, { error: err.message })
    }
  }

  return json(res, 404, { error: 'Path tidak dikenal' })
})

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`API siap: http://${CONFIG.host}:${CONFIG.port}`)
  if (!CONFIG.token) console.warn('⚠️  WA_TOKEN kosong — endpoint /send ditolak.')
})

function helperStillAlive() {
  try {
    const live = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'))
    if (!live?.pid || live.pid === process.pid) return false
    try {
      process.kill(live.pid, 0)
      return true
    } catch (e) {
      return e.code !== 'ESRCH'
    }
  } catch {
    return false
  }
}

if (process.env.NO_WA !== '1') {
  if (helperStillAlive()) {
    console.error('❌ helper warm.js masih aktif — matikan dulu sebelum menjalankan bot hosting.')
    process.exit(1)
  }
  startBot()
}
