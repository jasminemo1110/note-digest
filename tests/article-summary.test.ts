import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEARNING_BOUNDARY } from '../src/anchors';
import { planArticleSummary, type ArticleSummary } from '../src/article-summary';
import { summarizeArticle, type Transport } from '../src/provider';

test('full article ranges follow headings and cover the exact body, excluding frontmatter and generated notes', () => {
  const properties = '\uFEFF---\r\ntitle: Hidden property\r\n---\r\n';
  const body = '# First\r\n\r\n```md\r\n# Heading in code\r\n```\r\n\r\n## Second\r\nSecond paragraph.';
  const source = properties + body + LEARNING_BOUNDARY + 'Generated learning note';
  const article = planArticleSummary('clipping.md', source);
  assert.equal(article.parts[0].start, properties.length);
  assert.deepEqual(article.parts.map(part => source.slice(part.start, part.end)), [
    '# First\r\n\r\n```md\r\n# Heading in code\r\n```\r\n\r\n', '## Second\r\nSecond paragraph.'
  ]);
  assert.throws(() => planArticleSummary('empty.md', properties), /没有可总结/);
});

test('a heading-free long clipping splits at paragraphs and handles a single oversize paragraph without truncation', () => {
  const paragraphs = Array.from({length: 90}, (_, i) => `Paragraph ${i}. ` + 'The article continues. '.repeat(17).trim());
  const body = paragraphs.join('\n \n');
  const ranges = planArticleSummary('clipping.md', body).parts;
  assert.ok(ranges.length > 1 && ranges.length < paragraphs.length);
  for (const {start, end} of ranges) {
    assert.ok(end - start <= 6000);
    assert.match(body.slice(start, end), /^Paragraph /);
  }
  assert.equal(ranges.map(part => body.slice(part.start, part.end)).join(''), body);

  const unbroken = 'x'.repeat(5999) + '🚀' + 'x'.repeat(12001);
  const pieces = planArticleSummary('single.md', unbroken).parts.map(part => unbroken.slice(part.start, part.end));
  assert.equal(pieces.join(''), unbroken);
  assert.ok(pieces.every(piece => piece.length <= 6000));
  assert.ok(pieces[1].startsWith('🚀'));
});

test('failure retains completed sections, retry sends only remaining body and then the ordered summaries', async () => {
  const article = planArticleSummary('source.md', '---\ntitle: Metadata\n---\n# First\n\nOne.\n\n# Second\n\nTwo.' + LEARNING_BOUNDARY + 'Learning record');
  const inputs: object[] = [];
  const first = {title: '第一节', summary: '第一节内容'};
  const second = {title: '第二节', summary: '第二节内容'};
  const overview = {summary: '全文概览'};
  const transport: Transport = async request => {
    inputs.push(JSON.parse(JSON.parse(request.body as string).messages[1].content));
    const output = [first, {title: '', summary: '无效'}, second, overview][inputs.length - 1];
    return {status: 200, json: {choices: [{finish_reason: 'stop', message: {content: JSON.stringify(output)}}]}};
  };
  let latest: ArticleSummary = article;
  const receive = (update: ArticleSummary) => { latest = update; };
  await assert.rejects(summarizeArticle(article, 'test', transport, async () => {}, receive), /格式异常/);
  assert.deepEqual(latest.sections, [first]);
  assert.equal(latest.overview, undefined);
  await summarizeArticle(latest, 'test', transport, async () => {}, receive);
  assert.deepEqual(inputs, [
    {section: '# First\n\nOne.\n\n'}, {section: '# Second\n\nTwo.'}, {section: '# Second\n\nTwo.'}, {sections: [first, second]}
  ]);
  assert.equal(latest.overview, overview.summary);
});

test('a stopped or changed source cannot publish a response or start the next request', async () => {
  const article = planArticleSummary('source.md', '# First\nOne.\n# Second\nTwo.');
  let current = true;
  let requests = 0;
  const transport: Transport = async () => {
    requests++;
    current = false;
    return {status: 200, json: {choices: [{finish_reason: 'stop', message: {content: '{"title":"一","summary":"第一节"}'}}]}};
  };
  await assert.rejects(summarizeArticle(article, 'test', transport, async () => {
    if (!current) throw new Error('原文已变更');
  }, () => assert.fail('stale result was rendered')), /原文已变更/);
  assert.equal(requests, 1);
});
