import { App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type NoteDigestPlugin from './main';
export class DigestSettings extends PluginSettingTab {
  constructor(app: App, private plugin: NoteDigestPlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'Note Digest' });
    this.containerEl.createEl('p', { text: '英文 → 中文。只有主动点击翻译或解释才向 DeepSeek 发送选区及附近语境；默认不写入笔记。' });
    new Setting(this.containerEl).setName('DeepSeek API Key').setDesc('使用 Obsidian SecretStorage；插件只保存密钥名称。')
      .addComponent(el => new SecretComponent(this.app, el).setValue(this.plugin.secretName).onChange(async value => {
        await this.plugin.collection.setSecretName(value ?? '');
      }));
  }
}
