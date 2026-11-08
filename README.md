# Note Digest

在 Obsidian 原文旁读懂英文，留下语境中的词语和金句。

独立的 Obsidian 桌面插件，V1 面向 Markdown 英文文章，以中文提供翻译与语境解释。当前处于开发阶段，功能状态见[路线图](docs/ROADMAP.md)。

## 当前开发版

已实现：右侧学习栏、阅读/编辑模式选区命令、选区 Digest 按钮、英文翻译及语境解释、普通段落译文插入、SecretStorage 设置和过期结果保护。0.1.0 已由用户在真实 Obsidian 中验证选词、翻译、语境解释与插入流程。0.1.1 补充音标、表达判断和建议改法，通过 16 项自动测试与构建，新增内容的模型质量待验证。

尚未实现：收藏、汇总笔记、原文高亮、长文摘要、按节/全文翻译和原位双语阅读层。下列为 V1 目标，不是当前已支持清单。

## 目标体验

- 选中英文，点击 Digest 或使用命令，在右侧学习栏查看翻译与解释。
- 翻译默认只用于当前阅读；可主动插到原文下方或句后括号中。
- 收藏词语和金句到原文末尾、独立学习笔记，或同时保存；已收藏内容在原文高亮。
- 长文可先 Summarize，再按摘要小节翻译；也可直接翻译本节或全文。
- Digest 文件夹可保存每篇文章的词语、金句及完整双语笔记。

## 开发

需要 Node.js 20+。

```sh
npm ci
npm test
npm run build
```

构建产物为 `main.js`。将 `main.js`、`manifest.json`、`styles.css` 复制到测试仓库的 `.obsidian/plugins/note-digest/`，在 Obsidian 中启用社区插件。先用示例仓库测试，不要直接安装到重要笔记仓库。

启用后在设置中选择密钥；选中英文点击 Digest，或从命令面板执行 Note Digest: Digest 选中内容。可在 Obsidian 快捷键设置中给该命令分配快捷键。右侧“语境解释”会另发请求；写入按钮明确修改原文。当前仅支持普通单行段落写入，复杂 Markdown 请先在侧栏阅读。

最低 Obsidian 版本见 manifest；使用系统 SecretStorage 选择 DeepSeek 密钥，插件只保存密钥名称。只有主动请求时才发送所选文本和必要上下文。

## 文档

- [产品方案](docs/PRODUCT.md)
- [开发路线图](docs/ROADMAP.md)
- [验证流程](docs/TESTING.md)
- [架构决定](docs/ARCHITECTURE.md)
- [来源说明](THIRD_PARTY_NOTICES.md)

项目由 X Digest 的学习体验延伸而来，YouTube Digest 是相关产品探索的起点。当前实现独立编写，公开发布时进一步整理项目关联及致谢；如引入上游代码，须同时保留对应许可。
