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
