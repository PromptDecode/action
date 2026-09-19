import test from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maxLevel, parseSarif, SEVERITY_ORDER, shouldFail } from '../src/sarif.mjs';
import { InvalidInputError, SarifParseError } from '../src/errors.mjs';

const SAMPLE = path.join(import.meta.dirname, 'fixtures', 'sample.sarif');
const NO_RESULTS = path.join(import.meta.dirname, 'fixtures', 'no-results.sarif');

const TEMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'promptdecode-sarif-'));
after(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

/** Minimal single-run SARIF builder for inline fixtures. */
function sarifOf(results, tool = {}) {
  return {
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'promptdecode', ...tool } }, results }],
  };
}

const located = (uri, region) => ({
  locations: [{ physicalLocation: { artifactLocation: { uri }, region } }],
});

test('sample.sarif parses into the exact expected results', () => {
  const { toolName, results } = parseSarif(readFileSync(SAMPLE, 'utf8'));
  assert.strictEqual(toolName, 'promptdecode');
  assert.strictEqual(results.length, 3);
  assert.deepStrictEqual(results[0], {
    ruleId: 'bidi-control-character',
    level: 'error',
    message: 'Found 3 bidi control characters: U+202E, U+202D, U+2066',
    file: 'src/example.ts',
    startLine: 12,
    startColumn: 5,
    endLine: 12,
    endColumn: 21,
  });
  assert.strictEqual(results[1].level, 'warning');
  // Level comes from the rule's defaultConfiguration, not the result.
  assert.strictEqual(results[2].level, 'note');
  assert.strictEqual(results[2].ruleId, 'zero-width-character');
});

test('a result-level overrides the rule default', () => {
  const { results } = parseSarif(
    sarifOf(
      [{ ruleId: 'r', level: 'error', message: { text: 'm' } }],
      { rules: [{ id: 'r', defaultConfiguration: { level: 'note' } }] },
    ),
  );
  assert.strictEqual(results[0].level, 'error');
});

test('level falls back to defaultConfiguration in driver.rules', () => {
  const { results } = parseSarif(
    sarifOf(
      [{ ruleId: 'r', message: { text: 'm' } }],
      { rules: [{ id: 'r', defaultConfiguration: { level: 'note' } }] },
    ),
  );
  assert.strictEqual(results[0].level, 'note');
});

test('level falls back to rules declared under tool.extensions', () => {
  const { results } = parseSarif({
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: { name: 'promptdecode', rules: [{ id: 'other' }] },
          extensions: [{ rules: [{ id: 'ext-rule', defaultConfiguration: { level: 'note' } }] }],
        },
        results: [{ ruleId: 'ext-rule', message: { text: 'm' } }],
      },
    ],
  });
  assert.strictEqual(results[0].level, 'note');
});

test('an unknown level string is coerced to warning', () => {
  const { results } = parseSarif(sarifOf([{ ruleId: 'r', level: 'critical', message: { text: 'm' } }]));
  assert.strictEqual(results[0].level, 'warning');
});

test('a message falls back from text to markdown to empty string', () => {
  const { results } = parseSarif(
    sarifOf([
      { ruleId: 'r', message: { markdown: '**md**' } },
      { ruleId: 'r', message: {} },
      { ruleId: 'r' },
    ]),
  );
  assert.deepStrictEqual(results.map((result) => result.message), ['**md**', '', '']);
});

test('an absolute path under the workspace is relativised', () => {
  const workspace = mkdtempSync(path.join(TEMP_ROOT, 'ws-'));
  const { results } = parseSarif(
    sarifOf([{ ruleId: 'r', message: { text: 'm' }, ...located(path.join(workspace, 'src', 'a.ts'), { startLine: 3 }) }]),
    { workspace },
  );
  assert.strictEqual(results[0].file, 'src/a.ts');
  assert.strictEqual(results[0].startLine, 3);
});

test('an absolute path outside the workspace stays absolute', () => {
  const { results } = parseSarif(
    sarifOf([{ ruleId: 'r', message: { text: 'm' }, ...located('/etc/passwd', { startLine: 1 }) }]),
    { workspace: '/home/me/project' },
  );
  assert.strictEqual(results[0].file, '/etc/passwd');
});

test('a file:// URI is decoded and relativised', () => {
  const { results } = parseSarif(
    sarifOf([{ ruleId: 'r', message: { text: 'm' }, ...located('file:///home/me/project/docs/readme.md', { startLine: 1 }) }]),
    { workspace: '/home/me/project' },
  );
  assert.strictEqual(results[0].file, 'docs/readme.md');
});

test('a percent-encoded URI resolves to its real name (space)', () => {
  const { results } = parseSarif(
    sarifOf([{ ruleId: 'r', message: { text: 'm' }, ...located('file:///home/me/project/my%20notes/a%20b.ts', { startLine: 2 }) }]),
    { workspace: '/home/me/project' },
  );
  assert.strictEqual(results[0].file, 'my notes/a b.ts');
});

test('a percent-encoded relative URI also decodes', () => {
  const { results } = parseSarif(
    sarifOf([{ ruleId: 'r', message: { text: 'm' }, ...located('src/my%20file.ts', { startLine: 1 }) }]),
  );
  assert.strictEqual(results[0].file, 'src/my file.ts');
});

test('backslashes become slashes and a leading ./ is stripped', () => {
  const { results } = parseSarif(
    sarifOf([
      { ruleId: 'r', message: { text: 'm' }, ...located('src\\nested\\win.ts', { startLine: 1 }) },
      { ruleId: 'r', message: { text: 'm' }, ...located('./leading/slash.ts', { startLine: 1 }) },
    ]),
  );
  assert.deepStrictEqual(results.map((result) => result.file), ['src/nested/win.ts', 'leading/slash.ts']);
});

test('a result with no location yields null file and null line/column fields', () => {
  const { results } = parseSarif(sarifOf([{ ruleId: 'r', message: { text: 'm' } }]));
  assert.deepStrictEqual(results[0], {
    ruleId: 'r',
    level: 'warning',
    message: 'm',
    file: null,
    startLine: null,
    startColumn: null,
    endLine: null,
    endColumn: null,
  });
});

test('invalid JSON throws SarifParseError', () => {
  assert.throws(
    () => parseSarif('{"version": "2.1.0", "runs": ['),
    (error) => error instanceof SarifParseError && error.code === 'SARIF_PARSE',
  );
});

test('a missing or non-array runs array throws SarifParseError', () => {
  for (const bad of [{}, { version: '2.1.0' }, { runs: {} }, null, 'just a string', 42]) {
    assert.throws(
      () => parseSarif(bad),
      (error) => error instanceof SarifParseError,
      JSON.stringify(bad),
    );
  }
});

test('results from all runs concatenate and toolName comes from the first run', () => {
  const { toolName, results } = parseSarif({
    version: '2.1.0',
    runs: [
      { tool: { driver: { name: 'toolA' } }, results: [{ ruleId: 'r', level: 'error', message: { text: 'one' } }] },
      { tool: { driver: { name: 'toolB' } }, results: [{ ruleId: 'r', level: 'note', message: { text: 'two' } }] },
    ],
  });
  assert.strictEqual(toolName, 'toolA');
  assert.deepStrictEqual(results.map((result) => result.level), ['error', 'note']);
});

test('toolName falls back to promptdecode when the driver has no name', () => {
  const { toolName } = parseSarif(sarifOf([]));
  assert.strictEqual(toolName, 'promptdecode');
});

test('no-results.sarif parses to an empty result list', () => {
  const { toolName, results } = parseSarif(readFileSync(NO_RESULTS, 'utf8'));
  assert.strictEqual(toolName, 'promptdecode');
  assert.deepStrictEqual(results, []);
});

test('SEVERITY_ORDER ranks none < note < warning < error', () => {
  assert.deepStrictEqual(SEVERITY_ORDER, { none: 0, note: 1, warning: 2, error: 3 });
});

test('maxLevel is none for an empty list and error for a mixed list', () => {
  assert.strictEqual(maxLevel([]), 'none');
  assert.strictEqual(maxLevel(undefined), 'none');
  assert.strictEqual(maxLevel([{ level: 'none' }]), 'none');
  assert.strictEqual(maxLevel([{ level: 'note' }, { level: 'warning' }]), 'warning');
  const { results } = parseSarif(readFileSync(SAMPLE, 'utf8'));
  assert.strictEqual(maxLevel(results), 'error');
});

test('shouldFail honours every threshold, and none never fails', () => {
  const { results } = parseSarif(readFileSync(SAMPLE, 'utf8'));
  assert.strictEqual(shouldFail(results, 'none'), false);
  assert.strictEqual(shouldFail(results, 'note'), true);
  assert.strictEqual(shouldFail(results, 'warning'), true);
  assert.strictEqual(shouldFail(results, 'error'), true);

  // Only the note result would remain if the error/warning were absent.
  const notesOnly = results.filter((result) => result.level === 'note');
  assert.strictEqual(shouldFail(notesOnly, 'none'), false);
  assert.strictEqual(shouldFail(notesOnly, 'note'), true);
  assert.strictEqual(shouldFail(notesOnly, 'warning'), false);
  assert.strictEqual(shouldFail(notesOnly, 'error'), false);

  const { results: noneResults } = parseSarif(readFileSync(NO_RESULTS, 'utf8'));
  for (const failOn of ['none', 'note', 'warning', 'error']) {
    assert.strictEqual(shouldFail(noneResults, failOn), false, failOn);
  }
});

test('shouldFail rejects a bogus threshold with InvalidInputError', () => {
  const { results } = parseSarif(readFileSync(SAMPLE, 'utf8'));
  for (const bogus of ['fatal', 'ERROR', '', null, undefined, 3]) {
    assert.throws(
      () => shouldFail(results, bogus),
      (error) => {
        assert.ok(error instanceof InvalidInputError, String(bogus));
        assert.strictEqual(error.code, 'INVALID_INPUT', String(bogus));
        assert.match(error.message, /none, note, warning, error/);
        return true;
      },
      String(bogus),
    );
  }
});
