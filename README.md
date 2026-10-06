# parrot-agent-extensions

面向 code agent 的语言辅助扩展，分别为 Claude Code 和 pi 提供实现。目前在维护的只有 parrot-translate：发出的 prompt 保证为地道英文，回复按需译回配置的语言。

![parrot-translate 效果](docs/screenshot.png)

## 组成

- [claude/parrot-translate](./claude/parrot-translate)：Claude Code 插件。提交时将 prompt 改写为地道英文，用户消息行双语对照；回复在后台译成 `lang` 配置的语言，`Ctrl+Y` 切换显示
- [pi/](./pi)：计划中的 pi 实现，详见其 README

安装、配置与实现细节见各插件的 README。

## 安装（parrot-translate）

```bash
claude plugin marketplace add jhao0413/parrot-agent-extensions
claude plugin install parrot-translate@parrot-agent-extensions
```

需要 Claude Code v2.1.287+（mods API）。

## 设计

- 对话上下文里只有英文：出站改写走 `prompt.submit`，进会话前替换；回复译文只改渲染层；模型翻译走 `$.model.complete`，无历史独立补全
- 凭据默认走微软免费接口，也可以配会话凭证模型（`session`）或 OpenAI 兼容端点（本地 llama.cpp 等）
- 目标语言不写死，由 `lang` 配置决定
- 粘贴的错误信息、堆栈、JSON、日志、diff 自动跳过不翻；``` 围栏在结构层就不送翻

## 致谢

感谢 [Linux.do 社区](https://linux.do) 的支持与帮助。
