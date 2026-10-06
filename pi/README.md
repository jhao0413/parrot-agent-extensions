# pi 版（计划中）

用 pi 的扩展 API 实现与 [claude/parrot-translate](../claude/parrot-translate) 同等的体验（出站保证英文、回复按需翻译；其手动检查前身 parrot-grammar 已退役）：

- `ctx.ui.getEditorText()` / `setEditorText()` 就地读写输入框草稿（Claude 版要用 mods API 绕，pi 直接给了）
- 出站改写对应 Claude 版的 `prompt.submit` 挂点（pi 侧具体事件待查）
- `pi.registerCommand('translate', ...)` 注册 `/translate` 命令
- `ctx.ui.custom()` 或 editor dialog 展示双语对照

安装方式：软链或复制 `.ts` 到 `~/.pi/agent/extensions/`，或 `pi --extension <路径>` 单次加载。

类型：`package.json` 的 devDependencies 装 `@earendil-works/pi-coding-agent`（见 pi 文档）。
