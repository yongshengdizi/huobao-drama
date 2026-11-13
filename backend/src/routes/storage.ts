/**
 * 存储位置信息路由 — 设置页「存储位置」卡片数据源
 *
 * GET / → 当前模式(desktop/server)、目录路径、磁盘占用（分桶）与剩余空间。
 * 占用计算较重（全目录 walk）：内存缓存 60s TTL + stale-while-revalidate，
 * 过期时立即返回旧值并后台单飞重算（computing 防并发）；首次无值才同步等待。
 */
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile, readFile, rename, realpath, lstat } from 'node:fs/promises'
import path from 'node:path'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { db, dbPath, schema } from '../db/index.js'
import { dirUsage, volumeFreeBytes } from '../utils/dirsize.js'
import { success } from '../utils/response.js'

const app = new Hono()

const USAGE_TTL_MS = 60_000

interface UsageCache {
  usage: Awaited<ReturnType<typeof dirUsage>> | null
  computedAt: string | null
  computing: boolean
}
const cache: UsageCache = { usage: null, computedAt: null, computing: false }

async function computeUsage() {
  if (cache.computing) return
  cache.computing = true
  try {
    const usage = await dirUsage(DATA_ROOT, dbPath)
    cache.usage = usage
    cache.computedAt = new Date().toISOString()
  } finally {
    cache.computing = false
  }
}

// 启动 10s 后后台预热一次，用户进设置页时大概率已命中缓存
const warmup = setTimeout(() => { void computeUsage() }, 10_000)
warmup.unref?.()

// 导出业务内容及本机素材，不包含 ai_service_configs、令牌或整库文件。
app.get('/export', async (c) => {
  let workingDir: string | undefined
  try {
    const projectId = c.req.query('project_id') ? Number(c.req.query('project_id')) : null
    if (projectId !== null && (!Number.isSafeInteger(projectId) || projectId < 1)) return c.json({ error: 'invalid_project_id' }, 400)
    workingDir = await mkdtemp(path.join(DATA_ROOT, '.huobao-export-'))
    const scriptsDir = path.join(workingDir, 'scripts')
    await mkdir(scriptsDir)
    const snapshot = {
      format: 'huobao-scripts-assets-v1',
      exported_at: new Date().toISOString(),
      dramas: await db.select().from(schema.dramas),
      episodes: await db.select().from(schema.episodes),
      storyboards: await db.select().from(schema.storyboards),
      characters: await db.select().from(schema.characters),
      scenes: await db.select().from(schema.scenes),
      props: await db.select().from(schema.props),
      assets: await db.select().from(schema.assets),
      episode_characters: await db.select().from(schema.episodeCharacters),
      episode_scenes: await db.select().from(schema.episodeScenes),
      episode_props: await db.select().from(schema.episodeProps),
      storyboard_characters: await db.select().from(schema.storyboardCharacters),
      storyboard_props: await db.select().from(schema.storyboardProps),
    }
    if (projectId !== null) {
      snapshot.dramas = snapshot.dramas.filter(x => x.id === projectId && !x.deletedAt)
      if (!snapshot.dramas.length) { await rm(workingDir, { recursive: true, force: true }); return c.json({ error: 'project_not_found' }, 404) }
      snapshot.episodes = snapshot.episodes.filter(x => x.dramaId === projectId)
      const episodes = new Set(snapshot.episodes.map(x => x.id))
      snapshot.storyboards = snapshot.storyboards.filter(x => episodes.has(x.episodeId))
      const boards = new Set(snapshot.storyboards.map(x => x.id))
      snapshot.characters = snapshot.characters.filter(x => x.dramaId === projectId)
      snapshot.scenes = snapshot.scenes.filter(x => x.dramaId === projectId)
      snapshot.props = snapshot.props.filter(x => x.dramaId === projectId)
      snapshot.assets = snapshot.assets.filter(x => x.dramaId === projectId)
      snapshot.episode_characters = snapshot.episode_characters.filter(x => episodes.has(x.episodeId))
      snapshot.episode_scenes = snapshot.episode_scenes.filter(x => episodes.has(x.episodeId))
      snapshot.episode_props = snapshot.episode_props.filter(x => episodes.has(x.episodeId))
      snapshot.storyboard_characters = snapshot.storyboard_characters.filter(x => boards.has(x.storyboardId))
      snapshot.storyboard_props = snapshot.storyboard_props.filter(x => boards.has(x.storyboardId))
    }
    await writeFile(path.join(workingDir, 'project-data.json'), JSON.stringify(snapshot, null, 2), 'utf8')
    for (const episode of snapshot.episodes) {
      await writeFile(path.join(scriptsDir, `episode_${episode.id}.txt`), episode.scriptContent || episode.content || '', 'utf8')
    }
    await writeFile(path.join(workingDir, 'README.txt'),
      '火宝剧本与素材手动导出。project-data.json 包含剧集、分集、分镜、人物、场景、道具与关联记录；scripts/ 为分集文本。static/ 和 legacy-arcreel/project/ 为本机素材与旧项目源文件。外部 URL 只保留引用，不会下载远程文件。此归档不包含模型 API Key、Muse 令牌或完整数据库。\n', 'utf8')

    const archivePaths = ['-C', workingDir, 'README.txt', 'project-data.json', 'scripts']
    const roots = ['static', 'legacy-arcreel/project/source', 'legacy-arcreel/project/scripts',
      'legacy-arcreel/project/characters', 'legacy-arcreel/project/scenes', 'legacy-arcreel/project/props',
      'legacy-arcreel/project/storyboards', 'legacy-arcreel/project/videos', 'legacy-arcreel/project/versions',
      'legacy-arcreel/project/renders', 'legacy-arcreel/project/thumbnails', 'legacy-arcreel/project/subtitles']
    for (const relative of projectId === null ? roots : []) {
      const full = path.join(DATA_ROOT, relative)
      try { if ((await stat(full)).isDirectory()) archivePaths.push('-C', DATA_ROOT, relative) }
      catch { /* 旧项目或素材目录不存在 */ }
    }
    if (projectId !== null) {
      const files = new Set<string>()
      const collect = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(collect)
        if (value && typeof value === 'object') return Object.values(value).forEach(collect)
        if (typeof value === 'string') {
          const rel = value.replace(/^\//, '')
          if (rel.startsWith('static/') && !rel.split('/').some(part => part === '..') && !rel.includes('\\')) files.add(rel)
        }
      }
      collect(snapshot)
      for (const relative of files) {
        try { if ((await stat(path.join(DATA_ROOT, relative))).isFile()) archivePaths.push('-C', DATA_ROOT, relative) } catch { /* missing media */ }
      }
    }
    const filename = `huobao-scripts-assets-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`
    c.header('Content-Type', 'application/gzip')
    c.header('Content-Disposition', `attachment; filename="${filename}"`)
    c.header('Cache-Control', 'no-store')
    const tempDir = workingDir
    return stream(c, async (writer) => {
      const child = spawn('tar', ['-czf', '-', ...archivePaths], { stdio: ['ignore', 'pipe', 'ignore'] })
      const finished = new Promise<number>((resolve) => {
        child.once('error', () => resolve(1))
        child.once('close', (code) => resolve(code ?? 1))
      })
      try {
        for await (const chunk of child.stdout!) await writer.write(chunk)
        const code = await finished
        if (code !== 0) console.error('Storage export archive failed', code)
      } catch (error) {
        child.kill()
        console.error('Storage export stream failed', error)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  } catch (error) {
    if (workingDir) await rm(workingDir, { recursive: true, force: true })
    console.error('Storage export preparation failed', error)
    return c.json({ error: 'export_failed' }, 500)
  }
})

// Local browser mode schedules a verified offline copy on the next launch.
app.post('/local-location', async (c) => {
  const control = process.env.HUOBAO_LOCAL_CONTROL
  if (!control || process.platform !== 'win32') return c.json({ message: '当前运行模式不支持本机存储迁移' }, 400)
  const body = await c.req.json().catch(() => null)
  if (typeof body?.target !== 'string' || !path.win32.isAbsolute(body.target)) return c.json({ message: '请输入 Windows 绝对路径' }, 400)
  const target = path.resolve(body.target)
  const source = await realpath(DATA_ROOT)
  let parent: string
  try { parent = await realpath(path.dirname(target)) } catch { return c.json({ message: '目标父目录不存在' }, 400) }
  const actualTarget = path.join(parent, path.basename(target))
  const lower = (p: string) => path.resolve(p).toLowerCase()
  if (lower(actualTarget) === lower(source) || lower(actualTarget).startsWith(lower(source) + path.sep) || lower(source).startsWith(lower(actualTarget) + path.sep)) return c.json({ message: '目标和当前目录不能相同或互相嵌套' }, 400)
  try { const st = await lstat(actualTarget); if (st.isSymbolicLink() || !st.isDirectory()) return c.json({ message: '目标必须是普通文件夹，不能是链接或文件' }, 400) } catch (e: any) { if (e.code !== 'ENOENT') throw e }
  await mkdir(control, { recursive: true })
  const file = path.join(control, 'storage.json')
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify({ active: source, pending: actualTarget }), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
  return success(c, { target: actualTarget, restart_required: true })
})

app.get('/', async (c) => {
  const fresh = cache.computedAt && (Date.now() - new Date(cache.computedAt).getTime()) < USAGE_TTL_MS
  let usageStale = false
  if (!fresh) {
    if (cache.usage) {
      // stale-while-revalidate：先回旧值，后台重算
      usageStale = true
      void computeUsage()
    } else {
      // 首次无值，同步等待首算（保证进入页面必有数据）
      await computeUsage()
    }
  }

  const mode = process.env.HUOBAO_DESKTOP === '1' ? 'desktop' : 'server'
  let localMigrationError = ''
  if (process.env.HUOBAO_LOCAL_CONTROL) {
    try { localMigrationError = JSON.parse(await readFile(path.join(process.env.HUOBAO_LOCAL_CONTROL, 'storage.json'), 'utf8')).last_error || '' } catch {}
  }
  return success(c, {
    localMigrationError,
    mode,
    dataDir: DATA_ROOT,
    storageRoot: STORAGE_ROOT,
    sqlitePath: dbPath,
    usage: cache.usage,
    usageStale: usageStale || cache.computing,
    computedAt: cache.computedAt,
    freeBytes: await volumeFreeBytes(DATA_ROOT),
  })
})

export default app
