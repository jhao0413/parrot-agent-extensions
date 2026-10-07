# parrot-translate (pi)

[claude/parrot-translate](../claude/parrot-translate) 的 pi 移植：回复、工具调用前的说明和展开的思考内容在后台翻成你配置的语言，快捷键切换显示，译文跟在对应的原文段落后面；你输入的提示词在发出前会被改写成英文（外文翻译、英文只修语法），发出后保留原文与英文的对照。

译文和对照只在渲染层显示，会话存储与模型上下文保存实际发送的文本。翻译失败时保留原文，并提示失败原因所在的日志。已经是目标语言的内容不重复插入译文。

## 安装

```bash
# 在仓库根目录执行
mkdir -p ~/.pi/agent/extensions

# 方式一：软链（改仓库代码后 /reload 生效）
ln -s "$(pwd)/pi/parrot-translate.ts" ~/.pi/agent/extensions/parrot-translate.ts

# 方式二：复制
cp pi/parrot-translate.ts ~/.pi/agent/extensions/

# 方式三：单次加载
pi --extension ./pi/parrot-translate.ts
```

改动配置或代码后 `/reload` 生效。

## 配置

`~/.pi/agent/parrot-translate.json`（设置了 `PI_CODING_AGENT_DIR` 时改从该目录读取；不存在则使用默认值）：

```json
{
  "show_by_default": true,
  "outbound": true,
  "lang": "zh-Hans",
  "provider": "microsoft",
  "model": "haiku",
  "base_url": "http://127.0.0.1:8021/v1",
  "api_key": "",
  "toggle_key": "ctrl+y"
}
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `show_by_default` | `true` | 译文随回复直接显示；关掉则快捷键展开 |
| `outbound` | `true` | 出站链路总开关 |
| `lang` | `zh-Hans` | 你的语言，微软语言码：`zh-Hant`、`ja`、`ko`、`fr`、`de`、`es`、`ru` 等 |
| `provider` | `microsoft` | 翻译服务，见下 |
| `model` | `haiku` | `session` / `openai` 用的模型；填别名 haiku / sonnet / deepseek-chat、完整 id 或 `provider/id` |
| `base_url` | `http://127.0.0.1:8021/v1` | `openai` 的接口地址 |
| `api_key` | 空 | `openai` 用；本地 llama.cpp 随便填，不校验 |
| `toggle_key` | `ctrl+y` | 切换显示的快捷键；留空 `""` 则只留 `/translate` 命令 |

provider 三选一：

- `microsoft`：Edge 免费接口，免 key、快，只会翻译（英文输入没有语法检查，原样放行）
- `session`：`ctx.modelRegistry.complete` 走本会话凭证跑一次独立补全，免配置、质量更好、耗 token。旧值 `model` 仍被接受
- `openai`：OpenAI 兼容端点，本地 llama.cpp 或远端服务（输出带 `<think>` 会剥掉）

## 使用

- 发消息：外文提示词自动转成英文再进会话；屏幕上用户行是「原文在上、实际发出的英文引用在下」
- 改写结果会拒绝源语言润色、未翻译的中日韩/其他非拉丁文字和元评论；混合输入也会校验，代码与引用中的外文允许保留。可能是英文且不含非拉丁正文的输入按完整词数检查改写幅度，混合语言翻译和其他拉丁语言不套英文词重合规则。外文首轮用明确的英文翻译指令，失败后再重试一次；仍失败则保留该段原文并提示查看日志
- `Ctrl+Y` 或 `/translate`：切换回复和思考译文显示；再次展开会重试失败的段落。已跳过的技术内容或目标语言文本不会提示「译文就绪」
- 完成的中间文本和思考块立即开始翻译，随后落定的消息会去重；回复侧最多并发 4 个请求。Mermaid 图表继续由 Pi 渲染，图表外的译文仍能显示
- 粘贴的错误信息、堆栈、JSON、日志、diff 自动跳过不翻（两侧都适用）；俄文、阿拉伯文等 Unicode 正文正常翻译。反引号或 `~~~` 围栏（包括更长、未闭合的围栏）和缩进代码块不送翻；列表、引用中的代码同样保护，列表续段按容器内的相对缩进识别为正文

## 与 Claude 版的差异

- 挂点映射：出站 `prompt.submit` → `input` 事件（只拦 `source === "interactive"` 的本机提交）；回复 `ui.render` → 完成文本/思考块的 `message_update` + `message_end` + `registerMarkdownTransformer`
- 回复侧不需要 1.5s 防抖：文本块结束即可开始翻译，工具调用前的说明和最终回复都处理
- pi 没有插件配置面板，配置走扩展自管的 JSON 文件
- `openai` 走进程内 `fetch` 直连，不需要 curl 绕 SSRR 防护（那是 Claude 宿主的限制）
- 翻译完成后用 `setHiddenThinkingLabel` 触发 transcript 重绘（重建 assistant 组件让 transformer 重跑）；副作用是把自定义的隐藏思考标签重置为默认值
- `Ctrl+Y` 在 pi 默认绑给 `tui.editor.yank`（粘贴删除的文本），扩展快捷键会压过它（启动时有冲突提示）；需要 yank 的换 `toggle_key` 或留空
- 切换会话或通过 `/tree` 切换分支，会清除出站对照并取消旧会话/分支的翻译任务和尚未提交的提示词改写；同一进程内已完成的段落译文可以复用。恢复会话、`/reload` 或切换分支时，会为当前分支的历史回复补翻，并重新检查已有英文用户消息，避免误贴原文
- Pi 的 markdown transformer 只提供文本，没有消息 ID。不同原文译成同一句英文，或与已有英文消息重合时，该文本的对照会回落为英文，避免给历史消息贴错原文

## 诊断

日志在 `/tmp/parrot-pi.log`，保留最近 60 条：加载配置、出站改写、翻译调度与结果、切换显示。排查看它。

## 开发

```bash
cd pi
npm install       # 装 devDependencies（pi 宿主类型 + tsc）
npm run check     # 类型检查
npm test          # Pi/Claude 共享行为用例 + Pi 渲染、事件与会话生命周期回归
```

扩展运行时由 pi 通过 jiti 加载，`@earendil-works/pi-coding-agent` 等宿主包由 pi 提供（peerDependencies 声明，不要打进 dependencies）。
