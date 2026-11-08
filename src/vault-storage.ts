import { MarkdownView, TFile, TFolder, type App } from 'obsidian';
import type { CollectionData, StoragePort } from './collection';
export function vaultStorage(app: App, persist: (data: CollectionData) => Promise<void>): StoragePort {
  function assertSaved(path: string, disk: string): void {
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source' && view.editor.getValue() !== disk) {
        throw new Error('编辑器尚有未同步的修改，请稍后重试。');
      }
    }
  }
  return {
    persist,
    async read(path) {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return null;
      const content = await app.vault.read(file); assertSaved(path, content); return content;
    },
    async update(path, transform) {
      let file = app.vault.getAbstractFileByPath(path);
      if (!file) {
        const segments = path.split('/'); segments.pop(); let folderPath = '';
        for (const segment of segments) {
          folderPath = folderPath ? folderPath + '/' + segment : segment;
          const folder = app.vault.getAbstractFileByPath(folderPath);
          if (folder && !(folder instanceof TFolder)) throw new Error('学习笔记目录被同名文件占用。');
          if (!folder) {
            try { await app.vault.createFolder(folderPath); }
            catch { if (!(app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) throw new Error('无法创建学习笔记目录。'); }
          }
        }
        file = app.vault.getAbstractFileByPath(path);
        if (!file) { await app.vault.create(path, transform(null)); return; }
      }
      if (!(file instanceof TFile)) throw new Error('保存路径被同名目录占用。');
      await app.vault.process(file, current => { assertSaved(path, current); return transform(current); });
    }
  };
}
