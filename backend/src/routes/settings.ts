/**
 * 应用设置路由 — 全局配置的读写入口（当前：AI 内容语言）
 */
import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DATA_ROOT } from '../utils/paths.js'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getContentLanguage, setContentLanguage, getToursSeen, setToursSeen, CONTENT_LANGUAGES, type ContentLanguage } from '../services/app-settings.js'
import { success, badRequest } from '../utils/response.js'
import { getActiveConfig, getConfigById } from '../services/ai.js'
import { videoPromptPolicy } from '../agents/video-prompt-policy.js'

const app = new Hono()
app.get('/generation-mode', (c) => {
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'generation_mode')).get()
  return success(c, { mode: row?.value === 'mcp' ? 'mcp' : 'api' })
})
app.put('/generation-mode', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!['mcp', 'api'].includes(body?.mode)) return badRequest(c, 'mode 必须为 mcp 或 api')
  db.insert(schema.appSettings).values({ key: 'generation_mode', value: body.mode, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: schema.appSettings.key, set: { value: body.mode, updatedAt: new Date().toISOString() } }).run()
  return success(c, { mode: body.mode })
})
app.get('/local-muse-key', async (c) => {
  const file = process.env.HUOBAO_MUSE_ENV
  if (!file) return c.json({ message: '未配置本机 Muse2API' }, 404)
  try {
    const text = await readFile(file, 'utf8')
    const line = text.split(/\r?\n/).find(line => line.startsWith('MUSE2API_KEY='))
    const key = line?.slice('MUSE2API_KEY='.length).trim().replace(/^[\"']|[\"']$/g, '') || ''
    c.header('Cache-Control', 'no-store')
    return success(c, { key })
  } catch { return c.json({ message: '无法读取本机 Muse2API 配置' }, 500) }
})
const promptProfiles = ['auto', 'muse', 'muse_skill', 'other'] as const
app.get('/video-prompt-profile', async (c) => {
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'video_prompt_profile')).get()
  const savedMode = promptProfiles.includes(row?.value as any) ? row!.value : 'auto'
  const mode = savedMode === 'muse_skill' ? 'muse' : savedMode
  const episodeId = c.req.query('episode_id')
  let config = null
  if (episodeId) {
    const id = Number(episodeId)
    if (!Number.isInteger(id) || id < 1) return badRequest(c, '无效的 episode_id')
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).get()
    if (!episode) return c.json({ message: '剧集不存在' }, 404)
    if (episode.videoConfigId) config = await getConfigById(episode.videoConfigId)
  }
  if (!config) config = await getActiveConfig('video')
  const isMuse = config?.provider === 'muse2api' || /^muse-video(?:$|[-_])/i.test(config?.model || '')
  const effective = mode === 'auto' ? (isMuse ? 'muse' : 'other') : mode
  return success(c, { mode, effective, video_provider: config?.provider || null, video_model: config?.model || null, segmentation: effective === 'muse' ? 'continuous' : null, policy: videoPromptPolicy(effective as 'muse' | 'muse_skill' | 'other') })
})
app.put('/video-prompt-profile', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!promptProfiles.includes(body?.mode)) return badRequest(c, '无效的视频提示词模式')
  db.insert(schema.appSettings).values({ key: 'video_prompt_profile', value: body.mode, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: schema.appSettings.key, set: { value: body.mode, updatedAt: new Date().toISOString() } }).run()
  return success(c, { mode: body.mode })
})
const museConnectorBase = (process.env.MUSE_CONNECTOR_INTERNAL_URL || 'http://muse-connector:5680').replace(/\/$/, '')
const museStatePath = process.env.MUSE_STATE_READ_PATH || '/app/muse-state/state.json'
app.get('/agent-activity', async (c) => {
  const files = [path.join(path.dirname(museStatePath), 'activity.jsonl'), path.join(DATA_ROOT, 'project-activity.jsonl')]
  const entries = (await Promise.all(files.map(file => readFile(file, 'utf8').catch(() => '')))).flatMap(text => text.trim().split('\n').slice(-100).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })).sort((a,b) => String(b.time).localeCompare(String(a.time))).slice(0,100)
  c.header('Cache-Control', 'no-store')
  return success(c, { entries })
})

async function savedMuseToken(): Promise<string> {
  try {
    const state = JSON.parse(await readFile(museStatePath, 'utf8')) as { muse_bridge_token?: unknown }
    return typeof state.muse_bridge_token === 'string' ? state.muse_bridge_token : ''
  } catch {
    return ''
  }
}

// The OTP gateway protects this settings API. Read the connector's persisted token
// from its mounted volume so the page shows the value actually used after rebuilds.
app.get('/muse-connector', async (c) => {
  try {
    const response = await fetch(`${museConnectorBase}/health`, { signal: AbortSignal.timeout(10000) })
    if (!response.ok) return c.json({ error: 'connector_unavailable' }, 502)
    const health = await response.json() as { status?: string; token_configured?: boolean }
    const currentToken = await savedMuseToken()
    c.header('Cache-Control', 'no-store')
    return c.json({ status: health.status, token_configured: !!health.token_configured,
      current_token: currentToken || null,
      mcp_url: process.env.MUSE_MCP_PUBLIC_URL || 'https://hb-mcp.aynas.de5.net/mcp' })
  } catch {
    return c.json({ error: 'connector_unavailable' }, 502)
  }
})

// Use the token in the persistent volume. A manually supplied current token is
// retained for initial bootstrap when no state file exists yet.
app.put('/muse-connector/token', async (c) => {
  const currentToken = await savedMuseToken() || (c.req.header('authorization') || '').replace(/^Bearer /i, '')
  if (!currentToken) return c.json({ error: 'current_token_required' }, 401)
  const body = await c.req.json().catch(() => null)
  const newToken = body?.new_token
  if (typeof newToken !== 'string' || !/^[A-Za-z0-9._~+/-]{24,256}$/.test(newToken)) {
    return c.json({ error: 'new_token_must_be_24_to_256_bearer_characters' }, 400)
  }
  try {
    const response = await fetch(`${museConnectorBase}/admin/token`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${currentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ new_token: newToken }),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return c.json({ error: response.status === 401 ? 'current_token_invalid' : 'connector_rejected' }, response.status === 401 ? 401 : 502)
    c.header('Cache-Control', 'no-store')
    return c.json({ success: true, token_configured: true })
  } catch {
    return c.json({ error: 'connector_unavailable' }, 502)
  }
})

// GET /content-language — 当前 AI 内容语言
app.get('/content-language', async (c) => {
  return success(c, { language: await getContentLanguage() })
})

// PUT /content-language — 设置 AI 内容语言（body: { language: 'zh'|'en'|'ja'|'ko' }）
app.put('/content-language', async (c) => {
  const body = await c.req.json().catch(() => null)
  const language = body?.language
  if (!(CONTENT_LANGUAGES as readonly string[]).includes(language)) {
    return badRequest(c, `language 必须是 ${CONTENT_LANGUAGES.join(' / ')} 之一`)
  }
  const saved = await setContentLanguage(language as ContentLanguage)
  return success(c, { language: saved })
})

// GET /tours-seen — 已看过的引导漫游 id 列表
app.get('/tours-seen', async (c) => {
  return success(c, { seen: await getToursSeen() })
})

// PUT /tours-seen — 写入已看过的引导漫游 id 列表（body: { seen: string[] }）
app.put('/tours-seen', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!Array.isArray(body?.seen) || !body.seen.every((v: unknown) => typeof v === 'string')) {
    return badRequest(c, 'seen 必须是字符串数组')
  }
  return success(c, { seen: await setToursSeen(body.seen) })
})

export default app
