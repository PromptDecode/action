import test from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSummary, setOutput } from '../src/github.mjs';

const TEMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'promptdecode-github-'));
after(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

const tempFile = (label) => {
  const dir = mkdtempSync(path.join(TEMP_ROOT, `${label}-`));
  return path.join(dir, 'file');
};

/**
 * Parse a GITHUB_OUTPUT file the way the runner does: sequentially, a
 * `name<<delimiter` line starts a block and only a line exactly equal to the
 * delimiter ends it — anything in between is data, even if it looks like
 * another heredoc.
 */
function parseOutputs(contents) {
  const lines = contents.split('\n');
  /** @type {Record<string, string>} */
  const outputs = {};
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(.+)<<(.+)$/.exec(lines[i]);
    if (!match) continue;
    const [, name, delimiter] = match;
    const valueLines = [];
    i += 1;
    while (i < lines.length && lines[i] !== delimiter) {
      valueLines.push(lines[i]);
      i += 1;
    }
    outputs[name] = valueLines.join('\n');
  }
  return outputs;
}

test('setOutput writes a heredoc that parses back to the exact value', () => {
  const file = tempFile('output');
  const value = 'first line\nsecond line\nwith, colons: and percents %';
  setOutput('findings', value, { env: { GITHUB_OUTPUT: file } });

  const contents = readFileSync(file, 'utf8');
  assert.match(contents, /^findings<<ghadelimiter_/m);
  assert.deepStrictEqual(parseOutputs(contents), { findings: value });
});

test('each call generates a fresh delimiter and repeated writes accumulate', () => {
  const file = tempFile('output-multi');
  setOutput('a', 'one', { env: { GITHUB_OUTPUT: file } });
  setOutput('b', 'two', { env: { GITHUB_OUTPUT: file } });

  const contents = readFileSync(file, 'utf8');
  const delimiters = [...contents.matchAll(/<<(ghadelimiter_\S+)/g)].map((match) => match[1]);
  assert.strictEqual(new Set(delimiters).size, 2);
  assert.deepStrictEqual(parseOutputs(contents), { a: 'one', b: 'two' });
});

test('a value containing lines that look like a heredoc cannot forge a second output', () => {
  const file = tempFile('forge');
  const forged = [
    'looks harmless',
    'evil<<ghadelimiter_00000000-0000-0000-0000-000000000000',
    'evil=owned',
    'ghadelimiter_00000000-0000-0000-0000-000000000000',
    'still the value',
  ].join('\n');
  setOutput('findings', forged, { env: { GITHUB_OUTPUT: file } });

  const contents = readFileSync(file, 'utf8');
  // The real delimiter must be random, i.e. not the forged one.
  assert.ok(!contents.includes('ghadelimiter_00000000-0000-0000-0000-000000000000<<'));
  const outputs = parseOutputs(contents);
  assert.deepStrictEqual(Object.keys(outputs), ['findings']);
  assert.strictEqual(outputs.findings, forged);
  assert.ok(!('evil' in outputs));
});

test('appendSummary appends to GITHUB_STEP_SUMMARY across calls', () => {
  const file = tempFile('summary');
  writeFileSync(file, '');
  appendSummary('## Heading\n', { env: { GITHUB_STEP_SUMMARY: file } });
  appendSummary('trailer', { env: { GITHUB_STEP_SUMMARY: file } });
  assert.strictEqual(readFileSync(file, 'utf8'), '## Heading\ntrailer');
});

test('appendSummary creates content when the file does not exist yet', () => {
  const file = tempFile('summary-new');
  appendSummary('first', { env: { GITHUB_STEP_SUMMARY: file } });
  assert.strictEqual(readFileSync(file, 'utf8'), 'first');
});

test('both helpers are a no-op when their env var is unset', () => {
  // An env with neither variable set: nothing may be written and nothing thrown.
  assert.doesNotThrow(() => setOutput('findings', 'value', { env: {} }));
  assert.doesNotThrow(() => appendSummary('markdown', { env: {} }));
  // Setting only the *other* variable must not make a helper write to it.
  const other = tempFile('other');
  setOutput('findings', 'value', { env: { GITHUB_STEP_SUMMARY: other } });
  appendSummary('markdown', { env: { GITHUB_OUTPUT: other } });
  assert.strictEqual(readdirSync(path.dirname(other)).length, 0);
  assert.ok(!existsSync(other));
});
