import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderSummary } from '../src/summary.mjs';
import { parseSarif } from '../src/sarif.mjs';

const SAMPLE = path.join(import.meta.dirname, 'fixtures', 'sample.sarif');

const sampleResults = () => parseSarif(readFileSync(SAMPLE, 'utf8')).results;

test('the summary names the tool, gives a verdict, and counts each level', () => {
  const markdown = renderSummary({
    toolName: 'promptdecode',
    results: sampleResults(),
    mode: 'workflow-commands',
    failOn: 'warning',
    failed: true,
  });
  assert.ok(markdown.includes('## promptdecode scan results'));
  assert.ok(markdown.includes('3 findings'));
  assert.ok(markdown.includes('1 error'));
  assert.ok(markdown.includes('1 warning'));
  assert.ok(markdown.includes('1 note'));
  assert.ok(markdown.includes('Verdict: failed'));
});

test('the fork-fallback note appears only in workflow-commands mode', () => {
  const results = sampleResults();
  const withCommands = renderSummary({ results, mode: 'workflow-commands', failOn: 'warning', failed: true });
  assert.ok(withCommands.includes('SARIF upload was unavailable'));
  assert.ok(withCommands.includes('security-events'));

  const withSarif = renderSummary({ results, mode: 'sarif', failOn: 'warning', failed: true });
  assert.ok(!withSarif.includes('SARIF upload was unavailable'));
});

test('omitted annotations are reported with per-kind counts', () => {
  const markdown = renderSummary({
    results: sampleResults(),
    mode: 'workflow-commands',
    omitted: { warning: 7 },
    failOn: 'warning',
    failed: false,
  });
  assert.ok(markdown.includes('7 annotation'));
  assert.ok(markdown.includes('7 warning'));
});

test('zero results render a plain statement and no table', () => {
  const markdown = renderSummary({ toolName: 'promptdecode', results: [], mode: 'sarif', failOn: 'warning', failed: false });
  assert.ok(markdown.includes('No findings'));
  assert.ok(markdown.includes('Verdict: passed'));
  assert.ok(!markdown.includes('| Location |'));
  assert.ok(!markdown.includes('| --- |'));
});

test('a message containing a pipe cannot break the findings table', () => {
  const markdown = renderSummary({
    results: [{ ruleId: 'r', level: 'warning', message: 'a | b', file: 'f.ts', startLine: 1 }],
    mode: 'sarif',
    failed: false,
  });
  assert.ok(markdown.includes('a \\| b'));
  for (const row of markdown.split('\n').filter((line) => line.startsWith('|'))) {
    // Escaped pipes (\|) are data, not separators; hide them before counting.
    assert.strictEqual(row.replaceAll('\\|', 'x').split('|').length - 2, 4, row);
  }
});

test('multi-line and over-long messages stay single, bounded cells', () => {
  const markdown = renderSummary({
    results: [
      { ruleId: 'r', level: 'note', message: 'line one\nline two' },
      { ruleId: 'r', level: 'note', message: 'x'.repeat(500) },
    ],
    mode: 'sarif',
    failed: false,
  });
  assert.ok(markdown.includes('line one line two'));
  assert.ok(markdown.includes('…'));
  assert.ok(!markdown.includes('x'.repeat(201)));
});

test('the table lists every finding, file:line first', () => {
  const markdown = renderSummary({ results: sampleResults(), mode: 'sarif', failed: true });
  assert.ok(markdown.includes('| src/example.ts:12 | error | bidi-control-character |'));
  assert.ok(markdown.includes('| docs/readme.md:4 | warning | hidden-html-comment |'));
  assert.ok(markdown.includes('| assets/logo.svg:1 | note | zero-width-character |'));
});

test('renderSummary never throws on missing or odd input', () => {
  assert.doesNotThrow(() => renderSummary({}));
  assert.doesNotThrow(() => renderSummary());
  assert.doesNotThrow(() => renderSummary({ results: undefined, omitted: undefined, mode: 'workflow-commands' }));
  assert.doesNotThrow(() => renderSummary({ results: [null, 42, { level: 'weird' }], mode: 'workflow-commands' }));

  const bare = renderSummary({});
  assert.ok(bare.includes('## promptdecode scan results'));
  assert.ok(bare.includes('No findings'));
  assert.ok(!bare.includes('SARIF upload was unavailable'));
});
