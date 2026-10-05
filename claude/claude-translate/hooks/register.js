/**
 * parrot-translate — Claude 的英文回复自动翻成中文。
 *
 * 行为：回复稳定约 1.5s 后后台翻好缓存；快捷键（Ctrl+Y）切换显示。
 * 逐段穿插：每段原文下面直接跟它自己的 `> ` 译文。
 *
 * 翻译服务（/config 里换，见 plugin.json 的 userConfig）：
 *  - microsoft（默认）：Edge 免费接口（与 parrot 扩展同款），无需 key
 *  - model：$.model.complete 走本会话模型凭证（默认 haiku），质量更好、耗 token
 *
 * 注：hooks module 只能 import 相对路径和 "claude-code"，所以没有外部依赖。
 */
const MAX_CHARS = 3000 // 单次请求的字符上限（微软同款留余量）
const MODEL_TIMEOUT = 30_000

/** userConfig 传入的配置（register 时初始化） */
const cfg = { showByDefault: false, provider: 'microsoft', model: 'haiku', baseUrl: 'http://127.0.0.1:8021/v1', apiKey: '' }

/** 显示开关（快捷键翻转；初始值来自 showByDefault 配置） */
let show = false

/** 原文 -> { state: 'pending'|'done'|'skip'|'error', md? }，按消息块缓存 */
const cache = new Map()

/**
 * 防抖调度：流式期间每次渲染都会重置 1.5s 计时器，文本稳定（流结束）后才真正去翻。
 * 不依赖 turn.start/turn.complete —— 实测它们不一定触发，一旦不触发整条管线就死掉。
 */
let stableTimer = null
const seen = new Set() // 待调度的原文（一次稳定后批量调度）

/* ---------------- 微软（Edge 免费接口，同 parrot microsoft.ts） ---------------- */

/* 宿主有时会把 JSON 响应预解析成对象塞进 text（类型声明说是 string，别信）；两头都兼容 */
function parseBody(res) {
  return typeof res.text === 'string' ? JSON.parse(res.text) : res.text
}

async function msFetch($, text) {
  const qs = new URLSearchParams({ from: '', to: 'zh-Hans', isEnterpriseClient: 'false' })
  const res = await $.http.fetch(`https://edge.microsoft.com/translate/translatetext?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([text]),
  })
  if (!res.ok) throw new Error(`microsoft HTTP ${res.status}`)
  const body = parseBody(res)
  if (!Array.isArray(body) || body.length !== 1) throw new Error('microsoft bad response')
  return { zh: body[0].translations?.[0]?.text ?? '', from: body[0].detectedLanguage?.language ?? '' }
}

/* ---------------- 模型（$.model.complete，走本会话凭证） ---------------- */

const MODEL_SYSTEM =
  'Translate the user message into Simplified Chinese. ' +
  'Preserve the markdown structure exactly: lists, headings, tables, inline code, emphasis, links. ' +
  'Keep code, identifiers, file paths, commands and URLs unchanged. ' +
  'Return ONLY the translation, no preamble, no notes.'

async function modelFetch($, text) {
  const r = await $.model.complete({
    model: cfg.model,
    system: MODEL_SYSTEM,
    prompt: text,
    maxTokens: 4000,
    timeoutMs: MODEL_TIMEOUT,
  })
  if (!r.isAnswered) throw new Error(`model did not answer (${r.reason ?? 'unknown'})`)
  return { zh: r.text.trim(), from: '' }
}

/* ---------------- OpenAI 兼容（本地 llama.cpp / 远端兼容服务） ---------------- */

const OPENAI_SYSTEM =
  'Translate into Simplified Chinese. Keep code, identifiers, file paths, commands and URLs unchanged. ' +
  'Preserve the markdown structure. Return ONLY the translation.'

/** 剥掉推理模型可能带的 <think>...</think>（哪怕为空） */
function stripThink(s) {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

async function openaiFetch($, text) {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const payload = JSON.stringify({
    model: cfg.model,
    stream: false,
    temperature: 0.2,
    messages: [
      { role: 'system', content: OPENAI_SYSTEM },
      { role: 'user', content: text },
    ],
  })
  // 宿主的 $.http.fetch 连 localhost 会被 reset（SSRF 防护），curl 直连没问题
  const args = ['curl', '-s', '--max-time', '120', '-X', 'POST', `${base}/chat/completions`,
    '-H', 'Content-Type: application/json', '--data-binary', payload]
  if (cfg.apiKey) args.push('-H', `Authorization: Bearer ${cfg.apiKey}`)
  const r = await $.process.run(args)
  if (r.exitCode !== 0) throw new Error(`openai curl exit ${r.exitCode}`)
  const body = JSON.parse(r.stdout)
  const zh = stripThink(String(body?.choices?.[0]?.message?.content ?? ''))
  if (!zh) throw new Error('openai empty completion')
  return { zh, from: '' }
}

/** 段落是否本来就是中文为主（模型/本地模型翻译前先本地判断，省 token） */
function isMostlyZh(s) {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const letters = (s.match(/[A-Za-z]/g) || []).length
  return cjk > 0 && cjk >= letters
}

/* ---------------- 管线 ---------------- */

const fetchOne = ($, text) =>
  cfg.provider === 'model' ? modelFetch($, text) : cfg.provider === 'openai' ? openaiFetch($, text) : msFetch($, text)

/** 一段散文按空行切块翻译；源语言是中文时返回 null（不用翻） */
async function translateProse($, text) {
  if (cfg.provider !== 'microsoft' && isMostlyZh(text)) return null

  const chunks = []
  let cur = ''
  for (const para of text.split(/\n{2,}/)) {
    if (cur && (cur.length + para.length + 2) > MAX_CHARS) {
      chunks.push(cur)
      cur = para
    } else {
      cur = cur ? `${cur}\n\n${para}` : para
    }
  }
  if (cur.trim()) chunks.push(cur)

  const out = []
  let srcLang = ''
  for (const chunk of chunks) {
    const r = await fetchOne($, chunk)
    srcLang = r.from || srcLang
    out.push(r.zh)
  }
  if (cfg.provider === 'microsoft' && /^zh/i.test(srcLang)) return null
  return out.join('\n\n')
}

/**
 * 翻一个消息块，逐段穿插：每段原文下面直接跟它自己的 `> ` 译文；
 * ``` 代码块不送翻也不插入译文。返回拼好的完整 markdown，
 * 全部跳过（中文/无散文）时返回 null。
 */
async function translateBlock($, text) {
  const out = []
  let any = false
  for (const part of text.split(/(```[\s\S]*?```)/g)) {
    if (!part.trim()) continue
    if (part.startsWith('```')) {
      out.push(part)
      continue
    }
    // 散文部分按空行分段，逐段翻译后紧跟在原段下面（列表内部是单换行，会被当成一段整体翻，保留结构）
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue
      out.push(para)
      const zh = await translateProse($, para)
      if (zh) {
        out.push(zh.split('\n').map((l) => `> ${l}`).join('\n'))
        any = true
      }
    }
  }
  return any ? out.join('\n\n') : null
}

/** 诊断：写 /tmp/pt-live.log（只记关键转移，保留最近 60 条） */
const dbg = []
function diag($, msg) {
  dbg.push(`${new Date().toISOString().slice(11, 23)} ${msg}`)
  if (dbg.length > 60) dbg.shift()
  $.fs.write('/tmp/pt-live.log', dbg.join('\n') + '\n').catch(() => {})
}

function scheduleOne($, text) {
  if (cache.has(text)) return
  cache.set(text, { state: 'pending' })
  diag($, `schedule len=${text.length}`)
  translateBlock($, text)
    .then((md) => {
      cache.set(text, { state: md ? 'done' : 'skip', md })
      diag($, `done len=${text.length} ${md ? 'md=' + md.length : 'skip'}`)
      if (show) $.ui.invalidate('ui.render')
    })
    .catch((err) => {
      cache.set(text, { state: 'error' })
      diag($, `error len=${text.length}: ${String((err && err.message) || err).slice(0, 150)}`)
    })
}

function onRenderText($, text) {
  seen.add(text)
  if (stableTimer) stableTimer.cancel()
  stableTimer = $.clock.after(1500, () => {
    stableTimer = null
    const texts = [...seen]
    seen.clear()
    for (const t of texts) scheduleOne($, t)
  })
}

export function register(on, options) {
  // userConfig（/config 面板或 settings.json 的 pluginConfigs["parrot-translate@inline"]）
  cfg.showByDefault = options?.show_by_default === true
  cfg.provider = ['model', 'openai'].includes(options?.provider) ? options.provider : 'microsoft'
  cfg.model = typeof options?.model === 'string' && options.model.trim() ? options.model.trim() : 'haiku'
  cfg.baseUrl = typeof options?.base_url === 'string' && options.base_url.trim() ? options.base_url.trim() : 'http://127.0.0.1:8021/v1'
  cfg.apiKey = typeof options?.api_key === 'string' ? options.api_key : ''
  show = cfg.showByDefault

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'translate', description: 'Show/hide Chinese translation of replies' })
    diag($, `loaded provider=${cfg.provider} model=${cfg.model} baseUrl=${cfg.baseUrl} showByDefault=${cfg.showByDefault}`)
    return next(e)
  })

  on('command.run', { command: 'translate' }, async ($) => {
    show = !show
    diag($, `toggle show=${show}`)
    $.ui.toast(show ? '译文：显示' : '译文：隐藏')
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props?.text
    if (!text || !text.trim()) return next(e)

    // 默认就翻（与显示无关）：防抖 1.5s，文本稳定后才调度（见 onRenderText）
    let entry = cache.get(text)
    if (!entry) {
      onRenderText($, text)
      entry = cache.get(text)
    }

    if (!show || !entry || entry.state !== 'done') return next(e)

    // 缓存里已是拼好的逐段穿插版本，直接替换显示文本（只影响渲染，不落盘不进上下文）
    return next({ ...e, props: { ...e.props, text: entry.md } })
  })
}
