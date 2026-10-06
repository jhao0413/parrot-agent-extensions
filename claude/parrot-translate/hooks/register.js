/**
 * parrot-translate — Claude 的英文回复自动翻成配置的目标语言；发出的提示词保证是地道英文。
 *
 * 行为：回复稳定约 1.5s 后后台翻好缓存；快捷键（Ctrl+Y）切换显示。
 * 逐段穿插：每段原文下面直接跟它自己的 `> ` 译文。
 * 出站：prompt.submit 时把提示词改写成英文（其他语言忠实翻译；英文只修语法，
 * 不改意思），模型与 transcript 收到的都是英文；用户消息行渲染成双语对照。
 * 粘贴的技术性内容（错误信息/堆栈/JSON/日志/diff）两侧都不送翻，原样放行。
 *
 * 翻译服务（/config 里换，见 plugin.json 的 userConfig）：
 *  - microsoft（默认）：Edge 免费接口（与 parrot 扩展同款），无需 key
 *  - session：$.model.complete 走本会话凭证跑一次独立补全（默认 haiku），免配置、质量更好、耗 token
 *
 * 注：hooks module 只能 import 相对路径和 "claude-code"，所以没有外部依赖。
 */
const MAX_CHARS = 3000 // 单次请求的字符上限（微软同款留余量；出站超长段也按它切块）
const MODEL_TIMEOUT = 30_000
const MAX_TOKENS = 16_000 // 单次补全输出上限：3000 字符块的重写远用不满，防静默截断
const MAP_CAP = 500 // cache / outboundMap 条目上限（FIFO 淘汰最旧，防长会话无限增长）

/** userConfig 传入的配置（register 时初始化） */
const cfg = { showByDefault: false, outbound: true, lang: 'zh-Hans', provider: 'microsoft', model: 'haiku', baseUrl: 'http://127.0.0.1:8021/v1', apiKey: '' }

/** 显示开关（快捷键翻转；初始值来自 showByDefault 配置） */
let show = false

/** 原文 -> { state: 'pending'|'done'|'skip'|'error', md? }，按消息块缓存 */
const cache = new Map()

/** 发出的英文 -> 用户原话：UserMessage 渲染层做双语对照（不落盘、不进上下文） */
const outboundMap = new Map()

/** Map.set + FIFO 上限。代价：滚回很早的消息会丢缓存（回复侧重翻一次）或丢双语对照（回落英文行） */
function putCapped(map, key, val) {
  if (!map.has(key) && map.size >= MAP_CAP) map.delete(map.keys().next().value)
  map.set(key, val)
}

/**
 * 防抖调度：流式期间每次渲染都会重置 1.5s 计时器，文本稳定（流结束）后才真正去翻。
 * 不依赖 turn.start/turn.complete —— 实测它们不一定触发，一旦不触发整条管线就死掉。
 */
let stableTimer = null
const seen = new Set() // 待调度的原文（一次稳定后批量调度）

/* ---------------- 目标语言（用户语言，/config 可换） ---------------- */

/** 常见微软语言码 -> 英文名（提示词用）；不在表里就直接用码本身 */
const LANG_NAMES = {
  'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese',
  en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German',
  es: 'Spanish', it: 'Italian', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic',
  hi: 'Hindi', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', tr: 'Turkish',
  nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian',
}
const langName = () => LANG_NAMES[cfg.lang] ?? cfg.lang
/** 同一语言（比主子标签：zh-Hans 与 zh-Hant 都算 zh） */
const sameLang = (a, b) =>
  !!a && !!b && String(a).toLowerCase().split('-')[0] === String(b).toLowerCase().split('-')[0]

/* ---------------- 微软（Edge 免费接口，同 parrot microsoft.ts） ---------------- */

/* 宿主有时会把 JSON 响应预解析成对象塞进 text（类型声明说是 string，别信）；两头都兼容 */
function parseBody(res) {
  return typeof res.text === 'string' ? JSON.parse(res.text) : res.text
}

async function msFetch($, text, to = cfg.lang) {
  const qs = new URLSearchParams({ from: '', to, isEnterpriseClient: 'false' })
  const res = await $.http.fetch(`https://edge.microsoft.com/translate/translatetext?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([text]),
  })
  if (!res.ok) throw new Error(`microsoft HTTP ${res.status}`)
  const body = parseBody(res)
  if (!Array.isArray(body) || body.length !== 1) throw new Error('microsoft bad response')
  return { out: body[0].translations?.[0]?.text ?? '', from: body[0].detectedLanguage?.language ?? '' }
}

/* ---------------- 模型（$.model.complete，走本会话凭证） ---------------- */

const MODEL_SYSTEM = () =>
  `Translate the user message into ${langName()}. ` +
  'Preserve the markdown structure exactly: lists, headings, tables, inline code, emphasis, links. ' +
  'Keep code, identifiers, file paths, commands and URLs unchanged. ' +
  `If the message is already entirely in ${langName()}, return it exactly unchanged. ` +
  'Return ONLY the translation, no preamble, no notes.'

async function modelFetch($, text, system) {
  const r = await $.model.complete({
    model: cfg.model,
    system: system ?? MODEL_SYSTEM(),
    prompt: text,
    maxTokens: MAX_TOKENS,
    timeoutMs: MODEL_TIMEOUT,
  })
  if (!r.isAnswered) throw new Error(`model did not answer (${r.reason ?? 'unknown'})`)
  return { out: r.text.trim(), from: '' }
}

/* ---------------- OpenAI 兼容（本地 llama.cpp / 远端兼容服务） ---------------- */

const OPENAI_SYSTEM = () =>
  `Translate into ${langName()}. Keep code, identifiers, file paths, commands and URLs unchanged. ` +
  `If it is already entirely in ${langName()}, return it exactly unchanged. ` +
  'Preserve the markdown structure. Return ONLY the translation.'

/** 剥掉推理模型可能带的 <think>...</think>（哪怕为空） */
function stripThink(s) {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

async function openaiFetch($, text, system) {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const payload = JSON.stringify({
    model: cfg.model,
    stream: false,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system ?? OPENAI_SYSTEM() },
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
  if (body?.choices?.[0]?.finish_reason === 'length') throw new Error('openai truncated (finish_reason=length)')
  const en = stripThink(String(body?.choices?.[0]?.message?.content ?? ''))
  if (!en) throw new Error('openai empty completion')
  return { out: en, from: '' }
}

/** 段落是否是 CJK 为主（zh 系目标翻译前先本地判断，省 token） */
function isMostlyZh(s) {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const letters = (s.match(/[A-Za-z]/g) || []).length
  return cjk > 0 && cjk >= letters
}

/**
 * 回复侧：段落是否已经是目标语言为主。只有 zh 系目标有可靠的本地判断（CJK 字符好数）；
 * 其他目标语言没有便宜的本地判断，交给接口的源语言检测 / 提示词的「已是目标语言
 * 则原样返回」约定（见 translateProse 的逐块比对）。
 */
function isMostlyTarget(s) {
  return /^zh/i.test(cfg.lang) ? isMostlyZh(s) : false
}

/**
 * 段落是否是「技术性粘贴」：错误信息、堆栈、JSON、日志、diff、十六进制/表格等。
 * 这些内容翻译/改写只会帮倒忙，两侧（出站与回复）都直接跳过；要百分之百确保
 * 原样，用 ``` 围栏包住（围栏在结构层就不送翻）。规则各自独立、偏保守，
 * 像散文的内容一条都不该命中。
 */
function looksTechnical(s) {
  const t = s.trim()
  if (!t) return false
  // JSON（或接近 JSON：粘贴时头尾缺行很常见）
  if (/^[[{]/.test(t)) {
    try { JSON.parse(t); return true } catch { /* 不完整，看下面的规则 */ }
    if ((t.match(/":\s/g) || []).length >= 2) return true
  }
  // 堆栈：JS 的 at fn (file:1:2) / Python 的 Traceback + File "...", line N
  if (/^\s*at\s+[\w$.#<>-]+\s*\(.*:\d+:\d+\)/m.test(t)) return true
  if (/Traceback \(most recent call last\)|File ".*", line \d+/.test(t)) return true
  // 日志行：时间戳或等级开头的行
  if (/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/m.test(t)) return true
  if (/^\[?(ERROR|WARN|WARNING|INFO|DEBUG|FATAL|CRITICAL|TRACE|NOTICE)[\]:]/m.test(t)) return true
  if (/^npm (ERR!|WARN)/m.test(t)) return true
  // diff / patch
  if (/^(diff --git |@@ -\d+(,\d+)? \+\d+(,\d+)? @@|--- a\/|\+\+\+ b\/)/m.test(t)) return true
  // 符号密度：字母+CJK 占非空白字符不到 35%（十六进制、base64、表格、URL 堆）
  const ns = t.replace(/\s/g, '')
  const word = (ns.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length
  return ns.length >= 40 && word / ns.length < 0.35
}

/* ---------------- 管线 ---------------- */

/** 把消息块拆成段：``` 围栏整段保留为 { code }，散文按空行分段为 { text } */
function splitParas(text) {
  const paras = []
  for (const part of text.split(/(```[\s\S]*?```)/g)) {
    if (!part.trim()) continue
    if (part.startsWith('```')) {
      paras.push({ code: part })
      continue
    }
    // 散文部分按空行分段（列表内部是单换行，会被当成一段整体翻，保留结构）
    for (const para of part.split(/\n{2,}/)) if (para.trim()) paras.push({ text: para })
  }
  return paras
}

/** 固定并发跑一批任务（worker 内部自行 try/catch，单条失败不外溢） */
async function runPool(items, size, worker) {
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) await worker(items[cursor++])
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run))
}

/** 超长段落（无空行可分段）按行边界切块；单行仍超限就按 max 硬切 */
function chunkParagraph(s, max = MAX_CHARS) {
  if (s.length <= max) return [s]
  const chunks = []
  let cur = ''
  for (const line of s.split('\n')) {
    if (line.length > max) {
      if (cur) { chunks.push(cur); cur = '' }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max))
    } else if (cur && cur.length + line.length + 1 > max) {
      chunks.push(cur)
      cur = line
    } else {
      cur = cur ? `${cur}\n${line}` : line
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

const fetchOne = ($, text, opts = {}) =>
  cfg.provider === 'session'
    ? modelFetch($, text, opts.system)
    : cfg.provider === 'openai'
      ? openaiFetch($, text, opts.system)
      : msFetch($, text, opts.to)

/** 一段散文按空行切块翻译；源语言已是目标语言时返回 null（不用翻） */
async function translateProse($, text) {
  if (looksTechnical(text)) return null
  if (cfg.provider !== 'microsoft' && isMostlyTarget(text)) return null

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
  let any = false
  for (const chunk of chunks) {
    const r = await fetchOne($, chunk)
    srcLang = r.from || srcLang
    // 模型判定「已是目标语言」会原样返回：该块保持原文、不算翻过
    if (r.out.trim() && r.out.trim() !== chunk.trim()) {
      out.push(r.out)
      any = true
    } else {
      out.push(chunk)
    }
  }
  if (cfg.provider === 'microsoft' && sameLang(srcLang, cfg.lang)) return null
  return any ? out.join('\n\n') : null
}

/**
 * 翻一个消息块，逐段穿插：每段原文下面直接跟它自己的 `> ` 译文；
 * ``` 代码块不送翻也不插入译文。返回拼好的完整 markdown，
 * 全部跳过（已是目标语言/无散文）时返回 null。
 * 段落并行翻（并发 4）：本地 llama.cpp 有连续 batching，串行会让长回复等几十秒。
 */
async function translateBlock($, text) {
  const paras = splitParas(text)
  await runPool(paras, 4, async (p) => {
    if (p.code !== undefined) return
    try {
      const zh = await translateProse($, p.text)
      if (zh) p.zh = zh
    } catch { /* 单段失败不影响其它段 */ }
  })

  const out = []
  let any = false
  for (const p of paras) {
    out.push(p.code !== undefined ? p.code : p.text)
    if (p.zh) {
      out.push(p.zh.split('\n').map((l) => `> ${l}`).join('\n'))
      any = true
    }
  }
  return any ? out.join('\n\n') : null
}

/* ---------------- 出站：保证发给模型的一定是英文 ---------------- */

const OUT_MODEL_SYSTEM = () =>
  'The message is a prompt on its way to a coding agent. Rewrite it into natural, grammatically correct English: ' +
  'if it is in another language, translate it faithfully without changing the meaning; if it is already in English, ' +
  'fix only grammar, spelling and typography errors. Never change the meaning, tone or technical content. ' +
  `The author's first language is ${langName()}; keep the English plain and idiomatic. ` +
  'Preserve the markdown structure; keep code, identifiers, file paths, commands, flags and URLs unchanged. ' +
  'If nothing needs changing, return the text exactly as given. ' +
  'Return ONLY the rewritten text, no preamble, no notes.'

const OUT_OPENAI_SYSTEM = () =>
  'Rewrite the prompt into natural, grammatically correct English: translate it faithfully if it is in another ' +
  'language, or fix only grammar/spelling/typo errors if it is already English. Never change the meaning. ' +
  `The author's first language is ${langName()}. ` +
  'Keep code, identifiers, file paths, commands and URLs unchanged. Preserve the markdown structure. ' +
  'If nothing needs changing, return the text exactly as given. Return ONLY the rewritten text.'

/**
 * 出站一段散文：转成英文；已是英文且无需改动时返回 null（保持原文）。
 * microsoft 靠接口自带的源语言检测；session/openai 一条提示词同时覆盖
 * 「其他语言→翻译」和「英文→修语法」，由模型自己判断走哪条。
 */
async function ensureEnglishProse($, text) {
  if (looksTechnical(text)) return null // 粘贴的错误信息/JSON/日志等原样放行
  if (cfg.provider === 'microsoft') {
    // 超长段按行边界切块逐块送翻；首块检测出英文即整段放行（免费接口没有语法检查能力）
    const chunks = chunkParagraph(text)
    const out = []
    let any = false
    for (let i = 0; i < chunks.length; i++) {
      const r = await msFetch($, chunks[i], 'en')
      if (i === 0 && /^en(-|$)/i.test(r.from)) return null
      const en = r.out.trim()
      if (en && en !== chunks[i].trim()) { out.push(en); any = true } else out.push(chunks[i])
    }
    return any ? out.join('\n') : null
  }
  const system = cfg.provider === 'session' ? OUT_MODEL_SYSTEM() : OUT_OPENAI_SYSTEM()
  const out = []
  let any = false
  for (const chunk of chunkParagraph(text)) {
    const r = await fetchOne($, chunk, { system })
    const en = r.out.trim()
    if (en && en !== chunk.trim()) { out.push(en); any = true } else out.push(chunk)
  }
  return any ? out.join('\n') : null
}

/** 出站整块：``` 代码围栏不动，散文段并发处理；返回 { text, changed }（没改动时 text 即原文） */
async function outboundBlock($, text) {
  const paras = splitParas(text)
  await runPool(paras, 4, async (p) => {
    if (p.code !== undefined) return
    try {
      const en = await ensureEnglishProse($, p.text)
      if (en) p.en = en
    } catch { /* 单段失败放原文，绝不拦提示词 */ }
  })

  let any = false
  const out = paras.map((p) => {
    if (p.code !== undefined) return p.code
    if (p.en) any = true
    return p.en ?? p.text
  })
  return { text: any ? out.join('\n\n') : text, changed: any }
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
  putCapped(cache, text, { state: 'pending' })
  diag($, `schedule len=${text.length}`)
  translateBlock($, text)
    .then((md) => {
      putCapped(cache, text, { state: md ? 'done' : 'skip', md })
      diag($, `done len=${text.length} ${md ? 'md=' + md.length : 'skip'}`)
      if (show) {
        $.ui.invalidate('ui.render')
        $.ui.toast('译文就绪')
      }
    })
    .catch((err) => {
      putCapped(cache, text, { state: 'error' })
      diag($, `error len=${text.length}: ${String((err && err.message) || err).slice(0, 150)}`)
      if (show) $.ui.toast('翻译失败，见 /tmp/pt-live.log')
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
  cfg.showByDefault = options?.show_by_default !== false // 默认 true（0.4.3 起）
  cfg.outbound = options?.outbound !== false
  cfg.lang = typeof options?.lang === 'string' && options.lang.trim() ? options.lang.trim() : 'zh-Hans'
  // 旧值 model（≤0.4.1）兼容：映射为 session
  const providerRaw = typeof options?.provider === 'string' ? options.provider.trim() : ''
  cfg.provider = providerRaw === 'model' ? 'session' : ['session', 'openai'].includes(providerRaw) ? providerRaw : 'microsoft'
  cfg.model = typeof options?.model === 'string' && options.model.trim() ? options.model.trim() : 'haiku'
  cfg.baseUrl = typeof options?.base_url === 'string' && options.base_url.trim() ? options.base_url.trim() : 'http://127.0.0.1:8021/v1'
  cfg.apiKey = typeof options?.api_key === 'string' ? options.api_key : ''
  show = cfg.showByDefault

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'translate', description: 'Show/hide translation of replies' })
    diag($, `loaded provider=${cfg.provider} model=${cfg.model} baseUrl=${cfg.baseUrl} showByDefault=${cfg.showByDefault} outbound=${cfg.outbound} lang=${cfg.lang}`)
    return next(e)
  })

  on('command.run', { command: 'translate' }, async ($) => {
    show = !show
    diag($, `toggle show=${show}`)
    if (show) {
      // 等待反馈：还有段在翻时直接告诉用户，免得对着空白狂按
      const pending = [...cache.values()].filter((e) => e.state === 'pending').length
      const error = [...cache.values()].filter((e) => e.state === 'error').length
      if (pending) $.ui.toast(`翻译中（还有 ${pending} 块，本地模型较慢）…`)
      else if (error) $.ui.toast('部分翻译失败，详见 /tmp/pt-live.log')
      else $.ui.toast('译文：显示')
    } else {
      $.ui.toast('译文：隐藏')
    }
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props?.text
    if (!text || !text.trim()) return next(e)

    // 默认就翻（与显示无关）：防抖 1.5s，文本稳定后才调度（见 onRenderText）。
    // onRenderText 只登记防抖，不会同步写 cache，这里不必重读。
    const entry = cache.get(text)
    if (!entry) onRenderText($, text)

    if (!show) return next(e)

    // 诊断：show=true 时记录每次渲染到达，用于排查「切了显示但没重画」
    diag($, `render len=${text.length} state=${entry ? entry.state : 'none'}`)
    if (!entry || entry.state !== 'done') return next(e)

    // 缓存里已是拼好的逐段穿插版本，直接替换显示文本（只影响渲染，不落盘不进上下文）
    return next({ ...e, props: { ...e.props, text: entry.md } })
  })

  // 出站：本机敲 Enter 的提示词改写成英文再进会话（插件/peer/通知的提交不动）
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    const text = e.text ?? ''
    if (!cfg.outbound || !text.trim() || text.startsWith('/')) return next(e)
    try {
      if (cfg.provider !== 'microsoft' && text.length > 120) $.ui.toast('正在把提示词转成英文…')
      const { text: en, changed } = await outboundBlock($, text)
      if (!changed || !en.trim()) return next(e)
      putCapped(outboundMap, en, text) // 先入映射再 next，跟上的重渲染直接能画对照
      diag($, `outbound len=${text.length} -> ${en.length}`)
      // 模型与落盘都是英文；屏幕上的用户行跟着变英文，由下面的渲染钩子画成双语对照
      return next({ ...e, text: en })
    } catch (err) {
      diag($, `outbound error: ${String((err && err.message) || err).slice(0, 150)}`)
      return next(e) // 任何失败都原样放行，绝不拦提示词
    }
  })

  // 用户消息行的双语对照：原文在上，实际发出的英文 `> ` 引用在下（只影响渲染）
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const text = e.props?.text
    const orig = text ? outboundMap.get(text) : undefined
    if (orig === undefined) return next(e)
    const quote = text.split('\n').map((l) => `> ${l}`).join('\n')
    return next({ ...e, props: { ...e.props, text: `${orig}\n\n${quote}` } })
  })
}
