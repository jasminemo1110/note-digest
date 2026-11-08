import { ItemView, WorkspaceLeaf } from 'obsidian';
import type NoteDigestPlugin from './main';
import type { Kind, SaveTarget } from './collection';
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
    if (!selection) { el.createEl('p', { text: '在文章中选中英文，点击 Digest，或执行“Digest 选中内容”命令。' }); const path = this.app.workspace.getActiveFile()?.path; if (path) this.renderCollection(path); return; }
    el.createEl('p', { text: selection.path, cls: 'note-digest-muted' });
    el.createEl('blockquote', { text: selection.text });
    const actions = el.createDiv({ cls: 'note-digest-actions' });
    for (const [label, action] of [['翻译', 'translate'], ['语境解释', 'explain']] as const) {
      const button = actions.createEl('button', { text: label });
      button.onclick = () => { void this.plugin.run(selection, action); };
    }
    if (status) el.createEl('p', { text: status, attr: { role: 'status', 'aria-live': 'polite' } });
    if (!result) { this.renderCollection(selection.path); return; }
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
    el.createEl('h3', { text: '收藏到学习笔记' });
    const label = el.createEl('label', { text: '保存位置 ' });
    const select = label.createEl('select', { attr: { 'aria-label': '收藏保存位置' } });
    for (const [value, text] of [['source', '原文末尾'], ['note', '独立学习笔记'], ['both', '两者都保存']]) select.createEl('option', { value, text });
    const saveStatus = el.createEl('p', { cls: 'note-digest-result', attr: { role: 'status', 'aria-live': 'polite' } });
    const saves = el.createDiv({ cls: 'note-digest-actions' });
    const buttons: HTMLButtonElement[] = [];
    for (const [kind, text] of [['word', '收藏完整词语解释'], ['quote', '收藏金句与译文']] as const) {
      if (kind === 'word' && !result.assessment) continue;
      const button = saves.createEl('button', { text }); buttons.push(button);
      button.onclick = async () => {
        buttons.forEach(button => button.disabled = true); saveStatus.textContent = '正在保存…';
        try { saveStatus.textContent = await this.plugin.collect(selection, result, kind as Kind, select.value as SaveTarget); }
        catch (error) { saveStatus.textContent = error instanceof Error ? error.message : '收藏失败，请重试。'; }
        finally { buttons.forEach(button => button.disabled = false); if (saveStatus.isConnected) this.renderCollection(selection.path); }
      };
    }
    if (!result.assessment) el.createEl('p', { text: '先点击“语境解释”，再收藏完整词语卡片。', cls: 'note-digest-muted' });
    el.createEl('p', { text: '以下操作会修改原文。下方插入放在选区所在段落的行末之后。', cls: 'note-digest-muted' });
    const writes = el.createDiv({ cls: 'note-digest-actions' });
    for (const [label, mode] of [['添加到原文下方', 'below'], ['添加到句后括号', 'inline']] as const) {
      const button = writes.createEl('button', { text: label });
      button.onclick = () => { void this.plugin.insert(selection, result.translation, mode); };
    }
    this.renderCollection(selection.path);
  }
  private renderCollection(path: string): void {
    this.contentEl.querySelector('.note-digest-collection')?.remove();
    const records = this.plugin.collection.recordsFor(path);
    if (!records.length) return;
    const list = this.contentEl.createDiv({ cls: 'note-digest-collection' });
    list.createEl('h3', { text: `本文收藏（${records.length}）` });
    const notePath = this.plugin.collection.notePathFor(path);
    if (notePath && this.app.vault.getAbstractFileByPath(notePath)) {
      const open = list.createEl('button', { text: '打开独立学习笔记' });
      open.onclick = () => { void this.app.workspace.openLinkText(notePath, '', false); };
    }
    for (const record of records) {
      const row = list.createDiv({cls: 'note-digest-saved-row'});
      row.createEl('p', { text: `${record.kind === 'word' ? '词语' : '金句'}：${record.anchor.text}` });
      const locate = row.createEl('button', { text: '定位原文' });
      locate.onclick = () => { void this.plugin.revealRecord(path, record.id); };
      const remove = row.createEl('button', { text: '取消收藏高亮' });
      remove.onclick = async () => {
        remove.disabled = true;
        try { await this.plugin.removeHighlight(record.id); this.renderCollection(path); }
        catch { remove.disabled = false; remove.textContent = '取消失败，点击重试'; }
      };
    }
  }
}
