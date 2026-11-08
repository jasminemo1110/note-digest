# Note Digest 项目约定

## 定位与边界
- 独立 Obsidian 桌面插件，只处理用户主动选择的 Markdown 内容；不依赖 X Digest 或 YouTube Digest 运行时。
- V1 英文 → 简体中文；语言策略保留日语扩展点，V2 再实现日语规则，不提前暴露未完成选项。
- 阅读和 AI 结果默认临时显示。只有明确点击插入、收藏或生成笔记才允许持久写入。
- 不扫描全库发送 AI；只发送当前操作所需的选区和有界上下文。
- API Key 通过 Obsidian SecretStorage 获取，data.json 仅存密钥名称；禁止日志、源码、测试夹具和导出包含真实密钥。
- AI 输出不可信：结构与长度校验，界面用 textContent，写 Markdown 时转义。

## 架构
- src/main.ts：Obsidian 生命周期、命令和选区捕获。
- src/view.ts：右侧学习栏与操作状态。
- src/core.ts：纯数据契约、原文定位、校验与安全插入。
- src/provider.ts：AI 请求与语言策略，不操作笔记。
- src/settings.ts：非敏感设置与 SecretStorage 选择界面。
- 后续存储模块负责收藏、去重、目标笔记写入；视图不得自行覆盖文件。

## 数据保护
- 请求绑定来源文件、内容快照和选区；原文变更后不得应用旧结果。
- 插入必须唯一、可确认地定位；重复文本无法确定位置时拒绝写入。
- 收藏保留当时的原句和语境；不随原文改动而静默更新。
- 不自动合并不同语境或覆盖用户修改过的学习记录。
- 双目标保存需逐目标去重、报告部分失败，重试不得重复追加。

## 开发与验证
- npm test：行为测试；npm run build：类型检查与插件构建。
- 自动测试不等于 Obsidian 验证；发布前使用 examples/test-vault 完成 docs/TESTING.md。
- 使用 main 维护已验证增量；不确定或大范围实验使用 codex/ 分支。
- 每个完整逻辑变更验证后及时提交，中文 message 写原因，精确 git add；不自行 push 或发布。
- 功能范围、进度和待办只在 docs/PRODUCT.md 与 docs/ROADMAP.md 维护。
