import type { App, WorkspaceLeaf } from 'obsidian';
import { CLAUDIAN_VIEW } from './claudian-callout';

interface ClaudianView {
  appendToActiveInput?(text: string): boolean;
  getActiveTab?(): object | null;
}

interface ClaudianPlugin {
  views?: {activateView?(): Promise<void>};
}

export interface ClaudianExcerpt {
  text: string;
  source?: string;
  title?: string;
}

export function getClaudian(app: App): ClaudianPlugin | null | undefined {
  const host = app as App & {plugins?: {getPlugin(id: string): ClaudianPlugin | null}};
  return host.plugins?.getPlugin('realclaudian');
}

export async function appendClaudianDraft(app: App, excerpt: ClaudianExcerpt, recentLeaf?: WorkspaceLeaf): Promise<void> {
  const plugin = getClaudian(app);
  if (!plugin) throw new Error('请先启用 Claudian。');
  const {workspace} = app;
  let leaves = workspace.getLeavesOfType(CLAUDIAN_VIEW);
  if (!leaves.length) {
    await plugin.views?.activateView?.();
    leaves = workspace.getLeavesOfType(CLAUDIAN_VIEW);
  }
  const current = leaves.find(leaf => leaf === workspace.activeLeaf) ?? leaves.find(leaf => leaf === recentLeaf);
  const visible = leaves.filter(leaf => leaf.view.containerEl.isShown());
  const leaf = current ?? (visible.length === 1 ? visible[0] : undefined) ?? (leaves.length === 1 ? leaves[0] : undefined);
  if (!leaf) throw new Error(leaves.length ? '请先切换到要追问的 Claudian 面板。' : '请先打开 Claudian 对话。');

  const tab = (leaf.view as ClaudianView).getActiveTab?.();
  await workspace.revealLeaf(leaf);
  const view = leaf.view as ClaudianView;
  if (tab && view.getActiveTab?.() !== tab) throw new Error('Claudian 对话已切换，请重新划选后再试。');

  const parts = [
    excerpt.title && '【来源】\n' + excerpt.title,
    excerpt.source && '【英文原文】\n' + excerpt.source,
    '【选中的 Note Digest 内容】\n' + excerpt.text,
    '【我的追问】\n',
  ];
  if (!view.appendToActiveInput?.('\n\n' + parts.filter(Boolean).join('\n\n'))) {
    throw new Error('Claudian 输入框不可用，可以复制这段内容到对话里。');
  }
}
