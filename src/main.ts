import { MarkdownView, Notice, Plugin, TFile, requestUrl } from 'obsidian';
import { snapshot, insertTranslation, type SelectionSnapshot, type Action } from './core';
import { digest } from './provider';
import { DigestSettings } from './settings';
import { DigestView, VIEW_TYPE } from './view';

export default class NoteDigestPlugin extends Plugin {
  secretName = '';
  private generation = 0;
  private selectionButton?: HTMLButtonElement;
  async onload(): Promise<void> {
    const data = await this.loadData();
    this.secretName = typeof data?.secretName === 'string' ? data.secretName : '';
    this.registerView(VIEW_TYPE, leaf => new DigestView(leaf, this));
    this.addSettingTab(new DigestSettings(this.app, this));
    this.addRibbonIcon('book-open-text', '打开 Note Digest', () => { void this.openPanel(); });
    this.addCommand({ id: 'open-learning-panel', name: '打开学习侧栏', callback: () => { void this.openPanel(); } });
    this.addCommand({ id: 'digest-selection', name: 'Digest 选中内容', callback: () => { void this.capture(); } });
    this.registerDomEvent(document, 'mouseup', event => {
      if (this.selectionButton?.contains(event.target as Node)) return;
      this.removeSelectionButton();
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const selection = window.getSelection();
      if (!view || !selection?.toString().trim() || !selection.anchorNode || !selection.focusNode ||
          !view.contentEl.contains(selection.anchorNode) || !view.contentEl.contains(selection.focusNode)) return;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const button = document.body.createEl('button', { text: 'Digest', cls: 'note-digest-selection' });
      button.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 100)) + 'px';
      button.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 45)) + 'px';
      button.onmousedown = e => e.preventDefault();
      button.onclick = () => { void this.capture(); this.removeSelectionButton(); };
      this.selectionButton = button;
    });
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => { this.removeSelectionButton(); }));
  }
  onunload(): void { this.generation++; this.removeSelectionButton(); }
  private removeSelectionButton(): void { this.selectionButton?.remove(); this.selectionButton = undefined; }
  async openPanel(): Promise<DigestView> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) throw new Error('无法打开右侧栏。');
    if (!(leaf.view instanceof DigestView)) await leaf.setViewState({ type: VIEW_TYPE, active: false });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view as DigestView;
  }
  private async capture(): Promise<void> {
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file) throw new Error('请先打开 Markdown 文章并选中英文。');
      const path = view.file.path;
      let selected: SelectionSnapshot;
      if (view.getMode() === 'source') {
        selected = snapshot(path, view.editor.getValue(), view.editor.getSelection(), view.editor.posToOffset(view.editor.getCursor('from')));
      } else {
        const range = window.getSelection();
        if (!range?.anchorNode || !range.focusNode || !view.contentEl.contains(range.anchorNode) || !view.contentEl.contains(range.focusNode)) throw new Error('请在原文中选择英文。');
        const text = range.toString();
        selected = snapshot(path, await this.app.vault.read(view.file), text);
      }
      this.generation++;
      await this.run(selected, 'translate');
    } catch (error) { new Notice(error instanceof Error ? error.message : '无法读取选区。'); }
  }
  async run(selection: SelectionSnapshot, action: Action): Promise<void> {
    const generation = ++this.generation;
    const panel = await this.openPanel();
    if (generation !== this.generation) return;
    panel.render(selection, undefined, '正在请求…');
    try {
      const file = this.app.vault.getAbstractFileByPath(selection.path);
      if (!(file instanceof TFile) || await this.app.vault.read(file) !== selection.source) throw new Error('原文已修改，请重新选择。');
      if (generation !== this.generation) return;
      const key = this.secretName ? this.app.secretStorage.getSecret(this.secretName) : null;
      const result = await digest(selection, action, key ?? '', requestUrl);
      if (generation !== this.generation) return;
      if (await this.app.vault.read(file) !== selection.source) throw new Error('原文已修改，请重新选择。');
      if (generation !== this.generation) return;
      panel.render(selection, result);
    } catch (error) {
      if (generation === this.generation) panel.render(selection, undefined, error instanceof Error ? error.message : '请求失败。');
    }
  }
  async insert(selection: SelectionSnapshot, translation: string, mode: 'below' | 'inline'): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(selection.path);
      if (!(file instanceof TFile)) throw new Error('原文已移动或删除，请重新选择。');
      const openViews = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
        .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === selection.path && view.getMode() === 'source');
      if (openViews.some(view => view.editor.getValue() !== selection.source)) throw new Error('编辑器中的原文已改变，请重新选择。');
      await this.app.vault.process(file, current => insertTranslation(current, selection, translation, mode));
      new Notice('译文已添加到原文。');
    } catch (error) { new Notice(error instanceof Error ? error.message : '写入失败。'); }
  }
}
