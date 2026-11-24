import { frontmatterEnd } from './anchors';
import { isEnglishWord, isWordFamilyPronunciation, MAX_WORD_FAMILY, type DictionarySense, type WordFamilyEntry } from './core';

export const WORD_NOTE_FOLDER = 'Digest/单词学习/';

export function wordNoteBody(note: string): string {
  return note.slice(frontmatterEnd(note));
}

export function addWordVocabulary(note: string, word: string, senses: DictionarySense[] = [], pronunciation?: string | null): string {
  const labels = senses.map(sense => senses.some(other => other !== sense && other.partOfSpeech === sense.partOfSpeech)
    ? `${sense.partOfSpeech}（${sense.pronunciation ?? '读音待核对'}）` : sense.partOfSpeech);
  const singlePronunciation = senses[0]?.pronunciation ?? pronunciation;
  const properties = {
    digest_word: word,
    digest_pos: [...new Set(senses.map(sense => sense.partOfSpeech))],
    digest_ipa: senses.length > 1
      ? senses.flatMap(sense => sense.pronunciation ? [`${sense.partOfSpeech} · ${sense.pronunciation}`] : [])
      : singlePronunciation ? [singlePronunciation] : [],
    digest_meaning: senses.map((sense, index) => senses.length === 1 ? sense.meaning : `${labels[index]} · ${sense.meaning}`),
    digest_has_cards: true,
  };
  const end = frontmatterEnd(note);
  const metadata = note.slice(0, end);
  const start = note.startsWith('\uFEFF') ? 1 : 0;
  const newline = note.includes('\r\n') ? '\r\n' : '\n';
  const lines = Object.entries(properties)
    .filter(([key]) => !new RegExp(`^(?:${key}|"${key}"|'${key}')[ \\t]*:`, 'm').test(metadata))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}${newline}`).join('');
  if (!lines) return note;
  if (end === start) return note.slice(0, start) + `---${newline}${lines}---${newline}` + note.slice(start);
  const openingEnd = note.indexOf('\n') + 1;
  return note.slice(0, openingEnd) + lines + note.slice(openingEnd);
}

export function markWordNoteCards(note: string, hasCards: boolean): string {
  const end = frontmatterEnd(note);
  const metadata = note.slice(0, end).replace(/^digest_has_cards: (true|false)(?=\r?$)/m, `digest_has_cards: ${hasCards}`);
  return metadata + note.slice(end);
}

function wordFamilyFromCards(note: string): WordFamilyEntry[] {
  const body = wordNoteBody(note);
  if (!/^<!-- note-digest:word-note:[0-9a-f]{64} -->\r?\n/.test(body)) return [];
  const cards = body.matchAll(/^<!-- note-digest:record:([a-zA-Z0-9-]+) -->\r?\n([\s\S]*?)^<!-- note-digest:record-end:\1 -->\r?$/gm);
  const entries = new Map<string, WordFamilyEntry>();
  for (const [, , card] of [...cards].reverse()) {
    const family = /^\*\*同族词\*\*\r?\n\r?\n((?:- \*\*[^\r\n]+\r?\n?)+)/m.exec(card)?.[1];
    if (!family) continue;
    for (const line of family.trimEnd().split(/\r?\n/)) {
      const match = /^- \*\*(.+?)\*\* · (.+)$/.exec(line);
      if (!match) continue;
      const word = unescapeField(match[1]);
      if (!isEnglishWord(word) || word.length > 80) continue;
      const fields = match[2].split(' · ');
      const first = unescapeField(fields[0]);
      const pronunciation = isWordFamilyPronunciation(first) ? first : undefined;
      if (pronunciation) fields.shift();
      const partOfSpeech = unescapeField(fields.shift() ?? '');
      const meaning = unescapeField(fields.join(' · '));
      if (!meaning || !partOfSpeech) continue;
      const key = word.toLowerCase();
      const existing = entries.get(key);
      if (!existing && entries.size < MAX_WORD_FAMILY) entries.set(key, {word, pronunciation, partOfSpeech, meaning});
      if (existing && !existing.pronunciation && existing.partOfSpeech === partOfSpeech) existing.pronunciation = pronunciation;
    }
  }
  return [...entries.values()];
}

// Invert the escapes used in the plugin's generated single-line card fields.
function unescapeField(value: string): string {
  return value.replace(/\\([\\`*_{}\[\]()#+.!|~=-])|&(amp|lt|gt);|&#(37|36|94|58);/g,
    (_, punctuation, entity, code) => punctuation ?? (entity ? ({amp:'&', lt:'<', gt:'>'} as Record<string, string>)[entity] : String.fromCharCode(Number(code))));
}

type FamilyNotePath = (word: string) => Promise<string>;

export async function indexWordFamily(note: string, previous: string | null, findPath: FamilyNotePath): Promise<string> {
  const end = frontmatterEnd(note);
  if (end <= Number(note.startsWith('\uFEFF'))) return note;
  const metadata = note.slice(0, end);
  const rowValues = (text: string) => wordFamilyFromCards(text).map(({word, pronunciation, meaning}) =>
    [word, pronunciation ?? '', meaning.replaceAll('\t', ' ')].join('\t'));
  const existing = /^digest_family: (\[[^\r\n]*\])\r?$/m.exec(metadata)?.[1];
  const hasFamilyProperties = /^(?:["']?digest_family(?:_notes)?["']?)[ \t]*:/m.test(metadata);
  if (hasFamilyProperties && (previous === null || existing !== JSON.stringify(rowValues(previous)))) return note;

  const rows = rowValues(note);
  const newline = metadata.includes('\r\n') ? '\r\n' : '\n';
  let familyProperties = '';
  if (rows.length) {
    const links = await Promise.all(rows.map(async row => `[[${await findPath(row.split('\t', 1)[0])}]]`));
    familyProperties = `digest_family: ${JSON.stringify(rows)}${newline}digest_family_notes: ${JSON.stringify(links)}${newline}`;
  }
  const updated = metadata.replace(/^digest_family: \[[^\r\n]*\]\r?\n/m, '')
    .replace(/^digest_family_notes:[^\r\n]*\r?\n(?:[ \t]*- [^\r\n]*\r?\n)*/m, '')
    .replace(/\r?\n(?=(?:---|\.\.\.)[ \t]*(?:\r?\n)?$)/, ending => ending + familyProperties);
  return updated + note.slice(end);
}
