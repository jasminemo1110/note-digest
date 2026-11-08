import { MarkdownView, MarkdownRenderChild, Notice, Plugin, TFile, requestUrl } from 'obsidian';
import { snapshot, translationInsertion, type InsertionReceipt, type SelectionSnapshot, type Action } from './core';
import { digest, translateParagraphs } from './provider';
import { isLongSelection } from './reading-layout';
import { DigestSettings } from './settings';
import { DigestView, VIEW_TYPE } from './view';
import { CollectionStore, loadCollection, type Kind, type SaveTarget } from './collection';
import { vaultStorage } from './vault-storage';
import { applyHighlights, clearHighlights, highlightRanges } from './highlights';
import { locateAnchor, renderedSelectionOffset } from './anchors';
import type { DigestResult } from './core';
import { readingShortcut } from './reading-actions';

export default class NoteDigestPlugin extends Plugin {
  collection!: CollectionStore;
  get secretName(): string { return this.collection.secretName; }
  private generation = 0;
  private stopped = false;
  private quoteBusy = false;
  private renderedSections = new WeakMap<HTMLElement, {path: string; lineStart: number; lineEnd: number}>();
  private selectionButton?: HTMLButtonElement;
  async onload(): Promise<void> {
    this.stopped = false;
    const data = await this.loadData();
    this.collection = new CollectionStore(loadCollection(data), vaultStorage(this.app, value => this.saveData(value)));
    this.registerView(VIEW_TYPE, leaf => new DigestView(leaf, this));
    this.addSettingTab(new DigestSettings(this.app, this));
    this.addRibbonIcon('book-open-text', '打开 Note Digest', () => { void this.openPanel(); });
    this.addCommand({ id: 'open-learning-panel', name: '打开学习侧栏', callback: () => { void this.openPanel(); } });
    this.addCommand({ id: 'digest-selection', name: 'Digest 选中内容', callback: () => { void this.capture(); } });
    this.addCommand({ id: 'save-quote-selection', name: '收藏选中金句到末尾及独立笔记', callback: () => { void this.capture('quote'); } });
    this.registerDomEvent(document, 'keydown', event => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const selection = window.getSelection();
      const target = event.target instanceof Element ? event.target : null;
      const action = readingShortcut(event, {
        reading: view?.getMode() === 'preview',
        selectionInside: !!(view && selection?.toString().trim() && selection.anchorNode && selection.focusNode &&
          view.contentEl.contains(selection.anchorNode) && view.contentEl.contains(selection.focusNode)),
        editable: !!target?.closest('input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .modal-container') || !!document.querySelector('.modal-container'),
      });
      if (!action) return;
      event.preventDefault(); event.stopPropagation(); this.removeSelectionButton();
      void this.capture(action);
    });
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
    this.registerMarkdownPostProcessor(async (element, context) => {
      const section = context.getSectionInfo(element);
      if (section) this.renderedSections.set(element, {path: context.sourcePath, lineStart: section.lineStart, lineEnd: section.lineEnd});
      const records = this.collection.recordsFor(context.sourcePath);
      if (!records.length) return;
      const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!(file instanceof TFile)) return;
      const source = await this.app.vault.cachedRead(file);
      if (this.stopped) return;
      const info = context.getSectionInfo(element);
      if (!info) return;
      const child = new MarkdownRenderChild(element);
      child.register(() => clearHighlights(element)); context.addChild(child);
      const candidates = element.matches('p') ? [element] : Array.from(element.querySelectorAll('p'));
      for (const paragraph of candidates) {
        if (paragraph.closest('pre, code, .internal-embed')) continue;
        if (candidates.filter(other => other.textContent === paragraph.textContent).length !== 1) continue;
        applyHighlights(paragraph, highlightRanges(source, info.lineStart, info.lineEnd, paragraph.textContent ?? '', records));
      }
    });
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      void this.collection.rename(oldPath, file.path).then(() => this.refreshHighlights()).catch(() => new Notice('收藏来源路径更新失败，请重新加载后检查。'));
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      void this.collection.rename(file.path, null).then(() => this.refreshHighlights()).catch(() => new Notice('收藏来源状态更新失败。'));
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => { this.removeSelectionButton(); }));
  }
  onunload(): void {
    this.stopped = true; this.generation++; this.removeSelectionButton();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) if (leaf.view instanceof MarkdownView) clearHighlights(leaf.view.contentEl);
  }
  refreshHighlights(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.getMode() === 'preview') leaf.view.previewMode.rerender(true);
    }
  }
  async collect(selection: SelectionSnapshot, result: DigestResult, kind: Kind, target: SaveTarget): Promise<string> {
    const report = await this.collection.save(selection, result, kind, target);
    this.refreshHighlights();
    return report.targets.map(item => `${item.ok ? '✓' : '未完成'} ${item.path}：${item.message}`).join('\n');
  }
  async removeHighlight(id: string): Promise<void> {
    await this.collection.deactivate(id); this.refreshHighlights();
    new Notice('已取消收藏高亮；已写入的笔记保留，避免删除你的编辑。');
  }
  async removeNotes(id: string): Promise<string> {
    try {
      const report=await this.collection.removeNotes(id);
      return report.targets.map(target=>`${target.ok?'✓':'未完成'} ${target.path}：${target.message}`).join('\n');
    } finally { this.refreshHighlights(); }
  }
  async revealRecord(path: string, id: string): Promise<void> {
    const record = this.collection.recordsFor(path,true).find(record => record.id === id);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!record || !(file instanceof TFile)) { new Notice('原文不可用。'); return; }
    const source = await this.app.vault.read(file);
    const offset = locateAnchor(source, record.anchor);
    if (offset === null) { new Notice('原段落已变化或有重复，无法准确定位；收藏快照仍保留。'); return; }
    const line = source.slice(0, offset).split('\n').length - 1;
    await this.app.workspace.getLeaf(false).openFile(file, {eState: {line}});
  }
  private removeSelectionButton(): void { this.selectionButton?.remove(); this.selectionButton = undefined; }
  async openPanel(): Promise<DigestView> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) throw new Error('无法打开右侧栏。');
    if (!(leaf.view instanceof DigestView)) await leaf.setViewState({ type: VIEW_TYPE, active: false });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view as DigestView;
  }
  private async capture(action: 'digest' | 'quote' = 'digest'): Promise<void> {
    if (action === 'quote' && this.quoteBusy) return;
    if (action === 'quote') this.quoteBusy = true;
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file) throw new Error('请先打开 Markdown 文章并选中英文。');
      const path = view.file.path;
      if (this.collection.isLearningNote(path)) throw new Error('请从原文章选择内容。');
      let selected: SelectionSnapshot;
      if (view.getMode() === 'source') {
        selected = snapshot(path, view.editor.getValue(), view.editor.getSelection(), view.editor.posToOffset(view.editor.getCursor('from')));
      } else {
        const range = window.getSelection();
        if (!range?.anchorNode || !range.focusNode || !view.contentEl.contains(range.anchorNode) || !view.contentEl.contains(range.focusNode)) throw new Error('请在原文中选择英文。');
        const text = range.toString();
        const nativeRange = range.getRangeAt(0).cloneRange();
        const parent = nativeRange.startContainer.nodeType === 1 ? nativeRange.startContainer as Element : nativeRange.startContainer.parentElement;
        const paragraph = parent?.closest('p');
        let sectionElement: HTMLElement | null = paragraph ?? null;
        while (sectionElement && !this.renderedSections.has(sectionElement)) sectionElement = sectionElement.parentElement;
        const section = sectionElement ? this.renderedSections.get(sectionElement) : undefined;
        let localOffset: number | undefined;
        if (paragraph && paragraph.contains(nativeRange.endContainer)) {
          const prefix = nativeRange.cloneRange(); prefix.selectNodeContents(paragraph);
          prefix.setEnd(nativeRange.startContainer, nativeRange.startOffset); localOffset = prefix.toString().length;
        }
        const source = await this.app.vault.read(view.file);
        const offset = paragraph && localOffset !== undefined && section?.path === path
          ? renderedSelectionOffset(source, section.lineStart, section.lineEnd, paragraph.textContent ?? '', localOffset, text) : undefined;
        selected = snapshot(path, source, text, offset);
      }
      if (action === 'digest' && isLongSelection(selected.text)) {
        const generation = ++this.generation; const panel = await this.openPanel();
        if (generation === this.generation && !this.stopped) panel.render(selected,undefined,'','idle');
        return;
      }
      const requestGeneration = this.generation + 1;
      const result = await this.run(selected, 'translate');
      if (action === 'quote' && result && requestGeneration === this.generation && !this.stopped) {
        const status = await this.collect(selected, result, 'quote', 'both');
        new Notice(status);
        if (requestGeneration === this.generation && !this.stopped) (await this.openPanel()).render(selected, result, status);
      }
    } catch (error) { new Notice(error instanceof Error ? error.message : '无法读取选区。'); }
    finally { if (action === 'quote') this.quoteBusy = false; }
  }
  async run(selection: SelectionSnapshot, action: Action): Promise<DigestResult | undefined> {
    const generation = ++this.generation;
    const panel = await this.openPanel();
    if (generation !== this.generation) return;
    panel.render(selection, undefined, '正在请求…', action);
    try {
      const file = this.app.vault.getAbstractFileByPath(selection.path);
      if (!(file instanceof TFile) || await this.app.vault.read(file) !== selection.source) throw new Error('原文已修改，请重新选择。');
      if (generation !== this.generation) return;
      const key = this.secretName ? this.app.secretStorage.getSecret(this.secretName) : null;
      const result = action === 'translate' && isLongSelection(selection.text)
        ? await translateParagraphs(selection,key ?? '',requestUrl,()=>generation===this.generation && !this.stopped,
          (done,total)=>{ if(generation===this.generation) panel.render(selection,undefined,`正在翻译 ${done}/${total} 段…`,action); })
        : await digest(selection, action, key ?? '', requestUrl);
      if (generation !== this.generation) return;
      if (await this.app.vault.read(file) !== selection.source) throw new Error('原文已修改，请重新选择。');
      if (generation !== this.generation) return;
      panel.render(selection, result, '', action);
      return result;
    } catch (error) {
      if (generation === this.generation) panel.render(selection, undefined, error instanceof Error ? error.message : '请求失败。', action);
    }
  }
  async insert(selection: SelectionSnapshot, translation: string, mode: 'below' | 'inline'): Promise<InsertionReceipt | undefined> {
    try {
      const file = this.app.vault.getAbstractFileByPath(selection.path);
      if (!(file instanceof TFile)) throw new Error('原文已移动或删除，请重新选择。');
      const openViews = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
        .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === selection.path && view.getMode() === 'source');
      if (openViews.some(view => view.editor.getValue() !== selection.source)) throw new Error('编辑器中的原文已改变，请重新选择。');
      let receipt: InsertionReceipt | undefined;
      await this.app.vault.process(file, current => {
        receipt = translationInsertion(current, selection, translation, mode);
        return receipt.after;
      });
      if (!receipt || await this.app.vault.read(file) !== receipt.after) throw new Error('插入后原文又有变化，请重新选择。');
      this.generation++;
      new Notice('译文已添加到原文。');
      return receipt;
    } catch (error) { new Notice(error instanceof Error ? error.message : '写入失败。'); }
  }
}
