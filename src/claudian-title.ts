const maxTitleLength = 48;
const comparison = /辨析|区别|差别|对比|difference between|vs\.?\s/i;
const grammar = /句[型式]|句子结构|主干|语法|从句|宾语|并列|倒装|时态|介词|物主/;
const vocabulary = /单词|这个词|词义|词性|名词|动词|形容词|副词|发音|拼写|怎么说|什么意思|意思是/;

function plainText(text: string): string {
  return text.replace(/!?\[\[([^\]\n]+)\]\]/g, (_, target: string) => target.split('|').at(-1) ?? '')
    .replace(/!?\[([^\]\n]+)\]\([^\n)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s。，；]+|<[^>\n]+>/g, '')
    .replace(/[*_`]/g, '')
    .replace(/^(?:[\s>#-]|\d+[.)]\s)+/, '')
    .replace(/\s+/g, ' ').trim();
}

function openingLines(text: string): string[] {
  return text.slice(0, 1600).split(/\r?\n/).map(plainText).filter(Boolean).slice(0, 5);
}

function englishWords(text: string): string[] {
  return [...new Set((text.match(/[a-z]{2,}(?:[-'][a-z]+)*/gi) ?? []).map(word => word.toLowerCase()))];
}

function concise(title: string): string {
  const characters = Array.from(title.trim().replace(/[。！？!?；;]+$/, ''));
  if (characters.length <= maxTitleLength) return characters.join('');
  const prefix = characters.slice(0, maxTitleLength - 1).join('');
  // Prefer the last full English word to a truncated one.
  const atWordEnd = /[a-z]/i.test(characters[maxTitleLength - 1]) ? prefix.replace(/\s+[a-z'-]+$/i, '') : prefix;
  return atWordEnd.trimEnd() + '…';
}

function comparisonTitle(prompt: string, replies: string[]): string | undefined {
  for (const line of [prompt, ...replies]) {
    const pair = line.match(/\b([a-z][a-z'-]+)\s+vs\.?\s+([a-z][a-z'-]+)\b/i) ??
      line.match(/\bdifference between ([a-z][a-z'-]+) and ([a-z][a-z'-]+)\b/i);
    if (pair) return `词义辨析：${pair[1].toLowerCase()} vs. ${pair[2].toLowerCase()}`;
  }
  if (!comparison.test([prompt, ...replies].join(' '))) return;
  for (const line of [prompt, ...replies]) {
    const words = englishWords(line);
    if (words.length === 2) return `词义辨析：${words.join(' vs. ')}`;
  }
}

function structureTitle(prompt: string, replies: string[]): string | undefined {
  const lead = [...replies, prompt].join(' ');
  if (!grammar.test(lead)) return;
  const pattern = lead.match(/\b(?:[a-z]+ A,? (?:not just|but not|rather than|and|or) B|not only A but also B)\b/);
  if (pattern) return `句子结构：${pattern[0]}`;
  for (const line of [prompt, ...replies]) {
    const clause = line.match(/\b([a-z]{2,})\s*引导的\s*((?:宾语|主语|表语|同位语|定语|状语|名词性)?从句)/i);
    if (clause) return `句子结构：${clause[1]} 引导的${clause[2]}`;
  }
}

function vocabularyTitle(prompt: string, replies: string[], hasQuestion: boolean): string | undefined {
  const label = hasQuestion ? '单词问答' : '单词笔记';
  const wordAsked = prompt.match(/\bwhat does ([a-z][a-z'-]+) mean\b/i);
  if (wordAsked) return `${label}：${wordAsked[1].toLowerCase()}`;
  if (!vocabulary.test([prompt, ...replies].join(' '))) return;
  for (const line of replies) {
    const direct = line.match(/(?:就是|英文是|可以用|可以说|可译为)\s*([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3})(?=[\s，、。；！!?（(]|$)/i);
    if (direct) return `${label}：${direct[1].toLowerCase()}`;
  }
  for (const line of [prompt, ...replies]) {
    if (!vocabulary.test(line)) continue;
    const words = englishWords(line);
    if (words.length === 1) return `${label}：${words[0]}`;
  }
}

/** Derive a short title from saved text without another model request. */
export function claudianTitle(note: {question?: string; answer: string}, sourceText: string): string {
  const prompt = openingLines(note.question ?? '').join(' ');
  const replies = openingLines(note.answer);
  const title = structureTitle(prompt, replies) ?? comparisonTitle(prompt, replies) ??
    vocabularyTitle(prompt, replies, note.question !== undefined);
  if (title) return concise(title);

  for (const line of replies) {
    const topic = line.replace(/^(?:对|好的?|可以|没错|是的|当然|简单来说|核心(?:区别|要点))[、，。！!：:\s]+/, '');
    const opening = topic.split(/[。！？!?；;](?:\s*|$)/)[0].trim();
    if (opening.length >= 3 && !/^(?:已(?:补充|添加|更新|保存|写入)|可以的|没问题|这就|下面是)/.test(opening)) {
      return concise(opening);
    }
  }
  return concise(prompt || plainText(sourceText) || replies[0] || '学习批注');
}
