// Safe markdown subset for agent text (ui/js/core/markdown.js): escape first, then a fixed set
// of tags. Hostile input must come out as text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../ui/js/core/markdown.js';

test('raw HTML stays escaped', () => {
  const out = renderMarkdown('<script>alert(1)</script>');
  assert.doesNotMatch(out, /<script/i);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const img = renderMarkdown('hi <img src=x onerror=window.__xss=1> there');
  assert.doesNotMatch(img, /<img/i);
  assert.equal(img, '<p>hi &lt;img src=x onerror=window.__xss=1&gt; there</p>');

  assert.equal(renderMarkdown(`"q" & 'a'`), '<p>&quot;q&quot; &amp; &#39;a&#39;</p>');
});

test('links: only http(s) become anchors, with target and rel', () => {
  assert.equal(
    renderMarkdown('[x](https://a.b)'),
    '<p><a href="https://a.b" target="_blank" rel="noopener noreferrer">x</a></p>',
  );
  assert.match(renderMarkdown('see [docs](http://a.b/c?d=1&e=2)'), /<a href="http:\/\/a\.b\/c\?d=1&amp;e=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);

  for (const bad of ['[x](javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x](data:text/html,hi)', '[x](/relative)', '[x](mailto:a@b.c)']) {
    const out = renderMarkdown(bad);
    assert.doesNotMatch(out, /<a\b/i, bad);
    assert.ok(out.includes(bad.replace(/&/g, '&amp;')), `${bad} stays literal: ${out}`);
  }
});

test('a link cannot break out of its href attribute', () => {
  const out = renderMarkdown('[x](https://a.b"onmouseover="alert(1))');
  assert.doesNotMatch(out, /<a [^>]*\sonmouseover=/i);
  assert.doesNotMatch(out, /"onmouseover/);
  const label = renderMarkdown('[<img src=x onerror=1>](https://a.b)');
  assert.doesNotMatch(label, /<img/i);
});

test('bold, italic and inline code', () => {
  assert.equal(renderMarkdown('**b**'), '<p><strong>b</strong></p>');
  assert.equal(renderMarkdown('an *i* word'), '<p>an <em>i</em> word</p>');
  assert.equal(renderMarkdown('run `coldtrail status`'), '<p>run <code>coldtrail status</code></p>');
  assert.equal(renderMarkdown('`**not bold**`'), '<p><code>**not bold**</code></p>');
  assert.equal(renderMarkdown('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
  assert.equal(renderMarkdown('2 * 3 * 4'), '<p>2 * 3 * 4</p>', 'spaced asterisks are not emphasis');
  assert.equal(renderMarkdown('**bold** and *it*'), '<p><strong>bold</strong> and <em>it</em></p>');
});

test('paragraphs on blank lines, single newlines become <br>', () => {
  assert.equal(renderMarkdown('a\n\nb'), '<p>a</p><p>b</p>');
  assert.equal(renderMarkdown('a\nb'), '<p>a<br>b</p>');
  assert.equal(renderMarkdown('a\r\n\r\n\r\nb'), '<p>a</p><p>b</p>');
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
});

test('unordered and ordered lists', () => {
  assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(renderMarkdown('* one\n* **two**'), '<ul><li>one</li><li><strong>two</strong></li></ul>');
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(renderMarkdown('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(
    renderMarkdown('Found:\n- acme.com\n- beta.io\n\nDone.'),
    '<p>Found:</p><ul><li>acme.com</li><li>beta.io</li></ul><p>Done.</p>',
  );
  assert.equal(renderMarkdown('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>', 'list kind change starts a new list');
  assert.equal(renderMarkdown('- a\n  continued'), '<ul><li>a continued</li></ul>', 'indented line continues the item');
  assert.equal(renderMarkdown('- <i>x</i>'), '<ul><li>&lt;i&gt;x&lt;/i&gt;</li></ul>');
});

test('fenced code blocks are escaped and left unformatted', () => {
  assert.equal(
    renderMarkdown('```\n<b>x</b>\n**y**\n```'),
    '<pre><code>&lt;b&gt;x&lt;/b&gt;\n**y**</code></pre>',
  );
  assert.equal(
    renderMarkdown('before\n```sh\ncoldtrail status\n```\nafter'),
    '<p>before</p><pre><code>coldtrail status</code></pre><p>after</p>',
  );
  assert.equal(renderMarkdown('```\nunterminated'), '<pre><code>unterminated</code></pre>');
  assert.equal(renderMarkdown('```js"><script>\nx\n```'), '<pre><code>x</code></pre>', 'info string is dropped');
});

test('headings render as bold paragraphs (no document-outline headings)', () => {
  assert.equal(renderMarkdown('## Summary\nok'), '<p><strong>Summary</strong></p><p>ok</p>');
  assert.equal(renderMarkdown('#nothashtag'), '<p>#nothashtag</p>');
});
