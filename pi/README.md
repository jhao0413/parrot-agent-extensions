# pi 版（计划中）

用 pi 的扩展 API 实现与 [claude/parrot-grammar](../claude/parrot-grammar) 同等的体验：

- `ctx.ui.getEditorText()` / `setEditorText()` 就地读写输入框草稿（Claude 版要用 mods API 绕，pi 直接给了）
- `pi.registerCommand('grammar', ...)` 注册 `/grammar` 命令
- `ctx.ui.custom()` 或 editor dialog 展示问题列表 + 一键替换
- 提示词与 JSON 协议（`{ok, corrected, issues, terms}`）与 Claude 版共用一份拷贝

安装方式：软链或复制 `.ts` 到 `~/.pi/agent/extensions/`，或 `pi --extension <路径>` 单次加载。

类型：`package.json` 的 devDependencies 装 `@earendil-works/pi-coding-agent`（见 pi 文档）。
