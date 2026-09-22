import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { escapeData, escapeProperty, renderAnnotations, toWorkflowCommand } from '../src/annotations.mjs';
import { parseSarif } from '../src/sarif.mjs';

const SAMPLE = path.join(import.meta.dirname, 'fixtures', 'sample.sarif');

const sampleResults = () => parseSarif(readFileSync(SAMPLE, 'utf8')).results;

test('escapeData escapes percent first, then CR and LF', () => {
  assert.strictEqual(escapeData('100%\r\n'), '100%25%0D%0A');
  assert.strictEqual(escapeData('a%b\rc\nd'), 'a%25b%0Dc%0Ad');
  // A literal "%0A" already in the text must not survive as a newline.
  assert.strictEqual(escapeData('%0A'), '%250A');
});

test('escapeProperty additionally escapes the pair delimiters colon and comma', () => {
  assert.strictEqual(escapeProperty('a:b,c%d\re\nf'), 'a%3Ab%2Cc%25d%0De%0Af');
});

test('the sample findings render as the exact expected workflow commands', () => {
  assert.deepStrictEqual(sampleResults().map(toWorkflowCommand), [
    '::error file=src/example.ts,line=12,col=5,endLine=12,endColumn=21,title=bidi-control-character::' +
      'Found 3 bidi control characters: U+202E, U+202D, U+2066',
    '::warning file=docs/readme.md,line=4,col=1,endLine=4,endColumn=33,title=hidden-html-comment::' +
      'HTML comment reveals an API key',
    '::notice file=assets/logo.svg,line=1,col=1,endLine=1,endColumn=5,title=zero-width-character::' +
      'Zero-width space hidden in SVG text',
  ]);
});

test('each level maps to its command name, none maps to notice', () => {
  const commandFor = (level) => /^::\w+/.exec(toWorkflowCommand({ level, message: 'm' }))[0];
  assert.strictEqual(commandFor('error'), '::error');
  assert.strictEqual(commandFor('warning'), '::warning');
  assert.strictEqual(commandFor('note'), '::notice');
  assert.strictEqual(commandFor('none'), '::notice');
});

test('a result with no location becomes a bare command with no location properties', () => {
  assert.strictEqual(toWorkflowCommand({ level: 'warning', message: 'plain' }), '::warning::plain');
  // Line numbers without a file are meaningless and must be dropped too.
  assert.strictEqual(toWorkflowCommand({ level: 'error', message: 'x', startLine: 3 }), '::error::x');
});

test('properties with null or empty values are omitted individually', () => {
  assert.strictEqual(
    toWorkflowCommand({ level: 'warning', file: 'a.ts', message: 'm' }),
    '::warning file=a.ts::m',
  );
  // A missing ruleId drops the title property but keeps the location.
  assert.strictEqual(
    toWorkflowCommand({ level: 'warning', file: 'a.ts', startLine: 2, ruleId: null, message: 'm' }),
    '::warning file=a.ts,line=2::m',
  );
  // Location and title together, in the fixed order.
  assert.strictEqual(
    toWorkflowCommand({ level: 'error', file: 'a b.ts', startLine: 1, endColumn: 9, ruleId: 'r:1,x', message: 'm' }),
    '::error file=a b.ts,line=1,endColumn=9,title=r%3A1%2Cx::m',
  );
});

test('newlines and percent signs in messages are escaped in the command', () => {
  assert.strictEqual(
    toWorkflowCommand({ level: 'warning', file: 'a.ts', startLine: 1, message: 'one\ntwo\rthree%' }),
    '::warning file=a.ts,line=1::one%0Atwo%0Dthree%25',
  );
});

test('renderAnnotations caps each command kind and reports the remainder per kind', () => {
  const warnings = Array.from({ length: 12 }, (_, i) => ({ level: 'warning', message: `w${i}` }));
  const errors = Array.from({ length: 2 }, (_, i) => ({ level: 'error', message: `e${i}` }));
  const { lines, omitted } = renderAnnotations([...warnings, ...errors]);
  // 10 of the 12 warnings plus both errors survive.
  assert.strictEqual(lines.length, 12);
  assert.strictEqual(lines.filter((line) => line.startsWith('::warning')).length, 10);
  assert.strictEqual(lines.filter((line) => line.startsWith('::error')).length, 2);
  assert.deepStrictEqual(omitted, { warning: 2 });
});

test('renderAnnotations tracks omitted counts for every dropped kind', () => {
  const results = [
    ...Array.from({ length: 11 }, (_, i) => ({ level: 'error', message: `e${i}` })),
    ...Array.from({ length: 11 }, (_, i) => ({ level: 'warning', message: `w${i}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ level: 'note', message: `n${i}` })),
  ];
  const { lines, omitted } = renderAnnotations(results, { maxPerLevel: 10 });
  assert.strictEqual(lines.length, 10 + 10 + 3);
  assert.deepStrictEqual(omitted, { error: 1, warning: 1 });
});

test('renderAnnotations honours a custom cap and nothing is omitted below it', () => {
  const results = Array.from({ length: 4 }, (_, i) => ({ level: 'note', message: `n${i}` }));
  assert.deepStrictEqual(renderAnnotations(results, { maxPerLevel: 4 }), {
    lines: results.map(toWorkflowCommand),
    omitted: {},
  });
  const { lines, omitted } = renderAnnotations(results, { maxPerLevel: 2 });
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(omitted, { notice: 2 });
});

test('renderAnnotations tolerates an empty or missing result list', () => {
  assert.deepStrictEqual(renderAnnotations([]), { lines: [], omitted: {} });
  assert.deepStrictEqual(renderAnnotations(undefined), { lines: [], omitted: {} });
});
