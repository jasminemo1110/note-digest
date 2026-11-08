# 架构决定

## 独立运行

原生 Obsidian ItemView 作为右侧学习栏；Plugin 管理事件和命令。TypeScript + esbuild，外部依赖 obsidian 由宿主提供。纯数据逻辑独立于宿主，使用 Node 测试。

## 选区事务

选区快照包含路径、完整原文、文本、起止偏移和必要上下文。编辑模式使用编辑器位置；阅读模式仅接受源 Markdown 中可唯一匹配的文本。无法确认的富文本选区应提示改用编辑模式，不猜测来源。

请求以世代编号隔离，后发操作使旧响应失效；写入前再次比较来源内容。首增量整篇快照保护，后续按段落指纹改进。通过 Vault.process 同步变换，AI 请求必须在事务外完成。重复插入被快照检查阻止。

## 结果和网络

provider 仅请求和返回结构化值，限制响应字段长度。DOM 使用纯文本；写入 Markdown 转义特殊字符。源文本明确作为不可信引用数据传入提示词。固定 HTTPS provider endpoint，避免任意 endpoint 收集密钥。网络失败提示不泄露响应体、选区或密钥。

## 存储演进

第一增量临时结果仅驻内存，设置仅存 SecretStorage 名称；收藏随后采用版本化模型，以文档稳定 ID + 语境 + 选中形式去重，目标文档使用记录标识做幂等追加。不得让 AI 生成身份标识。

## 官方参考

- https://docs.obsidian.md/Plugins/Vault
- https://docs.obsidian.md/Plugins/Editor/Editor
- https://docs.obsidian.md/plugins/guides/secret-storage
- https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/User%20interface/Views.md

最低宿主版本以 SecretStorage 可用版本及实际验证为准；初始设为 1.11.5。真实运行验证前不能宣称兼容已确认。

DeepSeek 请求依据当前官方接口使用 deepseek-flash 非思考模式，JSON Output；参考 https://api-docs.deepseek.com/api/create-chat-completion/ 。模型质量仍需真实验证。

## 0.2.0 收藏与高亮

CollectionStore 通过串行队列统一保存 SecretStorage 名称、来源 registry 与收藏。schema version 1；只迁移旧版 secretName，未知/损坏格式停止加载，不清空旧数据。随机来源 ID 保存在插件 data.json，不往原文注入身份字段。独立笔记固定路径随运行期间的 rename 事件更新。

记录身份由来源 ID、类型、段落原文、段内选区位置及文字决定；原句、必要上下文、完整解释保留当时快照。跨语境不合并。先持久保存记录身份，再逐目标追加；每份 Markdown 带记录 ID 标记，使崩溃或部分失败后重试不重复。每个成功目标再保存回执；全部目标失败不高亮。重复记录不覆盖卡片或手工备注。

原文学习区由独立边界注释标识，排除在选区、语境和定位之外。正文比较忽略本插件追加的学习区，使保存到原文后可以继续补存到独立笔记。目标文档通过 Vault.process 写入，未保存编辑、同名非插件笔记均阻止覆盖。取消收藏只取消活动状态和高亮，保留磁盘内容。

高亮通过 Markdown post processor + MarkdownRenderChild 生命周期注入 mark；以当前原文段落锚点、渲染 section 行范围及可见段落文字三重核对，不对全篇同词替换。渲染选区使用 section 与段内位置，允许不同段落有同一个词；无法确认时回退唯一文本匹配或提示编辑模式。复杂 Markdown 暂跳过。原段落被修改时停止高亮，保存快照仍可阅读。

来源改名更新 registry 和定位入口，不强行改写用户学习笔记中的历史文本；Markdown 来源链接是否随宿主设置自动更新仍需真实验证。关闭插件期间的离线移动需要后续恢复机制。

## 0.2.2 展示模式和分组

侧栏区分 idle/translate/explain/summarize；长选区 capture 仅打开 idle，不发 AI 请求。翻译按本地段落范围顺序请求，逐次检查世代；原文身份和英文字段从本地生成，不接受模型重建。摘要是独立 summary 字段，不能通过翻译收藏校验。自然表达的 assessment 仍参与结构校验和旧格式识别，但不展示、不导出其判断模块。

学习区使用 word/quote 两组边界标记，卡片四级标题处于三级分类标题之下。新条目写到所属组末尾，不重写已有卡片；分组标记损坏则拒绝写入。显式整理同时支持最初冗余版与 0.2.1 紧凑版卡片，只有完整匹配才移动和重新生成，其余文本原样保留。

## 0.2.3 卡片删除事务

CollectionStore 的 removeNotes 复用串行队列。先持久化 active=false 与 deletionPending=true，再逐目标经 Vault.process 删除，逐次更新 savedTo；全部完成才清除待删除状态。高亮只读取活动记录；侧栏额外展示留有笔记或删除待重试记录。文件写入成功但状态保存失败可通过已缺失的记录标记幂等恢复。

新卡片含 record / record-end 标记；删除检查唯一且非嵌套的边界，并验证所属学习区域。无结束标记的历史卡片按各历史 formatter 完整匹配，无法确认时拒绝自动删除。保留收藏快照以便重试及重新收藏，不删除整个 Markdown 文件，也不删除相邻分组。
