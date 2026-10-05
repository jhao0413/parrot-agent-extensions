# parrot-translate (Claude Code)

Claude 的英文回复**后台自动翻成中文**，快捷键（`Ctrl+Y`）切换显示。逐段穿插：每段原文下面直接跟它自己的 `▎` 译文。

## 配置（三项）

会话里 **`/config` 面板**可以直接改（每个 userConfig 是一行）；或改 `~/.claude/settings.json`：

```json
{
  "pluginConfigs": {
    "parrot-translate@inline": {
      "options": {
        "show_by_default": false,
        "provider": "microsoft",
        "model": "haiku"
      }
    }
  }
}
```

> 注意值要包在 `"options"` 里——直接写 `"parrot-translate@inline": {"provider": ...}` **不会生效**（踩过）。

| 选项 | 默认 | 说明 |
|---|---|---|
| `show_by_default` | `false` | `true` 时译文直接随回复显示，`Ctrl+Y` 变为收起/展开 |
| `provider` | `microsoft` | `microsoft` = Edge 免费接口（同 parrot 扩展，免 key、快）；`model` = 本会话模型；`openai` = OpenAI 兼容接口（本地 llama.cpp / 远端兼容服务） |
| `model` | `haiku` | `provider = model / openai` 时用；别名（`haiku` / `sonnet`）或完整 id（如 `index-translate-2b`） |
| `base_url` | `http://127.0.0.1:8021/v1` | `provider = openai` 时的接口地址 |
| `api_key` | 空 | `provider = openai` 时用；本地 llama.cpp 随便填（如 `sk-local`，不校验） |

当前生效配置（本地 index-translate-2b）：

```json
"pluginConfigs": {
  "parrot-translate@inline": {
    "options": {
      "provider": "openai",
      "model": "index-translate-2b",
      "base_url": "http://127.0.0.1:8021/v1",
      "api_key": "sk-local"
    }
  }
}
```

实测对比（同一段 5000 字符的回复）：微软 ~3s；模型（haiku）~32s、译文更自然；本地 index-translate-2b ~46s、免费且代码路径保留得很干净。

## 行为细节

- **翻译默认一直开着**（后台做），快捷键只控制显示；译文按消息块缓存，翻一次后切换即时
- **防抖 1.5s**：流式渲染期间计时器不断重置，文本稳定（回复结束）约 1.5 秒后才真正去翻。不依赖 `turn.start`/`turn.complete`——实测这对事件不一定触发，一旦不触发整条管线就死掉（第一版就是这个 bug）
- **逐段穿插**：按空行分段，列表/标题整段翻保留结构；``` 代码块不送翻也不插译文
- 微软路径靠接口的 `detectedLanguage` 跳过中文块；模型路径先本地判断「中文为主」再跳过，省 token
- 长段自动按空行切块（≤3000 字符）
- `/tmp/pt-live.log` 诊断日志（最近 60 条关键转移），排查看它
- `/translate` 命令与 `Ctrl+Y` 等价；键位在 `~/.claude/keybindings.json`

## 不影响上下文（已验证）

译文只改**渲染层**：`ui.render` 的 `AssistantMessage` 站点改的是"这块怎么画"。存储和发给模型走另一条路（`session.append` 才能改落盘内容，本插件没用它），所以：

- transcript `.jsonl` 里搜不到译文（实测：屏幕出现过的译文句子 0 次，原文英文能搜到）
- 下一轮发给模型的内容不含译文，不占上下文 token
- 模型翻译走的 `$.model.complete` 是独立无历史补全，同样不进会话

## 实现备注

- hooks module 只能 import 相对路径和 `"claude-code"`，无外部依赖（有道版的 md5/openssl 已随有道一起删除）
- 微软路径的 `parseBody` 兼容宿主把 JSON 响应预解析成对象塞进 `text` 的情况（类型声明说是 string，别信）
- **本地地址必须走 curl**：宿主的 `$.http.fetch` 连 `127.0.0.1` 会被 reset（SSRF 防护），`openai` provider 改用 `$.process.run` + curl 直连
- OpenAI 兼容输出会剥 `<think>...</think>`（推理模型空标签）
- 配置由 `register(on, options)` 的第二参传入，`plugin.json` 的 `userConfig` 声明

## 实测记录（expect 驱动真实 TUI）

- 微软 + 默认隐藏：`Ctrl+Y` 展开后 11~28 行 `▎` 译文 ✓
- `provider=model`（haiku）+ `show_by_default=true`：不按键直接显示 11 行，译文质量明显更好 ✓
- `provider=openai`（本地 llama.cpp / index-translate-2b）：逐段翻译 ~46s，代码路径保留干净，无 `<think>` 残留 ✓
- 防抖调度：渲染 → 1.5s → schedule → done → 显示 ✓
- 中文回复块正确跳过 ✓；`claude plugin validate` 通过 ✓

## 历史：有道版为什么删了

第一版带过有道网页接口（免 key），为绕沙箱限制走了 curl + openssl 子进程；后按需求移除。实现要点留在 git 历史里：宿主 `$.http.fetch` 发出的请求会被有道回空载荷、AES key 必须对 `TextEncoder` 编码后的字节取 md5（直接传字符串会按 UTF-16 码元 spread，算出来是错的）。

## 卸载

- 从 `~/.claude/settings.json` 的 `env.CLAUDE_CODE_PLUGIN_DIRS` 删掉本目录路径
- 从 `~/.claude/keybindings.json` 删掉 `ctrl+y` 一行
- 删掉 `pluginConfigs` 里的 `parrot-translate@inline`（如有）
