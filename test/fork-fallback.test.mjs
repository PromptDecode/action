import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/annotate.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/sample.sarif', import.meta.url));
const NO_RESULTS = fileURLToPath(new URL('./fixtures/no-results.sarif', import.meta.url));

// The exact workflow commands test/fixtures/sample.sarif must produce: the
// fork-PR fallback is only useful if these lines land on the diff verbatim.
const EXPECTED_ANNOTATIONS = [
  '::error file=src/example.ts,line=12,col=5,endLine=12,endColumn=21,title=bidi-control-character::Found 3 bidi control characters: U+202E, U+202D, U+2066',
  '::warning file=docs/readme.md,line=4,col=1,endLine=4,endColumn=33,title=hidden-html-comment::HTML comment reveals an API key',
  '::notice file=assets/logo.svg,line=1,col=1,endLine=1,endColumn=5,title=zero-width-character::Zero-width space hidden in SVG text',
];

/** Temp directory under the OS temp dir, never inside the workspace. */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pd-annotate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Run bin/annotate.mjs as a child process with GITHUB_OUTPUT and
 * GITHUB_STEP_SUMMARY pointed at temp files.
 *
 * @param {import('node:test').TestContext} t
 * @param {string[]} args Flags after the script path.
 * @returns {Promise<{ code: number, stdout: string, stderr: string, outputs: Record<string, string>, summary: string }>}
 */
async function runAnnotate(t, args) {
  const dir = await tempDir(t);
  const outputFile = join(dir, 'github-output');
  const summaryFile = join(dir, 'step-summary');
  const argv = [BIN, ...args];
  const env = { ...process.env, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile };

  let code = 0;
  let result;
  try {
    result = await execFileAsync(process.execPath, argv, { env });
  } catch (error) {
    code = error.code;
    result = error;
  }
  return {
    code,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    outputs: parseGithubOutput(await readFile(outputFile, 'utf8')),
    summary: await readFile(summaryFile, 'utf8'),
  };
}

/** Parse the `name<<delimiter` heredoc format src/github.mjs writes to GITHUB_OUTPUT. */
function parseGithubOutput(text) {
  /** @type {Record<string, string>} */
  const outputs = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^(.+?)<<(.+)$/.exec(lines[i]);
    if (match === null) continue;
    const [, name, delimiter] = match;
    const values = [];
    i++;
    while (lines[i] !== delimiter) {
      values.push(lines[i]);
      i++;
    }
    outputs[name] = values.join('\n');
  }
  return outputs;
}

/** The stdout lines that are workflow commands, compared whole, never by substring. */
function workflowCommandLines(stdout) {
  return stdout.split('\n').filter((line) => line.startsWith('::'));
}

test('--mode annotate emits the three exact workflow commands for sample.sarif', async (t) => {
  const run = await runAnnotate(t, [
    '--sarif', SAMPLE,
    '--workspace', '/home/runner/work/action/action',
    '--mode', 'annotate',
    '--fail-on', 'none', // verdict asserted separately; keep this run at exit 0
  ]);

  assert.strictEqual(run.code, 0);
  assert.deepStrictEqual(workflowCommandLines(run.stdout), EXPECTED_ANNOTATIONS);
  assert.strictEqual(run.outputs['annotation-mode'], 'workflow-commands');
  assert.strictEqual(run.outputs['results-count'], '3');
  assert.strictEqual(run.outputs['annotations-emitted'], '3');
});

test('the annotate-mode step summary names the fork fallback', async (t) => {
  const run = await runAnnotate(t, ['--sarif', SAMPLE, '--mode', 'annotate', '--fail-on', 'none']);
  assert.strictEqual(run.code, 0);
  assert.match(run.summary, /SARIF upload was unavailable/);
  assert.match(run.summary, /pull request from a fork/);
});

test('exit codes: 1 for --fail-on warning and the default --fail-on error, 0 for none', async (t) => {
  const warning = await runAnnotate(t, ['--sarif', SAMPLE, '--mode', 'annotate', '--fail-on', 'warning']);
  assert.strictEqual(warning.code, 1, 'sample.sarif has warnings, so fail-on warning fails');
  assert.strictEqual(warning.outputs.failed, 'true');

  const byDefault = await runAnnotate(t, ['--sarif', SAMPLE, '--mode', 'annotate']);
  assert.strictEqual(byDefault.code, 1, 'the default fail-on is error and sample.sarif has an error');
  assert.strictEqual(byDefault.outputs.failed, 'true');

  const none = await runAnnotate(t, ['--sarif', SAMPLE, '--mode', 'annotate', '--fail-on', 'none']);
  assert.strictEqual(none.code, 0, 'fail-on none never fails');
  assert.strictEqual(none.outputs.failed, 'false');
});

test('--mode report emits no workflow commands but still writes all five outputs', async (t) => {
  const run = await runAnnotate(t, ['--sarif', SAMPLE, '--workspace', '/tmp', '--mode', 'report']);

  assert.strictEqual(run.code, 1, 'the default fail-on is error and sample.sarif has an error');
  assert.deepStrictEqual(workflowCommandLines(run.stdout), [], 'report mode prints no :: lines');
  assert.deepStrictEqual(Object.keys(run.outputs).sort(), [
    'annotation-mode',
    'annotations-emitted',
    'failed',
    'max-severity',
    'results-count',
  ]);
  assert.strictEqual(run.outputs['annotation-mode'], 'sarif');
  assert.strictEqual(run.outputs['results-count'], '3');
  assert.strictEqual(run.outputs['max-severity'], 'error');
  assert.strictEqual(run.outputs['annotations-emitted'], '0');
  assert.strictEqual(run.outputs.failed, 'true');
  assert.doesNotMatch(run.summary, /SARIF upload was unavailable/, 'no fork-fallback note when uploaded');
});

test('a SARIF with no results passes cleanly, emits nothing, and says so in the summary', async (t) => {
  const run = await runAnnotate(t, ['--sarif', NO_RESULTS, '--mode', 'annotate']);

  assert.strictEqual(run.code, 0);
  assert.deepStrictEqual(workflowCommandLines(run.stdout), [], 'no findings means no :: lines, even in annotate mode');
  assert.strictEqual(run.outputs['results-count'], '0');
  assert.strictEqual(run.outputs['max-severity'], 'none');
  assert.strictEqual(run.outputs['annotation-mode'], 'workflow-commands');
  assert.strictEqual(run.outputs.failed, 'false');
  assert.match(run.summary, /No findings/);
});
