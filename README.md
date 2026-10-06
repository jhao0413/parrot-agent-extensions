# parrot-agent-extensions

给编码 agent 用的语言辅助扩展，Claude Code 和 pi 各一份实现，与 [parrot](../parrot) 浏览器扩展同主题，代码独立。目前只有 parrot-translate 在维护：发出的 prompt 保证是地道英文，回复按需译回配置的语言。

## 里面的东西

- [claude/parrot-translate](./claude/parrot-translate)：Claude Code 插件。提交时把 prompt 改写成地道英文，用户行双语对照；回复在后台译成 `lang` 配置的语言，`Ctrl+Y` 切换显示
- [claude/parrot-grammar](./claude/parrot-grammar)：已退役，功能并进了 translate 的出站链路，代码留作参考
- [pi/](./pi)：计划中的 pi 版，见其 README

安装、配置、实现细节见各自 README。

## 安装（parrot-translate）

```bash
claude plugin marketplace add jhao/parrot-agent-extensions
claude plugin install parrot-translate@parrot-agent-extensions
```

需要 Claude Code v2.1.287+（mods API）。

## 设计

- 对话上下文里只有英文：出站改写走 `prompt.submit`，进会话前替换；回复译文只改渲染层；模型翻译走 `$.model.complete`，无历史独立补全
- 凭据默认走微软免费接口，也可以配会话凭证模型（`session`）或 OpenAI 兼容端点（本地 llama.cpp 等）
- 目标语言由 `lang` 配置，没有写死的语言
