// Utilitas AI on-demand untuk wa-assistant.
// Mandiri: tidak mengimpor file lain, hanya memakai fetch bawaan Node 20+.
// Endpoint dan model mengikuti kode AI yang sudah ada di index.js.

const ENDPOINT = 'https://text.pollinations.ai/openai'
const TIMEOUT_MS = 15000
const MAX_TEXT = 800
const MAX_HISTORY = 10
const MAX_CONTENT = 500

// Satu-satunya tempat yang menyentuh jaringan. Selalu mengembalikan string | null.
async function callAI(messages, model) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'openai',
        messages,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null

    const data = await res.json()
    const raw = data?.choices?.[0]?.message?.content
    if (typeof raw !== 'string') return null

    const cleaned = raw.trim()
    return cleaned || null
  } catch {
    // Timeout, jaringan mati, JSON rusak, dll. — jangan pernah lempar ke pemanggil.
    return null
  }
}

// Bersihkan sisa markdown/table yang masih muncul walau sudah diminta tanpa markdown.
function cleanSummary(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^\|?[\s:\-|]+\|?$/.test(line)) // baris pemisah tabel
    .map((line) =>
      line
        .replace(/^\s*[-*+•]\s+/, '') // bullet
        .replace(/^\s*\d+[.)]\s+/, '') // numbered list
        .replace(/\*\*|__|`/g, '') // bold / italic / code
        .trim()
    )
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * Rangkum maksimal 10 entri terakhir grup menjadi 3–5 poin penting.
 * @param {Array<{role: string, content: string}>} history
 * @param {string} model
 * @returns {Promise<string | null>}
 */
export async function summarize(history, model = 'openai') {
  try {
    const entries = Array.isArray(history) ? history.slice(-MAX_HISTORY) : []
    const messages = [
      {
        role: 'system',
        content:
          'Kamu adalah asisten WhatsApp. Rangkum percakapan grup berikut menjadi 3–5 poin penting. ' +
          'Gunakan Bahasa Indonesia yang santai dan singkat. ' +
          'Jangan pakai markdown, tabel, heading, atau format khusus — hanya teks biasa.',
      },
    ]

    for (const item of entries) {
      if (!item || typeof item.content !== 'string') continue
      const role = ['user', 'assistant', 'system'].includes(item.role) ? item.role : 'user'
      messages.push({ role, content: item.content.slice(0, MAX_CONTENT) })
    }

    if (messages.length === 1) return null

    const raw = await callAI(messages, model)
    if (!raw) return null

    const result = cleanSummary(raw)
    return result || null
  } catch {
    return null
  }
}

/**
 * Terjemahkan teks ke bahasa target. Kembalikan HANYA hasil terjemahannya.
 * @param {string} text
 * @param {string} target
 * @param {string} model
 * @returns {Promise<string | null>}
 */
export async function translate(text, target = 'Indonesia', model = 'openai') {
  try {
    if (typeof text !== 'string' || !text.trim()) return null
    const source = text.slice(0, MAX_TEXT)
    const destination = typeof target === 'string' && target.trim() ? target.trim().slice(0, 50) : 'Indonesia'

    const messages = [
      {
        role: 'system',
        content:
          `Kamu adalah penerjemah. Terjemahkan teks pengguna ke Bahasa ${destination}. ` +
          'Balas HANYA dengan hasil terjemahannya saja — tanpa penjelasan, catatan, tanda kutip, atau teks tambahan lain.',
      },
      { role: 'user', content: source },
    ]

    const raw = await callAI(messages, model)
    if (!raw) return null

    // Buang tanda kutip pembungkus jika model tetap menyertakannya.
    const result = raw.replace(/^["'“”]+|["'“”]+$/g, '').trim()
    return result || null
  } catch {
    return null
  }
}
