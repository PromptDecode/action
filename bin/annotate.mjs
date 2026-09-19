#!/usr/bin/env node
/**
 * bin/annotate.mjs — report a finished promptdecode scan, and keep it visible
 * when the SARIF upload could not. On a pull request from a fork the token
 * has no `security-events: write`, so github/codeql-action/upload-sarif fails
 * with a 403; in `--mode annotate` this step then re-emits each finding as a
 * `::error` / `::warning` / `::notice` workflow command so it still annotates
 * the diff. A scanner that silently does nothing on fork PRs is worse than
 * useless, because fork PRs are exactly where hostile content arrives — so a
 * missing, unreadable or unparseable SARIF file is a hard failure (exit 2),
 * never a silent pass.
 *
 * Flags match action.yml step 7 ("Report findings, or fall back to workflow
 * annotations") plus the optional overrides documented in --help.
 */

import { readFile } from 'node:fs/promises';

import { parseArgs } from '../src/args.mjs';
import { parseSarif, maxLevel, shouldFail } from '../src/sarif.mjs';
import { renderAnnotations } from '../src/annotations.mjs';
import { renderSummary } from '../src/summary.mjs';
import { setOutput, appendSummary } from '../src/github.mjs';
import { ActionError, InvalidInputError } from '../src/errors.mjs';

const HELP = `Usage: node bin/annotate.mjs --sarif <file> [options]

Report a finished promptdecode scan from its SARIF file, and re-annotate the
pull request when the SARIF upload could not. On a pull request from a fork
the token has no security-events: write, so the upload-sarif step fails; in
--mode annotate this step then emits each finding as a ::error, ::warning or
::notice workflow command so it still annotates the diff.

Flags:
  --sarif <file>        The SARIF 2.1.0 report the scanner wrote (required).
  --workspace <dir>     Root that finding paths are relativised against
                        (default: the current working directory).
  --mode <mode>         "annotate" prints the workflow-command annotations
                        (the fork-PR fallback); "report" prints none, because
                        the uploaded SARIF already produced the check
                        annotations (default: annotate).
  --fail-on <level>     Severity that fails the action: none, note, warning
                        or error (default: error).
  --max-per-level <n>   Cap on workflow commands per severity kind, matching
                        GitHub's per-step annotation limit (default: 10).
  --help                Show this help.

In both modes the Markdown report is appended to $GITHUB_STEP_SUMMARY and the
step outputs results-count, max-severity, annotation-mode, annotations-emitted
and failed are appended to $GITHUB_OUTPUT.

Exit codes:
  0   Passed: no finding is at or above the fail-on threshold.
  1   Failed: at least one finding is at or above the fail-on threshold.
  2   Hard failure: the SARIF file is missing, unreadable or unparseable, or
      the arguments are invalid. A broken scan must never look like a clean
      one, so this is never reported as a passing scan.`;

// Every flag this entry point accepts. Declaring each one in DEFAULTS is what
// makes parseArgs reject another entry point's flags (e.g. --dest) here.
const DEFAULTS = {
  sarif: '',
  workspace: '',
  mode: 'annotate',
  'fail-on': 'error',
  'max-per-level': '10',
};

/** --mode value -> the annotation-mode step output (and summary mode). */
const MODES = { annotate: 'workflow-commands', report: 'sarif' };

async function main() {
  const args = parseArgs(process.argv.slice(2), { defaults: DEFAULTS });

  if (args.help) {
    console.log(HELP);
    return;
  }

  if (typeof args.sarif !== 'string' || args.sarif === '') {
    throw new InvalidInputError(
      '--sarif is required: the path of the SARIF file the scanner wrote.',
    );
  }
  if (typeof args.mode !== 'string' || !(args.mode in MODES)) {
    throw new InvalidInputError(
      `Invalid --mode ${JSON.stringify(args.mode ?? null)}. Valid values are: annotate, report.`,
    );
  }
  const maxPerLevel = Number(args['max-per-level']);
  if (!Number.isInteger(maxPerLevel) || maxPerLevel < 0) {
    throw new InvalidInputError(
      `Invalid --max-per-level ${JSON.stringify(args['max-per-level'] ?? null)}. ` +
        'It must be a non-negative integer.',
    );
  }

  // Hard failure on a missing or unreadable file: degraded input must never
  // degrade into "zero findings", so this is never silently swallowed.
  let raw;
  try {
    raw = await readFile(args.sarif, 'utf8');
  } catch (error) {
    throw new InvalidInputError(
      `Cannot read the SARIF file "${args.sarif}" (${error.code ?? error.message}). ` +
        'A missing, unreadable or unparseable SARIF file is a hard failure, not a clean scan.',
    );
  }

  // Invalid JSON or a missing "runs" array throws SarifParseError, an
  // ActionError: the catch below prints it as one clean line and exits 2.
  const { toolName, results } = parseSarif(raw, {
    workspace: args.workspace === '' ? process.cwd() : args.workspace,
  });

  // In report mode the uploaded SARIF already produced the check annotations,
  // so no workflow commands are emitted and nothing can hit the cap.
  const { lines, omitted } =
    MODES[args.mode] === 'workflow-commands'
      ? renderAnnotations(results, { maxPerLevel })
      : { lines: [], omitted: {} };

  // Validates --fail-on first (a bad value throws InvalidInputError, a usage
  // error) and then decides the verdict from the parsed findings.
  const failed = shouldFail(results, args['fail-on']);

  for (const line of lines) console.log(line);

  const annotationMode = MODES[args.mode];
  appendSummary(
    renderSummary({
      toolName,
      results,
      mode: annotationMode,
      omitted,
      failOn: args['fail-on'],
      failed,
    }),
  );

  setOutput('results-count', String(results.length));
  setOutput('max-severity', maxLevel(results));
  setOutput('annotation-mode', annotationMode);
  setOutput('annotations-emitted', String(lines.length));
  setOutput('failed', failed ? 'true' : 'false');

  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  if (error instanceof ActionError) {
    // Expected failure (bad usage, unreadable or unparseable SARIF): the
    // message alone, no stack trace, exit 2.
    console.error(error.message);
  } else {
    // A bug in the action itself: keep the stack so the report is actionable.
    console.error(error);
  }
  process.exitCode = 2;
});
