import { ItemView, MarkdownView, MarkdownRenderChild, Notice, Plugin, TFile, requestUrl } from 'obsidian';
import { canCollectSelection, readingSnapshot, snapshot, translationInsertion, type DigestSelection, type InsertionReceipt, type SelectionSnapshot, type SidebarSelection, type Action } from './core';
import { digest, summarizeArticle, translateParagraphs } from './provider';
import { planArticleSummary, type ArticlePart, type ArticleSummary } from './article-summary';
import { isLongSelection } from './reading-layout';
import { DigestSettings } from './settings';
import { DigestView, VIEW_TYPE } from './view';
import { collectionFeedback, CollectionStore, loadCollection, type Kind, type SaveTarget, type StoragePort } from './collection';
import { vaultStorage } from './vault-storage';
import { applyHighlights, clearHighlights, highlightRanges, tableHighlightRanges } from './highlights';
import { articleBody, locateAnchor } from './anchors';
import type { DigestResult } from './core';
import { articleRange, isSelectionControl, readingShortcut, sidebarSelection } from './reading-actions';
import type { RenderedSection, TableCellPosition } from './markdown-source';
import { CLAUDIAN_VIEW, insertClaudianCallout, readClaudianNote, watchClaudian, type ClaudianSaveMode } from './claudian-callout';

export default class NoteDigestPlugin extends Plugin {
  collection!: CollectionStore;
  private storage!: StoragePort;
  get secretName(): string { return this.collection.secretName; }
  private generation = 0;
  private stopped = false;
  private quoteBusy = false;
  private summaryJob?: { generation: number; path: string; cancelled: boolean };
  private renderedSections = new WeakMap<HTMLElement, RenderedSection & {path: string}>();
  private selectionButton?: HTMLButtonElement;
  private calloutSource?: {view: MarkdownView; file: TFile; selection: Promise<SelectionSnapshot | undefined>};
  private calloutBusy = false;
  private claudianPanes = new Map<HTMLElement, () => void>();
  async onload(): Promise<void> {
    this.stopped = false;
    const data = await this.loadData();
    this.storage = vaultStorage(this.app, value => this.saveData(value));
    this.collection = new CollectionStore(loadCollection(data), this.storage);
    this.registerView(VIEW_TYPE, leaf => new DigestView(leaf, this));
    this.addSettingTab(new DigestSettings(this.app, this));
    this.addRibbonIcon('book-open-text', '打开 Note Digest', () => { void this.openPanel(); });
    this.addCommand({ id: 'open-learning-panel', name: '打开学习侧栏', callback: () => { void this.openPanel(); } });
    this.addCommand({ id: 'digest-selection', name: 'Digest 选中内容', callback: () => { void this.capture(); } });
    this.addCommand({ id: 'summarize-article', name: '总结全文', callback: () => { void this.summarizeCurrentArticle(); } });
    this.addCommand({ id: 'save-quote-selection', name: '收藏选中金句到末尾及独立笔记', callback: () => { void this.capture('quote'); } });
    this.app.workspace.onLayoutReady(() => { if (!this.stopped) this.watchClaudianPanes(); });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.watchClaudianPanes()));
    this.registerDomEvent(document, 'keyup', event => {
      if (event.shiftKey && /^(Arrow|Home|End|Page)/.test(event.key)) this.rememberCalloutSource(event.target);
    });
    this.registerDomEvent(document, 'keydown', event => {
      if (!/^[dn]$/i.test(event.key)) return;
      const selection = window.getSelection();
      const view = this.articleViewForSelection(selection);
      const sidebar = this.readSidebarSelection(selection, false);
      const target = event.target instanceof Element ? event.target : null;
      const action = readingShortcut(event, {
        reading: !!sidebar || view?.getMode() === 'preview',
        selectionInside: !!sidebar || !!view,
        editable: isSelectionControl(target) || !!document.querySelector('.modal-container'),
      });
      if (!action || (sidebar && action === 'quote')) return;
      event.preventDefault(); event.stopPropagation(); this.removeSelectionButton();
      void this.capture(action);
    });
    this.registerDomEvent(document, 'mouseup', event => {
      if (this.selectionButton?.contains(event.target as Node)) return;
      this.rememberCalloutSource(event.target);
      this.removeSelectionButton();
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;
      if (!this.readSidebarSelection(selection, false) && !this.articleViewForSelection(selection)) return;
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
      if (section) this.renderedSections.set(element, {path: context.sourcePath, lineStart: section.lineStart, lineEnd: section.lineEnd, text: section.text});
      const records = this.collection.recordsFor(context.sourcePath);
      if (!records.length) return;
      const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!(file instanceof TFile)) return;
      const source = await this.app.vault.cachedRead(file);
      if (this.stopped) return;
      const info = context.getSectionInfo(element);
      if (!info) return;
      const tables = element.matches('table') ? [element as HTMLTableElement] : Array.from(element.querySelectorAll('table'));
      const tableHighlights = tables.length === 1 ? await tableHighlightRanges(source, info, tables[0], records) : undefined;
      if (this.stopped) return;
      const child = new MarkdownRenderChild(element);
      child.register(() => clearHighlights(element)); context.addChild(child);
      if (tableHighlights) for (const [cell, ranges] of tableHighlights) applyHighlights(cell, ranges);
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
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      this.removeSelectionButton();
      if (leaf?.view instanceof MarkdownView && leaf.view.file?.path !== this.summaryJob?.path) this.stopArticleSummary();
      if (leaf?.view instanceof MarkdownView && leaf.view !== this.calloutSource?.view) this.calloutSource = undefined;
    }));
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (file && file.path !== this.summaryJob?.path) this.stopArticleSummary();
      if (file && file !== this.calloutSource?.file) this.calloutSource = undefined;
    }));
  }
  onunload(): void {
    this.stopped = true; this.generation++; this.removeSelectionButton();
    for (const cleanup of this.claudianPanes.values()) cleanup();
    this.claudianPanes.clear();
    this.calloutSource = undefined;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) if (leaf.view instanceof MarkdownView) clearHighlights(leaf.view.contentEl);
  }
  refreshHighlights(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.getMode() === 'preview') leaf.view.previewMode.rerender(true);
    }
  }
  async collect(selection: SelectionSnapshot, result: DigestResult, kind: Kind, target: SaveTarget): Promise<ReturnType<typeof collectionFeedback>> {
    const report = await this.collection.save(selection, result, kind, target);
    this.refreshHighlights();
    return collectionFeedback(report);
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
    if (!record || record.unlocated || !(file instanceof TFile)) { new Notice('原文位置不可用。'); return; }
    const source = await this.app.vault.read(file);
    const offset = locateAnchor(source, record.anchor);
    if (offset === null) { new Notice('原段落已变化或有重复，无法准确定位；收藏快照仍保留。'); return; }
    const line = source.slice(0, offset).split('\n').length - 1;
    await this.app.workspace.getLeaf(false).openFile(file, {eState: {line}});
  }
  private removeSelectionButton(): void { this.selectionButton?.remove(); this.selectionButton = undefined; }
  private watchClaudianPanes(): void {
    const leaves = this.app.workspace.getLeavesOfType(CLAUDIAN_VIEW);
    const roots = new Set(leaves.map(leaf => leaf.view.containerEl));
    for (const [root, cleanup] of this.claudianPanes) {
      if (roots.has(root)) continue;
      cleanup();
      this.claudianPanes.delete(root);
    }
    for (const {view} of leaves) {
      if (this.claudianPanes.has(view.containerEl)) continue;
      const cleanup = watchClaudian(view.containerEl, (message, mode) => {
        void this.saveClaudianCallout(view, message, mode);
      });
      this.claudianPanes.set(view.containerEl, cleanup);
    }
  }
  private rememberCalloutSource(target: EventTarget | null): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || !(target instanceof Node) || !view.contentEl.contains(target)) return;
    this.calloutSource = {view, file: view.file, selection: this.readArticleSelection().catch(() => undefined)};
  }
  private async saveClaudianCallout(view: object, message: HTMLElement, mode: ClaudianSaveMode): Promise<void> {
    if (this.calloutBusy) return;
    this.calloutBusy = true;
    const label = mode === 'exchange' ? '问答' : '答案';
    try {
      const anchor = this.calloutSource;
      if (!anchor) throw new Error('请先在原文中选中一句话。');
      const note = readClaudianNote(view, message, mode);
      if (!note) throw new Error(mode === 'exchange'
        ? '无法读取这轮完整问答。请确认回复已完成，并在对话中显示对应提问。'
        : '无法读取这条答案。请确认回复已完成。');
      const selection = await anchor.selection;
      if (!selection || !canCollectSelection(selection)) throw new Error('请先在原文中选中可定位的一句话。');
      const {file} = anchor;
      if (this.stopped || this.calloutSource !== anchor || anchor.view.file !== file || file.path !== selection.path ||
          this.app.workspace.getActiveFile() !== file) throw new Error('原文已切换，请重新选中原句。');
      await this.storage.update(selection.path, current => {
        if (this.stopped || this.calloutSource !== anchor || current === null || file.path !== selection.path) {
          throw new Error('原文已切换，请重新选中原句。');
        }
        return insertClaudianCallout(current, selection, note);
      });
      if (this.calloutSource === anchor) this.calloutSource = undefined;
      new Notice(`已在原句下方插入折叠${label}。`);
    } catch (error) { new Notice(error instanceof Error ? error.message : `写入${label}失败。`); }
    finally { this.calloutBusy = false; }
  }
  async openPanel(): Promise<DigestView> {
    const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE, 'right', {active: false});
    if (!(leaf?.view instanceof DigestView)) throw new Error('无法打开右侧栏。');
    return leaf.view;
  }
  stopArticleSummary(): void {
    if (this.summaryJob?.generation === this.generation) this.summaryJob.cancelled = true;
  }
  async summarizeCurrentArticle(previous?: ArticleSummary): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md' || this.collection.isLearningNote(file.path)) {
      new Notice('请先打开要总结的 Markdown 原文。');
      return;
    }
    if (previous && file.path !== previous.path) {
      new Notice('请打开摘要对应的原文后再继续。');
      return;
    }
    if (this.summaryJob?.generation === this.generation && !this.summaryJob.cancelled && this.summaryJob.path === file.path) return;
    const job = {generation: ++this.generation, path: file.path, cancelled: false};
    this.summaryJob = job;
    const isCurrent = () => job.generation === this.generation && !this.stopped;
    let article = previous;
    let panel: DigestView | undefined;
    let stale = false;
    try {
      panel = await this.openPanel();
      if (!isCurrent()) return;
      panel.renderArticleSummary(job.path, article, '正在读取正文…', true);
      const checkActive = () => {
        if (!isCurrent() || job.cancelled) throw new Error('摘要已停止。');
        if (this.app.workspace.getActiveFile() !== file) throw new Error('已切换文章，摘要已停止。');
      };
      checkActive();
      const source = await this.storage.read(job.path);
      checkActive();
      if (source === null || (article && source !== article.source)) {
        stale = true;
        throw new Error('原文已有变化，请重新总结全文。');
      }
      article ??= planArticleSummary(job.path, source);
      const checkSource = async () => {
        checkActive();
        const current = await this.storage.read(job.path);
        checkActive();
        if (current !== source) {
          stale = true;
          throw new Error('原文已有变化，请重新总结全文。');
        }
      };
      const renderProgress = (snapshot: ArticleSummary) => {
        if (!isCurrent() || job.cancelled) return;
        article = snapshot;
        const done = snapshot.sections.length;
        const total = snapshot.parts.length;
        const status = done < total ? `正在总结第 ${done + 1}/${total} 节…` : '正在生成全文概览…';
        panel!.renderArticleSummary(job.path, snapshot, snapshot.overview ? '' : status, !snapshot.overview);
      };
      renderProgress(article);
      const key = this.secretName ? this.app.secretStorage.getSecret(this.secretName) : null;
      await summarizeArticle(article, key ?? '', requestUrl, checkSource, renderProgress);
    } catch (error) {
      if (!isCurrent()) return;
      const message = job.cancelled ? '摘要已停止。' : error instanceof Error ? error.message : '摘要失败，请重试。';
      if (panel) panel.renderArticleSummary(job.path, stale ? undefined : article, message);
      else new Notice(message);
    } finally {
      if (this.summaryJob === job) this.summaryJob = undefined;
    }
  }
  async revealArticlePart(article: ArticleSummary, part: ArticlePart): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(article.path);
      if (!(file instanceof TFile) || await this.storage.read(article.path) !== article.source) throw new Error('原文已有变化，请重新总结全文。');
      const line = article.source.slice(0, part.start).split('\n').length - 1;
      const leaf = this.app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view instanceof MarkdownView && leaf.view.file === file);
      await (leaf ?? this.app.workspace.getLeaf(false)).openFile(file, {active: true, eState: {line}});
    } catch (error) { new Notice(error instanceof Error ? error.message : '无法定位原文。'); }
  }
  private readSidebarSelection(selection: Selection | null, includeContext = true): SidebarSelection | undefined {
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    const {workspace} = this.app;
    let selected: SidebarSelection | undefined;
    workspace.iterateAllLeaves(leaf => {
      const root = leaf.getRoot();
      if (root !== workspace.leftSplit && root !== workspace.rightSplit) return;
      const {view} = leaf;
      if (view instanceof MarkdownView || view.getViewType() === VIEW_TYPE || view.containerEl.checkVisibility?.() === false) return;
      const candidate = sidebarSelection(selection, view instanceof ItemView ? view.contentEl : view.containerEl, includeContext);
      if (candidate) {
        selected = candidate;
        return true;
      }
    });
    return selected;
  }
  private articleViewForSelection(selection: Selection | null): MarkdownView | undefined {
    if (!selection?.anchorNode || !selection.focusNode || !selection.toString().trim()) return;
    const {anchorNode, focusNode} = selection;
    return this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).find(
      (view): view is MarkdownView => view instanceof MarkdownView && view.contentEl.contains(anchorNode) && view.contentEl.contains(focusNode),
    );
  }
  private async readArticleSelection(): Promise<SelectionSnapshot> {
    const selection = window.getSelection();
    const selectionView = this.articleViewForSelection(selection);
    const view = selectionView ?? this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) throw new Error('请在 Markdown 文章或侧栏中选择英文。');
    const file = view.file;
    const path = file.path;
    if (this.collection.isLearningNote(path)) throw new Error('请从原文章选择内容。');
    const domText = selection?.toString() ?? '';
    if (domText.trim() && !selectionView) throw new Error('请在同一个侧栏视图或 Markdown 原文中选择英文。');
    const capture = selectionView && selection?.rangeCount === 1
      ? articleRange(selection.getRangeAt(0), view.contentEl, domText) : undefined;
    const block = capture?.block;
    const widget = block?.closest<HTMLElement>('.cm-table-widget');
    const editing = view.getMode() === 'source';
    const source = editing ? view.editor.getValue() : undefined;
    if (source !== undefined && !widget) {
      const text = view.editor.getSelection();
      const offset = view.editor.posToOffset(view.editor.getCursor('from'));
      if (!capture || (text === domText && source.slice(offset, offset + text.length) === text)) {
        return snapshot(path, source, text, offset);
      }
    }
    if (!capture) throw new Error('请在原文中选择英文。');
    let rendered: Parameters<typeof readingSnapshot>[3];
    if (block && !block.closest('.internal-embed, .markdown-embed')) {
      const table = block.closest('table');
      let sectionElement = table ?? block;
      while (!this.renderedSections.has(sectionElement) && sectionElement.parentElement && sectionElement !== view.contentEl) {
        sectionElement = sectionElement.parentElement;
      }
      const section = this.renderedSections.get(sectionElement);
      const tag = block.localName;
      const row = table ? (block as HTMLTableCellElement).parentElement as HTMLTableRowElement | null : null;
      let cell: TableCellPosition | undefined;
      if (table && row && (tag === 'td' || tag === 'th') && table.rows[row.rowIndex] === row &&
          Array.from(table.rows).every(row => Array.from(row.cells).every(cell => cell.rowSpan === 1 && cell.colSpan === 1))) {
        cell = {row: row.rowIndex, column: (block as HTMLTableCellElement).cellIndex, rows: table.rows.length, columns: table.rows[0].cells.length};
        if (editing && widget) {
          const cm = (view.editor as typeof view.editor & {cm?: {posAtDOM(node: Node): number}}).cm;
          // Live Preview uses a nested cell editor. Ask CodeMirror for the enclosing widget's source position.
          try { cell.widgetStart = cm?.posAtDOM(widget); } catch { /* The widget can be replaced by a render. */ }
        }
      }
      const singleTable = !table || sectionElement === table || sectionElement.querySelectorAll('table').length === 1;
      if ((section?.path === path || cell?.widgetStart !== undefined) && (!table || cell) && (singleTable || widget)) {
        rendered = {section: section?.path === path ? section : undefined, paragraph: capture.text, offset: capture.offset, tag, cell};
      }
    }
    const body = source ?? await this.app.vault.read(file);
    const checkedSection = rendered?.section;
    if (checkedSection && checkedSection.lineStart >= articleBody(body).split('\n').length) {
      throw new Error('请从原文章选择内容，不要收藏生成的学习区。');
    }
    return readingSnapshot(path, body, domText, rendered, capture.context);
  }
  private async capture(action: 'digest' | 'quote' = 'digest'): Promise<void> {
    if (action === 'quote' && this.quoteBusy) return;
    if (action === 'quote') this.quoteBusy = true;
    try {
      const sidebar = this.readSidebarSelection(window.getSelection());
      if (sidebar && action === 'quote') throw new Error('侧栏词语可在「语境解释」中收藏到独立学习笔记。');
      if (sidebar && sidebar.text.length > 12000) throw new Error('请选择 1–12,000 字符的英文内容。');
      const previousGeneration = this.generation;
      const selected = sidebar ?? await this.readArticleSelection();
      if (this.stopped || previousGeneration !== this.generation) return;
      if (action === 'digest' && isLongSelection(selected.text)) {
        const generation = ++this.generation; const panel = await this.openPanel();
        if (generation === this.generation && !this.stopped) panel.render(selected,undefined,'','idle');
        return;
      }
      const quote = action === 'quote' && 'path' in selected ? selected : undefined;
      const requestGeneration = this.generation + 1;
      const result = await this.run(selected, 'translate');
      if (quote && result && requestGeneration === this.generation && !this.stopped) {
        const {text: status} = await this.collect(quote, result, 'quote', 'both');
        new Notice(status);
        if (requestGeneration === this.generation && !this.stopped) (await this.openPanel()).render(selected, result, status);
      }
    } catch (error) { new Notice(error instanceof Error ? error.message : '无法读取选区。'); }
    finally { if (action === 'quote') this.quoteBusy = false; }
  }
  async run(selection: DigestSelection, action: Action, previousResult?: DigestResult): Promise<DigestResult | undefined> {
    const generation = ++this.generation;
    const panel = await this.openPanel();
    if (generation !== this.generation) return;
    panel.render(selection, undefined, '正在请求…', action);
    try {
      const article = 'path' in selection ? selection : undefined;
      const file = article ? this.app.vault.getFileByPath(article.path) : null;
      if (article && (!file || await this.app.vault.read(file) !== article.source)) throw new Error('原文已修改，请重新选择。');
      if (generation !== this.generation) return;
      if (previousResult) {
        panel.render(selection, previousResult, '', action);
        return previousResult;
      }
      const key = this.secretName ? this.app.secretStorage.getSecret(this.secretName) : null;
      const result = article && action === 'translate' && isLongSelection(article.text) && canCollectSelection(article)
        ? await translateParagraphs(article,key ?? '',requestUrl,()=>generation===this.generation && !this.stopped,
          (done,total)=>{ if(generation===this.generation) panel.render(selection,undefined,`正在翻译 ${done}/${total} 段…`,action); })
        : await digest(selection, action, key ?? '', requestUrl);
      if (generation !== this.generation) return;
      if (article && file && await this.app.vault.read(file) !== article.source) throw new Error('原文已修改，请重新选择。');
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
