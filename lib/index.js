/**
 * dsh-center-workbench Host half —— 独立中栏面板的数据接口。
 *
 * 提供若干 HTTP 路由 + 一个 WebSocket 升级路由供浏览器端面板使用：
 *   - GET  /api/dsh-center-workbench/tree  ?path=<绝对路径> -> 列出目录条目
 *   - GET  /api/dsh-center-workbench/file  ?path=<绝对路径> -> 读取文本文件
 *   - POST /api/dsh-center-workbench/file/save {path,text}  -> 写回文件
 *   - POST /api/dsh-center-workbench/file/upload ?dir=&name= (原始二进制) -> 写入外部导入的文件
 *   - GET  /api/dsh-center-workbench/tree/recursive ?path=<绝对路径> -> 递归列出目录（相对路径）
 *   - GET  /api/dsh-center-workbench/env  -> 环境信息（用户主目录/平台/分隔符，供跨平台默认根目录）
 *   - GET  /api/dsh-center-workbench/tasks/live ?root=<会话id>  -> 运行中子代理的实时活动
 *   - POST /api/dsh-center-workbench/tasks/output {sessionId,id} -> 重放模型已读的任务输出
 *   - POST /api/dsh-center-workbench/tasks/kill {sessionId,id}  -> 终止后台任务
 *   - GET  /api/dsh-center-workbench/terminal （WebSocket 升级）-> 简化终端（子 shell 管道）
 *
 * 说明：这是单机、本机使用的面板，浏览器与 DSH 在同一台机器/宿主上；路径由
 * 客户端传绝对路径（通常是当前会话的 cwd），与本机 DSH agent 的文件访问权限一致。
 * 终端用 node-pty 起真实 pty，浏览器端用 xterm 渲染（宿主动态提供 xterm 的
 * JS/CSS）。
 */
import { readdir, stat, readFile, writeFile, cp, rename, rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, basename, dirname, sep } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import * as pty from 'node-pty'
import { WebSocketServer } from 'ws'

export const name = 'dsh-center-workbench'

export const inject = ['webServer']

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024

/** 依据扩展名推断 MIME（用于原生字节预览：图片/PDF/HTML 等）。 */
function mimeFromExt(path) {
  const ext = (path || '').split('.').pop().toLowerCase()
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
    html: 'text/html', htm: 'text/html', pdf: 'application/pdf',
    md: 'text/markdown', markdown: 'text/markdown',
    js: 'application/javascript', ts: 'application/javascript', json: 'application/json',
    css: 'text/css', txt: 'text/plain', py: 'text/x-python', sh: 'text/x-shellscript',
  }
  return map[ext] || 'application/octet-stream'
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(value))
}

async function readJsonBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

/** 读取原始二进制请求体（用于文件上传）。 */
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

function queryPath(req) {
  const url = new URL(req.url ?? '/', 'http://x')
  return url.searchParams.get('path') ?? ''
}

/** 清洗相对路径（可含子目录）：去反斜杠、剥离 .，拒绝 ..（防目录逃逸）。返回空串表示非法。 */
function sanitizeRel(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean)
  const safe = []
  for (const p of parts) {
    if (p === '.') continue
    if (p === '..') return ''   // 拒绝逃逸
    safe.push(p)
  }
  return safe.join('/')
}

/** 递归列出目录下所有文件/子目录（相对路径），供导出到外部时重建目录树。 */
async function walkTree(root) {
  const out = [] // { rel, isDir, size }
  async function walk(abs, rel) {
    const dirents = await readdir(abs, { withFileTypes: true })
    for (const d of dirents) {
      const childAbs = join(abs, d.name)
      const childRel = rel ? rel + '/' + d.name : d.name
      if (d.isDirectory()) {
        out.push({ rel: childRel, isDir: true, size: 0 })
        await walk(childAbs, childRel)
      } else {
        let size = 0
        try { size = (await stat(childAbs)).size } catch { /* ignore */ }
        out.push({ rel: childRel, isDir: false, size })
      }
    }
  }
  await walk(root, '')
  return out
}

// ===== 后台任务页（子代理拓扑 + 后台任务）宿主侧 helper =====

/** 从会话事件日志折叠出"最近一句文本 + 最近一个工具调用"（只回看尾部 maxMessages 条消息）。 */
function lastActivity(events, maxMessages) {
  let text
  let tool
  let messagesSeen = 0
  const limit = maxMessages || Infinity
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (text !== undefined && tool !== undefined) break
    const event = events[index]
    if (!event) continue
    const { type, data } = event
    if (type === 'user/message' || type === 'assistant/message') {
      messagesSeen += 1
      if (messagesSeen > limit) break
    } else if (messagesSeen >= limit) {
      continue
    }
    if (text === undefined && type === 'assistant/message') {
      const content = (data && data.message && data.message.content) || []
      const parts = []
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        }
      }
      if (parts.length > 0) text = parts.join('\n')
    } else if (tool === undefined && type === 'tool/call') {
      tool = {
        name: typeof data?.name === 'string' ? data.name : 'tool',
        args: typeof data?.arguments === 'string' ? data.arguments : '',
      }
    }
  }
  if (text === undefined && tool === undefined) return {}
  return { ...(text === undefined ? {} : { text }), ...(tool === undefined ? {} : { tool }) }
}

/** 解析 tool/result 的最终文本（concatenated text blocks）。 */
function resultText(message) {
  if (!message || !Array.isArray(message.content)) return undefined
  const parts = []
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue
    if (block.type !== 'tool-result') continue
    const inner = block.content
    if (!Array.isArray(inner)) continue
    for (const item of inner) {
      if (!item || typeof item !== 'object') continue
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** tool/result 是否为错误结果。 */
function resultIsError(message) {
  if (!message || !Array.isArray(message.content)) return false
  return message.content.some((block) => block && typeof block === 'object' && block.type === 'tool-result' && block.isError === true)
}

/** 模型 facing 的 "(no new output)" 无新输出噪音。 */
function isNoNewOutput(text) {
  return (text || '').startsWith('(no new output)')
}

/** 从单个会话事件里提取 job_output 的 trace（call/result 配对）。 */
function traceOf(event) {
  if (!event) return undefined
  if (event.type === 'tool/call') {
    const data = event.data || {}
    if (data.name !== 'job_output' || typeof data.callId !== 'string') return undefined
    let jobId
    try {
      const args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '')
      if (args && typeof args.job_id === 'string') jobId = args.job_id
    } catch { /* ignore */ }
    if (jobId === undefined) return undefined
    return { seq: event.seq, kind: 'call', callId: data.callId, jobId }
  }
  if (event.type === 'tool/result') {
    const message = (event.data && event.data.message) || undefined
    if (!message) return undefined
    const callId = message.source && message.source.callId
    if (typeof callId !== 'string') return undefined
    return { seq: event.seq, kind: 'result', callId, text: resultText(message), isError: resultIsError(message) }
  }
  return undefined
}

const MIRROR_MAX_ENTRIES = 200

/** 监听 session/event 流缓存 job_output 事件（补宿主重启后 store 日志滞后）。零 DSH 写入。 */
function createJobOutputMirror(ctx) {
  const perSession = new Map()
  const callIds = new Map()
  if (typeof ctx.on !== 'function') return { entries: () => [] }
  const push = (sessionId, trace) => {
    let list = perSession.get(sessionId)
    if (list === undefined) perSession.set(sessionId, list = [])
    list.push(trace)
    if (list.length > MIRROR_MAX_ENTRIES) {
      const removed = list.splice(0, list.length - MIRROR_MAX_ENTRIES)
      const ids = callIds.get(sessionId)
      if (ids !== undefined) {
        for (const e of removed) if (e.kind === 'call') ids.delete(e.callId)
        if (ids.size === 0) callIds.delete(sessionId)
      }
    }
  }
  const dispose = ctx.on('session/event', (session, event) => {
    const sessionId = session && session.id
    if (typeof sessionId !== 'string') return
    if (event && event.type === 'tool/call') {
      const trace = traceOf(event)
      if (!trace || trace.kind !== 'call') return
      let ids = callIds.get(sessionId)
      if (ids === undefined) callIds.set(sessionId, ids = new Set())
      ids.add(trace.callId)
      push(sessionId, trace)
    } else if (event && event.type === 'tool/result') {
      const trace = traceOf(event)
      if (!trace || trace.kind !== 'result') return
      if (!callIds.get(sessionId)?.has(trace.callId)) return
      push(sessionId, trace)
    }
  })
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-center-workbench: job-output event mirror')
  return { entries: (sessionId) => perSession.get(sessionId) || [] }
}

export function apply(ctx) {
  // List a directory -> entries (dirs first, then name).
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/tree',
    handler: async (req, res) => {
      try {
        const path = queryPath(req)
        if (!isAbsolute(path)) return sendJson(res, 400, { ok: false, error: 'path must be absolute' })
        const dirents = await readdir(path, { withFileTypes: true })
        const entries = []
        for (const d of dirents) {
          const full = join(path, d.name)
          let isDir = d.isDirectory()
          let size = 0
          if (!isDir) {
            try { size = (await stat(full)).size } catch { /* ignore */ }
          }
          entries.push({ name: d.name, isDir, size })
        }
        entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
        sendJson(res, 200, { ok: true, path, entries })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // Read a text file for preview.
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/file',
    handler: async (req, res) => {
      try {
        const path = queryPath(req)
        if (!isAbsolute(path)) return sendJson(res, 400, { ok: false, error: 'path must be absolute' })
        const st = await stat(path)
        if (st.isDirectory()) return sendJson(res, 400, { ok: false, error: 'is a directory' })
        if (st.size > MAX_PREVIEW_BYTES) return sendJson(res, 400, { ok: false, error: 'file too large to preview' })
        const buf = await readFile(path)
        const text = buf.toString('utf8')
        sendJson(res, 200, { ok: true, path, text })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // Save text content back to a file (POST body: { path, text }).
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/file/save',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const path = typeof body.path === 'string' ? body.path : ''
        if (!isAbsolute(path)) return sendJson(res, 400, { ok: false, error: 'path must be absolute' })
        const text = typeof body.text === 'string' ? body.text : ''
        await writeFile(path, text, 'utf8')
        sendJson(res, 200, { ok: true, path })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 原生字节预览（图片/PDF/HTML 等）：按 MIME 返回原始内容。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/media',
    handler: async (req, res) => {
      try {
        const path = queryPath(req)
        if (!isAbsolute(path)) return sendJson(res, 400, { ok: false, error: 'path must be absolute' })
        const st = await stat(path)
        if (st.isDirectory()) return sendJson(res, 400, { ok: false, error: 'is a directory' })
        const buf = await readFile(path)
        res.statusCode = 200
        res.setHeader('content-type', mimeFromExt(path))
        res.setHeader('cache-control', 'no-cache')
        res.end(buf)
      } catch (error) {
        res.statusCode = 404
        res.end('not found')
      }
    },
  })

  // 文件操作：复制 / 移动（支持文件与目录）。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/file/op',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const op = body && body.op
        const src = typeof body?.src === 'string' ? body.src : ''
        const dst = typeof body?.dst === 'string' ? body.dst : ''
        if (!isAbsolute(src) || !isAbsolute(dst)) return sendJson(res, 400, { ok: false, error: 'src/dst must be absolute' })
        // 防止把目录复制/移动到它自身或其子目录（cp 会抛 EINVAL）。
        const trim = (p) => p.replace(/[\\/]+$/, '')
        const a = trim(src), b = trim(dst)
        if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) {
          return sendJson(res, 400, { ok: false, error: '源与目标重叠，无法复制/移动（目标不能是源自身或其子目录）' })
        }
        if (op === 'copy') await cp(src, dst, { recursive: true, force: true })
        else if (op === 'move') await rename(src, dst)
        else return sendJson(res, 400, { ok: false, error: 'unknown op: ' + op })
        sendJson(res, 200, { ok: true, path: dst })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 删除文件/目录（递归）。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/file/del',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const path = typeof body?.path === 'string' ? body.path : ''
        if (!isAbsolute(path)) return sendJson(res, 400, { ok: false, error: 'path must be absolute' })
        await rm(path, { recursive: true, force: false })
        sendJson(res, 200, { ok: true, path })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 新建目录/文件。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/file/create',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const kind = body && body.kind
        const path = typeof body?.path === 'string' ? body.path : ''
        if (!isAbsolute(path)) return sendJson(res, 400, { ok: false, error: 'path must be absolute' })
        if (kind === 'dir') await mkdir(path, { recursive: false })
        else if (kind === 'file') await writeFile(path, '', 'utf8')
        else return sendJson(res, 400, { ok: false, error: 'unknown kind: ' + kind })
        sendJson(res, 200, { ok: true, path })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 上传浏览器端带来的外部文件（如从 Windows 资源管理器拖入 / 复制的文件）。
  // 请求体为原始二进制；目标目录经 ?dir=。路径经 ?rel=（相对路径，可含子目录，用于
  // 拖入文件夹时重建目录结构），且会清洗防 .. 逃逸；若 rel 为空则用 ?name= 单文件名。
  // 自动创建父目录。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/file/upload',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const dir = url.searchParams.get('dir') ?? ''
        const relRaw = url.searchParams.get('rel') ?? ''
        const name = url.searchParams.get('name') ?? ''
        if (!isAbsolute(dir)) return sendJson(res, 400, { ok: false, error: 'dir must be absolute' })
        const rel = sanitizeRel(relRaw) || sanitizeRel(name)
        if (!rel) return sendJson(res, 400, { ok: false, error: 'name 无效' })
        const buf = await readBody(req)
        const full = join(dir, rel)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, buf)
        sendJson(res, 200, { ok: true, path: full, size: buf.length })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 递归列出目录（相对路径），用于导出到外部时重建目录树。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/tree/recursive',
    handler: async (req, res) => {
      try {
        const path = queryPath(req)
        if (!isAbsolute(path)) return sendJson(res, 400, { ok: false, error: 'path must be absolute' })
        const entries = await walkTree(path)
        sendJson(res, 200, { ok: true, path, entries })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 环境信息：用户主目录 + 平台（客户端用它做跨平台默认根目录/兜底，不再写死 /home/sya）。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/env',
    handler: async (req, res) => {
      sendJson(res, 200, { ok: true, home: homedir(), platform: process.platform, sep })
    },
  })

  // 列出 Windows 盘符（C:/D:/…），供资源管理器切换盘；非 Windows 返回空。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/drives',
    handler: async (req, res) => {
      if (process.platform !== 'win32') return sendJson(res, 200, { ok: true, drives: [] })
      const drives = []
      for (let c = 65; c <= 90; c += 1) {
        const letter = String.fromCharCode(c)
        try { if (existsSync(`${letter}:\\`)) drives.push(`${letter}:`) } catch { /* ignore */ }
      }
      sendJson(res, 200, { ok: true, drives })
    },
  })

  // ===== 后台任务页：子代理实时 / 任务输出 / 强杀 =====
  // 任务列表本身随 harness 的 session/jobs 推送镜像进客户端（jobsBySession），无需路由。
  const tasksMirror = createJobOutputMirror(ctx)

  // 子代理拓扑里运行中子代理的实时"在干嘛"（最近文本/工具调用），一次请求折叠整棵树。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/tasks/live',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const root = url.searchParams.get('root') ?? ''
        const subagents = ctx.get('subagents')
        if (!subagents || typeof subagents.listDescendants !== 'function') {
          return sendJson(res, 503, { ok: false, error: 'subagents service not mounted' })
        }
        let descendants
        try { descendants = await subagents.listDescendants(root) }
        catch (e) { return sendJson(res, 503, { ok: false, error: 'catalog read failed: ' + String((e && e.message) || e) }) }
        const sessions = ctx.get('sessions')
        const live = {}
        for (const entry of descendants) {
          if (entry.kind !== 'child' || entry.activity !== 'running') continue
          if ((entry.label || '').startsWith('Side: ')) continue
          try {
            const activity = lastActivity(sessions?.get(entry.id)?.snapshotEvents() ?? [], 12)
            if (activity.text !== undefined || activity.tool !== undefined) live[entry.id] = activity
          } catch { /* 跳过该子代理 */ }
        }
        sendJson(res, 200, { ok: true, live })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 任务输出：重放模型已读到的部分（事件日志），绝不消费 job_output 游标。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/tasks/output',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const id = typeof body?.id === 'string' ? body.id : ''
        if (!sessionId || !id) return sendJson(res, 400, { ok: false, error: 'sessionId/id required' })
        const sessions = ctx.get('sessions')
        const bySeq = new Map()
        for (const event of sessions?.get(sessionId)?.snapshotEvents() ?? []) {
          const trace = traceOf(event)
          if (trace !== undefined) bySeq.set(trace.seq, trace)
        }
        for (const trace of tasksMirror.entries(sessionId)) bySeq.set(trace.seq, trace)
        const jobOf = new Map()
        const parts = []
        let read = false
        const sorted = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq)
        for (const trace of sorted) {
          if (trace.kind === 'call') {
            if (trace.jobId !== undefined) jobOf.set(trace.callId, trace.jobId)
          } else if (jobOf.get(trace.callId) === id) {
            read = true
            if (trace.isError !== true && trace.text !== undefined && !isNoNewOutput(trace.text)) parts.push(trace.text)
          }
        }
        const text = parts.join('\n')
        sendJson(res, 200, { ok: true, text: text.length > MAX_PREVIEW_BYTES ? text.slice(0, MAX_PREVIEW_BYTES) : text, truncated: text.length > MAX_PREVIEW_BYTES, read })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 强杀任务：DSH 原生 jobs.kill，按拥主会话的 live agent 围栏。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-center-workbench/tasks/kill',
    handler: async (req, res) => {
      try {
        const body = await readJsonBody(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const id = typeof body?.id === 'string' ? body.id : ''
        if (!sessionId || !id) return sendJson(res, 400, { ok: false, error: 'sessionId/id required' })
        const jobs = ctx.get('jobs')
        if (!jobs || typeof jobs.kill !== 'function') return sendJson(res, 503, { ok: false, error: 'jobs registry not mounted' })
        const agents = ctx.get('agents')
        const caller = agents?.get(sessionId)
        const reason = typeof body?.reason === 'string' && body.reason !== '' ? body.reason : 'user requested via sidebar'
        const outcome = jobs.kill(id, caller, reason)
        sendJson(res, 200, { ok: true, outcome })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // 终端：WebSocket 升级，node-pty 起真实 shell，浏览器端用 xterm 渲染。
  const terminalWss = new WebSocketServer({ noServer: true })
  const wssDispose = ctx.webServer.registerUpgrade({
    path: '/api/dsh-center-workbench/terminal',
    handler: async (req, socket, head) => {
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        const url = new URL(req.url ?? '/', 'http://x')
        // 跨平台：shell 按平台选（Windows 无 SHELL//bin/bash）。
        const isWin = process.platform === 'win32'
        // cwd 必须真实存在，否则 pty 的 chdir 会失败（如会话 cwd 已失效、homedir 异常）。
        // 依次取「客户端传入的 cwd → 用户主目录 → 进程当前目录 → 根目录」第一个存在的。
        const requestedCwd = url.searchParams.get('cwd')
        const candidates = [requestedCwd, homedir(), process.cwd(), isWin ? 'C:\\' : '/']
        let cwd = (candidates.find((p) => p && existsSync(p))) || homedir()
        const shell = isWin
          ? (process.env.COMSPEC || 'cmd.exe')
          : (process.env.SHELL || '/bin/bash')
        // bash/zsh 用登录 shell；cmd.exe/powershell 不认 -l。
        const shellArgs = isWin ? [] : ['-l']
        let proc
        try {
          proc = pty.spawn(shell, shellArgs, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: process.env })
        } catch (error) {
          try { ws.send('无法启动终端：' + String((error && error.message) || error) + '\r\n') } catch { /* ignore */ }
          try { ws.close(1011, 'pty spawn failed') } catch { /* ignore */ }
          return
        }
        const send = (data) => { if (ws.readyState === 1) ws.send(String(data)) }
        proc.onData(send)
        ws.on('message', (data) => {
          const raw = String(data)
          // 调整尺寸帧：{type:'resize', cols, rows}，不进 shell。
          if (raw.charCodeAt(0) === 0x7b) { // '{'
            try {
              const msg = JSON.parse(raw)
              if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) { try { proc.resize(msg.cols, msg.rows) } catch { /* ignore */ } return }
            } catch { /* not JSON, fall through to stdin */ }
          }
          try { proc.write(raw) } catch { /* proc already gone */ }
        })
        ws.on('close', () => { try { proc.kill() } catch { /* ignore */ } })
        proc.onExit(() => { try { ws.close() } catch { /* ignore */ } })
        send('\x1b[2J\x1b[H') // 清屏（xterm 能识别），不显示欢迎语
      })
    },
  })
  ctx.effect(() => () => {
    try { wssDispose?.() } catch { /* ignore */ }
    try { terminalWss.close() } catch { /* ignore */ }
  })

  // 供浏览器端加载 xterm 的 UMD/样式（本项目客户端是手写 bundle，无法直接 import 打包）。
  const req = createRequire(import.meta.url)
  const registerXtermStatic = (path, specifier, contentType) => {
    const file = req.resolve(specifier)
    ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          const buf = await readFile(file)
          res.statusCode = 200
          res.setHeader('content-type', contentType)
          res.setHeader('cache-control', 'no-cache')
          res.end(buf)
        } catch (error) {
          res.statusCode = 404
          res.end('not found')
        }
      },
    })
  }
  registerXtermStatic('/api/dsh-center-workbench/xterm.js', '@xterm/xterm/lib/xterm.js', 'application/javascript; charset=utf-8')
  registerXtermStatic('/api/dsh-center-workbench/addon-fit.js', '@xterm/addon-fit/lib/addon-fit.js', 'application/javascript; charset=utf-8')
  registerXtermStatic('/api/dsh-center-workbench/xterm.css', '@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8')
}
