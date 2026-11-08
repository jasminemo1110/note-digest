import { ItemView, WorkspaceLeaf } from 'obsidian';
import type NoteDigestPlugin from './main';
import { ASSESSMENT_LABELS, type DigestResult, type SelectionSnapshot } from './core';
export const VIEW_TYPE = 'note-digest-learning';
export class DigestView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: NoteDigestPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Note Digest'; }
  getIcon(): string { return 'book-open-text'; }
  async onOpen(): Promise<void> { this.render(); }
  render(selection?: SelectionSnapshot, result?: DigestResult, status = ''): void {
    const el = this.contentEl; el.empty(); el.addClass('note-digest-panel');
    el.createEl('h2', { text: 'Note Digest' });
    el.createEl('p', { text: '英文 → 中文 · 结果默认仅临时显示', cls: 'note-digest-muted' });
    if (!selection) { el.createEl('p', { text: '在文章中选中英文，点击 Digest，或执行“Digest 选中内容”命令。' }); return; }
    el.createEl('p', { text: selection.path, cls: 'note-digest-muted' });
    el.createEl('blockquote', { text: selection.text });
    const actions = el.createDiv({ cls: 'note-digest-actions' });
    for (const [label, action] of [['翻译', 'translate'], ['语境解释', 'explain']] as const) {
      const button = actions.createEl('button', { text: label });
      button.onclick = () => { void this.plugin.run(selection, action); };
    }
    if (status) el.createEl('p', { text: status, attr: { role: 'status', 'aria-live': 'polite' } });
    if (!result) return;
    if (result.assessment) {
      el.createEl('h3', { text: '音标' });
      el.createEl('p', { text: result.pronunciation ?? '不适用或无法可靠确定', cls: 'note-digest-result' });
      el.createEl('h3', { text: '表达判断 · ' + ASSESSMENT_LABELS[result.assessment.status] });
      el.createEl('p', { text: result.assessment.explanation, cls: 'note-digest-result' });
      if (result.assessment.correction) {
        el.createEl('h3', { text: result.assessment.status === 'informal' ? '更正式的表达（可选）' : '建议改法' });
        el.createEl('p', { text: result.assessment.correction, cls: 'note-digest-result' });
      }
      el.createEl('p', { text: '以上为 AI 结合当前语境的判断；建议改法不会自动修改原文。', cls: 'note-digest-muted' });
    }
    for (const [key, label] of [['translation', '中文翻译'], ['meaning', '语境含义'], ['usage', '用法'], ['example', '例句']] as const) {
      if (result[key]) { el.createEl('h3', { text: label }); el.createEl('p', { text: result[key], cls: 'note-digest-result' }); }
    }
    el.createEl('p', { text: '以下操作会修改原文。下方插入放在选区所在段落的行末之后。', cls: 'note-digest-muted' });
    const writes = el.createDiv({ cls: 'note-digest-actions' });
    for (const [label, mode] of [['添加到原文下方', 'below'], ['添加到句后括号', 'inline']] as const) {
      const button = writes.createEl('button', { text: label });
      button.onclick = () => { void this.plugin.insert(selection, result.translation, mode); };
    }
  }
}
