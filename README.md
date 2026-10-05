# parrot-agents

给编码 agent（Claude Code / pi，将来更多）的「中文母语者语言辅助」插件集：写英文 prompt 时查语法、看英文回复时按需出中文。与 [parrot](../parrot) 浏览器扩展同一主题，代码独立。

## 插件

| 插件 | 平台 | 作用 | 快捷键 |
|---|---|---|---|
| [claude/parrot-grammar](./claude/parrot-grammar) | Claude Code | 检查输入框英文语法，给出更自然的写法，一键替换回输入框 | `Ctrl+G` |
| [claude/parrot-translate](./claude/parrot-translate) | Claude Code | 回复后台自动翻成中文（逐段穿插），按键切换显示 | `Ctrl+Y` |
| pi/（计划中） | pi | pi 版语法检查，`ctx.ui.getEditorText()/setEditorText()` 就地读写输入框 | — |

各插件的安装、配置、实现细节见各自 README。

## 安装

**方式一：按路径加载（开发用）** —— 写进 `~/.claude/settings.json`：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/jhao/Projects/parrot-agents/claude/parrot-grammar:/Users/jhao/Projects/parrot-agents/claude/parrot-translate"
  }
}
```

**方式二：从本仓库当 marketplace 装**（推到 GitHub 后任何人可用）：

```bash
claude plugin marketplace add jhao/parrot-agents
claude plugin install parrot-grammar@parrot-agents
claude plugin install parrot-translate@parrot-agents
```

两个插件都需要 Claude Code v2.1.287+（mods API）。

## 开发

```bash
claude plugin validate --strict ./claude/parrot-grammar    # 发布前过一遍
claude plugin validate --strict ./claude/parrot-translate
```

改代码后 `/reload-plugins` 热加载。诊断日志：translate 写 `/tmp/pt-live.log`。

## 设计说明

- **不污染上下文**：语法检查用 `$.model.complete`（无历史独立补全）；译文只改渲染层（`ui.render`），不落盘、不进后续请求
- **凭据**：grammar 走会话自己的模型凭证；translate 默认微软免费接口，可配本地 OpenAI 兼容模型（llama.cpp 等）
- 各端实现独立、共用提示词与 JSON 协议（`{ok, corrected, issues, terms}`）
