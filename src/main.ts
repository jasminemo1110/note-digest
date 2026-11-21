import { ItemView, MarkdownView, MarkdownRenderChild, Notice, Plugin, TFile, requestUrl, type Editor, type WorkspaceLeaf } from 'obsidian';
import { canCollectSelection, readingSnapshot, snapshot, translationInsertion, type DigestSelection, type InsertionReceipt, type SelectionSnapshot, type SidebarSelection, type Action } from './core';
import { digest, summarizeArticle, translateArticlePart, translateParagraphs } from './provider';
import { articleFileSource, articleFinished, overviewInsertion, planArticleSummary, planSelectedSummary, rebaseAfterOverview, sectionAt, translationChunks, type ArticlePart, type ArticleSummary } from './article-summary';
import { isLongSelection, type ParagraphTranslation } from './reading-layout';
import { DigestSettings } from './settings';
import { DigestView, VIEW_TYPE } from './view';
import { collectionFeedback, CollectionStore, loadCollection, type Kind, type SaveTarget, type StoragePort } from './collection';
import { vaultStorage } from './vault-storage';
import { applyHighlights, clearHighlights, highlightRanges, tableHighlightRanges } from './highlights';
import { articleBody, locateAnchor, SECTION_TRANSLATION_CALLOUT, SUMMARY_CALLOUT } from './anchors';
import type { DigestResult } from './core';
import { articleRange, isSelectionControl, readingShortcut, sidebarSelection } from './reading-actions';
import type { RenderedSection, TableCellPosition } from './markdown-source';
import { CLAUDIAN_VIEW, insertClaudianCallout, readClaudianNote, watchClaudian, type ClaudianSaveMode } from './claudian-callout';
import { appendClaudianDraft, getClaudian } from './claudian-draft';
import { ResultCache } from './result-cache';
import { changeSectionTranslation } from './section-translation';

type CodeMirrorEditor = Editor & {cm?: {posAtDOM(node: Node, offset?: number): number}};

export default class NoteDigestPlugin extends Plugin {
  collection!: CollectionStore;
  private storage!: StoragePort;
  resultCache!: ResultCache;
  get secretName(): string { return this.collection.secretName; }
  private generation = 0;
  private stopped = false;
  private quoteBusy = false;
  private summaryJob?: { generation: number; path: string; selection?: DigestSelection; cancelled: boolean };
  private renderedSections = new WeakMap<HTMLElement, RenderedSection & {path: string}>();
  private selectionButton?: HTMLButtonElement;
  private calloutSource?: {view: MarkdownView; file: TFile; selection: Promise<SelectionSnapshot | undefined>};
  private calloutBusy = false;
  private claudianPanes = new Map<HTMLElement, () => void>();
  private recentClaudianLeaf?: WorkspaceLeaf;
  async onload(): Promise<void> {
    this.stopped = false;
    this.resultCache = new ResultCache({
      load: key => this.app.loadLocalStorage(key),
      save: (key, value) => this.app.saveLocalStorage(key, value),
    });
    const data = await this.loadData();
    this.storage = vaultStorage(this.app, value => this.saveData(value));
    this.collection = new CollectionStore(loadCollection(data), this.storage);
    this.registerView(VIEW_TYPE, leaf => new DigestView(leaf, this));
    this.addSettingTab(new DigestSettings(this.app, this));
    this.addRibbonIcon('book-open-text', '打开 Note Digest', () => { void this.openPanel(); });
    this.addCommand({ id: 'open-learning-panel', name: '打开学习侧栏', callback: () => { void this.openPanel(); } });
    this.addCommand({ id: 'digest-selection', name: 'Digest 选中内容', callback: () => { void this.capture(); } });
    this.addCommand({ id: 'summarize-article', name: 'Digest 全文', callback: () => { void this.summarizeCurrentArticle(); } });
    this.addCommand({ id: 'save-quote-selection', name: '收藏选中金句到末尾及独立笔记', callback: () => { void this.capture('quote'); } });
    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      this.watchClaudianPanes();
      this.refreshHighlights();
    });
    this.registerEvent(this.app.workspace.on('layout-change', () => this.watchClaudianPanes()));
    this.registerDomEvent(document, 'keyup', event => {
      if (!event.shiftKey || !/^(Arrow|Home|End|Page)/.test(event.key)) return;
      this.rememberCalloutSource(event.target);
      const selection = window.getSelection();
      if (selection) this.offerClaudianDraft(selection);
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
      if (this.offerClaudianDraft(selection)) return;
      if (!this.readSidebarSelection(selection, false) && !this.articleViewForSelection(selection)) return;
      this.showSelectionButton(selection.getRangeAt(0), 'Digest', () => { void this.capture(); });
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
      if (leaf?.view.getViewType() === CLAUDIAN_VIEW) this.recentClaudianLeaf = leaf;
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
  refreshHighlights(path?: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      // A Markdown view can reuse its existing preview when returning from edit mode.
      if (leaf.view instanceof MarkdownView && (!path || leaf.view.file?.path === path)) leaf.view.previewMode.rerender(true);
    }
  }
  async collect(selection: SelectionSnapshot, result: DigestResult, kind: Kind, target: SaveTarget): Promise<ReturnType<typeof collectionFeedback>> {
    const report = await this.collection.save(selection, result, kind, target);
    this.refreshHighlights(selection.path);
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
  private showSelectionButton(range: Range, label: string, activate: () => void): void {
    this.removeSelectionButton();
    const rect = range.getBoundingClientRect();
    const button = document.body.createEl('button', {text:label, cls:'note-digest-selection'});
    button.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - button.offsetWidth - 8)) + 'px';
    button.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - button.offsetHeight - 8)) + 'px';
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => {
      this.removeSelectionButton();
      activate();
    };
    this.selectionButton = button;
  }
  private offerClaudianDraft(selection: Selection): boolean {
    if (selection.isCollapsed || !getClaudian(this.app)) return false;
    for (const {view} of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (!(view instanceof DigestView)) continue;
      const selected = view.claudianExcerpt(selection);
      if (!selected) continue;
      this.showSelectionButton(selection.getRangeAt(0), '问 Claudian', () => {
        if (!selected.region.isConnected) return;
        void appendClaudianDraft(this.app, selected.excerpt, this.recentClaudianLeaf)
          .catch(error => new Notice(error instanceof Error ? error.message : '无法把选段加入 Claudian 草稿。'));
      });
      return true;
    }
    return false;
  }
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
    if (target instanceof Node) this.setCalloutSource(this.articleViewContaining(target), window.getSelection());
  }
  private setCalloutSource(view: MarkdownView | undefined, selection: Selection | null): void {
    if (!view?.file) return;
    this.calloutSource = {view, file: view.file, selection: this.readArticleSelection(selection, view).catch(() => undefined)};
  }
  private async saveClaudianCallout(view: object, message: HTMLElement, mode: ClaudianSaveMode): Promise<void> {
    if (this.calloutBusy) return;
    this.calloutBusy = true;
    const label = mode === 'exchange' ? '问答' : '答案';
    try {
      // A sidebar click can change focus while the note still owns the live selection.
      const live = window.getSelection();
      this.setCalloutSource(this.articleViewForSelection(live), live);
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
  summarizeCurrentArticle(regenerate = false): Promise<void> {
    return this.showDigest(undefined, regenerate);
  }
  async summarizeSelection(fallback?: DigestSelection): Promise<void> {
    try { await this.showDigest(await this.latestSelection(fallback)); }
    catch (error) { new Notice(error instanceof Error ? error.message : '无法读取选区。'); }
  }
  retryDigest(article?: ArticleSummary, regenerate = false): Promise<void> {
    return this.showDigest(article?.selection, regenerate);
  }
  private async showDigest(selection?: DigestSelection, regenerate = false): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    const file = selection && 'sidebar' in selection ? null : active;
    if ((!selection || 'path' in selection) && (!file || file.extension !== 'md' ||
        this.collection.isLearningNote(file.path) || (selection && selection.path !== file.path))) {
      new Notice('请先打开要 Digest 的 Markdown 原文。');
      return;
    }
    const path = file?.path ?? '';
    if (this.summaryJob?.generation === this.generation && !this.summaryJob.cancelled &&
        this.summaryJob.path === path && this.summaryJob.selection === selection) return;
    const job = {generation: ++this.generation, path, selection, cancelled: false};
    this.summaryJob = job;
    const isCurrent = () => job.generation === this.generation && !this.stopped;
    let article: ArticleSummary | undefined;
    let panel: DigestView | undefined;
    let stale = false;
    const checkActive = () => {
      if (!isCurrent() || job.cancelled) throw new Error('摘要已停止。');
      if (file && this.app.workspace.getActiveFile() !== file) throw new Error('已切换文章，摘要已停止。');
    };
    try {
      panel = await this.openPanel();
      checkActive();
      const source = file ? await this.storage.read(path) : null;
      checkActive();
      if (file && (source === null || (selection && 'path' in selection && selection.source !== source))) {
        stale = true;
        throw new Error('原文已修改，请重新选择或打开 Digest。');
      }
      article = selection ? planSelectedSummary(selection) : planArticleSummary(path, source!);
      const checkSource = async () => {
        checkActive();
        if (!file) return;
        const current = await this.storage.read(path);
        checkActive();
        if (current !== source) {
          stale = true;
          throw new Error('原文已修改，请重新打开 Digest。');
        }
      };
      const renderRequest = () => {
        checkActive();
        if (!article) return;
        const done = article.sections.length;
        const total = article.parts.length;
        const status = done < total ? `正在总结第 ${done + 1}/${total} 节…` : '正在生成全文概览…';
        panel!.renderArticleSummary(path, article, status, true);
      };
      const key = this.secretName ? this.app.secretStorage.getSecret(this.secretName) : null;
      await summarizeArticle(article, key ?? '', requestUrl, checkSource, current => {
        article = current;
        if (articleFinished(current)) panel!.renderArticleSummary(path, current);
      }, {cache: this.resultCache, regenerate, onRequest: renderRequest});
    } catch (error) {
      if (!isCurrent() || job.cancelled) return;
      const message = error instanceof Error ? error.message : '摘要失败，请重试。';
      if (panel) panel.renderArticleSummary(path, stale ? undefined : article, message, false, selection);
      else new Notice(message);
    } finally {
      if (this.summaryJob === job) this.summaryJob = undefined;
    }
  }
  private async checkArticleSource(article: ArticleSummary): Promise<void> {
    const expected = articleFileSource(article);
    if (expected !== undefined && (this.app.workspace.getActiveFile()?.path !== article.path ||
        await this.storage.read(article.path) !== expected)) throw new Error('原文已切换或修改，请重新打开 Digest。');
  }
  async revealArticlePart(article: ArticleSummary, part: ArticlePart): Promise<void> {
    try {
      await this.checkArticleSource(article);
      const file = this.app.vault.getFileByPath(article.path);
      if (!file) throw new Error('无法定位原文。');
      const line = article.source.slice(0, part.start).split('\n').length - 1;
      const leaf = this.app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view instanceof MarkdownView && leaf.view.file === file);
      await (leaf ?? this.app.workspace.getLeaf(false)).openFile(file, {active: true, eState: {line}});
    } catch (error) { new Notice(error instanceof Error ? error.message : '无法定位原文。'); }
  }
  async translateSection(article: ArticleSummary, index: number, returnScroll: number, regenerate = false): Promise<void> {
    const generation = ++this.generation;
    const current = () => generation === this.generation && !this.stopped;
    const panel = await this.openPanel();
    try {
      if (!current()) return;
      await this.checkArticleSource(article);
      if (!current()) return;
      const key = this.secretName ? this.app.secretStorage.getSecret(this.secretName) : null;
      const result: ParagraphTranslation[] = [];
      const chunks = translationChunks(article, sectionAt(article, index));
      for (const chunk of chunks) {
        if (!current()) return;
        result.push(...await translateArticlePart(article, chunk, key ?? '', requestUrl, {
          cache: this.resultCache, regenerate,
          onRequest: () => {
            if (!current()) throw new Error('操作已取消。');
            panel.renderSectionTranslation(article, index, returnScroll, [], '正在翻译本节…', true);
          },
        }));
        if (!current()) return;
        await this.checkArticleSource(article);
      }
      if (current()) panel.renderSectionTranslation(article, index, returnScroll, result);
    } catch (error) {
      if (current()) panel.renderSectionTranslation(article, index, returnScroll, [], error instanceof Error ? error.message : '翻译失败。');
    }
  }
  async writeSectionTranslation(article: ArticleSummary, index: number, paragraphs: ParagraphTranslation[], undo = false): Promise<ArticleSummary> {
    await this.checkArticleSource(article);
    const changed = await changeSectionTranslation(article, sectionAt(article, index), paragraphs, undo);
    await this.storage.update(article.path, current => {
      if (current !== article.source) throw new Error('原文已修改，请重新打开本节后操作。');
      return changed.source;
    });
    return changed;
  }
  async returnToDigest(panel: DigestView, article: ArticleSummary, scroll: number): Promise<void> {
    const generation = ++this.generation;
    try {
      await this.checkArticleSource(article);
      if (this.generation !== generation || this.stopped) return;
      panel.renderArticleSummary(article.path, article);
      panel.contentEl.scrollTop = scroll;
    } catch (error) {
      if (this.generation === generation && !this.stopped) panel.renderArticleSummary(article.path, undefined,
        error instanceof Error ? error.message : '无法打开摘要。', false, article.selection);
    }
  }
  async saveOverview(article: ArticleSummary): Promise<{article: ArticleSummary; receipt?: InsertionReceipt}> {
    await this.checkArticleSource(article);
    let receipt: InsertionReceipt | undefined;
    await this.storage.update(article.path, current => {
      if (current === null) throw new Error('找不到原文。');
      receipt = overviewInsertion(current, article);
      return receipt?.after ?? current;
    });
    return {article: receipt ? rebaseAfterOverview(article, receipt) : article, receipt};
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
    return this.articleViewContaining(selection.anchorNode, selection.focusNode);
  }
  private articleViewContaining(...nodes: Node[]): MarkdownView | undefined {
    return this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).find(
      (view): view is MarkdownView => view instanceof MarkdownView && nodes.every(node => view.contentEl.contains(node)),
    );
  }
  private async readArticleSelection(selection = window.getSelection(), sourceView?: MarkdownView): Promise<SelectionSnapshot> {
    const selectionView = this.articleViewForSelection(selection);
    const view = sourceView ?? selectionView ?? this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) throw new Error('请在 Markdown 文章或侧栏中选择英文。');
    const file = view.file;
    const path = file.path;
    if (this.collection.isLearningNote(path)) throw new Error('请从原文章选择内容。');
    const domText = selection?.toString() ?? '';
    if (domText.trim() && selectionView !== view) throw new Error('请在同一个侧栏视图或 Markdown 原文中选择英文。');
    const nativeRange = selectionView === view && selection?.rangeCount === 1 ? selection.getRangeAt(0) : undefined;
    const capture = nativeRange && articleRange(nativeRange, view.contentEl, domText);
    const block = capture?.block;
    const generated = `[data-callout="${SUMMARY_CALLOUT}"], [data-callout="${SECTION_TRANSLATION_CALLOUT}"]`;
    if (nativeRange && [...view.contentEl.querySelectorAll(generated)].some(el => nativeRange.intersectsNode(el))) {
      throw new Error('请在英文原文中选择内容。');
    }
    const widget = block?.closest<HTMLElement>('.cm-table-widget');
    const editing = view.getMode() === 'source';
    const cm = editing ? (view.editor as CodeMirrorEditor).cm : undefined;
    const source = editing ? view.editor.getValue() : undefined;
    if (source !== undefined && !widget) {
      const text = view.editor.getSelection();
      const offset = view.editor.posToOffset(view.editor.getCursor('from'));
      if (!nativeRange || (text === domText && source.slice(offset, offset + text.length) === text)) {
        return snapshot(path, source, text, offset);
      }
      // Live Preview can hide Markdown delimiters. Compare editor coordinates when the visible text differs.
      if (cm && text && !block?.closest('.internal-embed, .markdown-embed')) {
        let matches = false;
        try {
          matches = cm.posAtDOM(nativeRange.startContainer, nativeRange.startOffset) === offset &&
            cm.posAtDOM(nativeRange.endContainer, nativeRange.endOffset) === offset + text.length;
        } catch { /* The selection may belong to a rendered widget. */ }
        if (matches) return snapshot(path, source, text, offset);
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
  private async latestSelection(fallback?: DigestSelection): Promise<DigestSelection> {
    const live = window.getSelection();
    const sidebar = this.readSidebarSelection(live);
    if (sidebar) {
      if (sidebar.text.length > 12000) throw new Error('请选择 1–12,000 字符的英文内容。');
      return sidebar;
    }
    const selectedView = this.articleViewForSelection(live);
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    const captured = selectedView ? await this.readArticleSelection(live, selectedView) :
      active?.getMode() === 'source' && active.editor.getSelection().trim() ? await this.readArticleSelection(null, active) : undefined;
    if (captured) {
      if (captured.start >= 0 && fallback && 'path' in fallback && captured.path === fallback.path &&
          captured.source === fallback.source && captured.start === fallback.start &&
          captured.end === fallback.end && captured.text === fallback.text) return fallback;
      return captured;
    }
    if (fallback && ('sidebar' in fallback || fallback.path === this.app.workspace.getActiveFile()?.path)) return fallback;
    throw new Error('请先在原文中划选英文。');
  }
  async runSelectionAction(action: 'translate' | 'explain', fallback?: DigestSelection): Promise<void> {
    try {
      const selection = await this.latestSelection(fallback);
      if (isLongSelection(selection.text)) throw new Error('请选择词语、短语或短句。多段文字可使用「Digest 选中段落」。');
      await this.run(selection, action);
    } catch (error) { new Notice(error instanceof Error ? error.message : '无法读取选区。'); }
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
  async run(selection: DigestSelection, action: Action, regenerate = false): Promise<DigestResult | undefined> {
    const generation = ++this.generation;
    const panel = await this.openPanel();
    if (generation !== this.generation) return;
    try {
      const article = 'path' in selection ? selection : undefined;
      const file = article ? this.app.vault.getFileByPath(article.path) : null;
      if (article && (!file || await this.app.vault.read(file) !== article.source)) throw new Error('原文已修改，请重新选择。');
      if (generation !== this.generation) return;
      const key = this.secretName ? this.app.secretStorage.getSecret(this.secretName) : null;
      const options = {cache: this.resultCache, regenerate, onRequest: () => {
        if (generation !== this.generation || this.stopped) throw new Error('操作已取消。');
        panel.render(selection, undefined, '正在请求…', action);
      }};
      const result = article && action === 'translate' && isLongSelection(article.text) && canCollectSelection(article)
        ? await translateParagraphs(article,key ?? '',requestUrl,()=>generation===this.generation && !this.stopped,
          (done,total)=>{ if(generation===this.generation) panel.render(selection,undefined,`正在翻译 ${done}/${total} 段…`,action); }, options)
        : await digest(selection, action, key ?? '', requestUrl, options);
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
