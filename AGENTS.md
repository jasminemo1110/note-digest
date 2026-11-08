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
- src/collection.ts：版本化收藏数据、同语境去重、串行事务、逐目标幂等追加；视图不得自行覆盖文件。
- src/vault-storage.ts：Vault.process、独占创建、未同步编辑保护。
- src/anchors.ts：排除生成学习区、段落锚点及阅读选区定位。
- src/reading-layout.ts：长选区判断、本地段落范围、结果展示规则。
- src/reading-actions.ts：展示用精简语境和阅读快捷键保护；不改变 AI 分析上下文。
- src/highlights.ts：原文范围核对和 DOM 高亮；不修改源 Markdown。
- 设置与收藏共用 CollectionStore 持久化队列，禁止 saveData 只写设置而覆盖收藏。

## 数据保护
- 请求绑定来源文件、内容快照和选区；手工或未知原文变更后不得应用旧结果。插件自身译文插入可凭原子写入回执刷新当前选区快照，保持英文和 AI 分析语境不变；跨选区内部插入导致英文不再连续时不重定位。
- 插入必须唯一、可确认地定位；重复文本无法确定位置时拒绝写入。
- 收藏保留当时的原句和语境；不随原文改动而静默更新。
- 不自动合并不同语境或覆盖用户修改过的学习记录。
- 仅在用户点击“取消高亮并删除笔记”时删除对应记录卡片；不得全文匹配单词删除。新卡片使用起止标记，旧卡片只删除可精确匹配的生成文本；不删除原文、相邻记录或整个笔记文件。
- 删除先持久化取消状态和待重试意图，再逐目标删除；已取消但留有笔记或删除未完成的条目必须保留操作入口。
- 双目标保存需逐目标去重、报告部分失败，重试不得重复追加。

## 开发与验证
- npm test：行为测试；npm run build：类型检查与插件构建。
- 自动测试不等于 Obsidian 验证；发布前使用 examples/test-vault 完成 docs/TESTING.md。
- 使用 main 维护已验证增量；不确定或大范围实验使用 codex/ 分支。
- 每个完整逻辑变更验证后及时提交，中文 message 写原因，精确 git add；不自行 push 或发布。
- 功能范围、进度和待办只在 docs/PRODUCT.md 与 docs/ROADMAP.md 维护。
