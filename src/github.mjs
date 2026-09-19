/**
 * Writers for the two GitHub Actions runner files the action uses:
 * `GITHUB_OUTPUT` (step outputs) and `GITHUB_STEP_SUMMARY`.
 *
 * Both helpers take the environment as an explicit argument (defaulting to
 * `process.env`) so tests can point them at temp files instead of mocking
 * `process.env` or spawning real runners.
 */

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Same recognizable prefix the official actions/toolkit uses. */
const DELIMITER_PREFIX = 'ghadelimiter_';

/**
 * Append a step output to `GITHUB_OUTPUT` using the heredoc (`<<`) syntax.
 *
 * The delimiter is freshly random per call. That is load-bearing: finding
 * text is attacker-controlled (it comes from whatever the scanner saw in the
 * scanned repository), so a crafted message containing a literal
 * `name<<delim` line must not be able to terminate the block early and forge
 * an extra step output. A per-call random UUID cannot be predicted or
 * repeated by the content being written; the regeneration loop is pure
 * paranoia for the astronomically unlikely collision.
 *
 * A no-op when `GITHUB_OUTPUT` is unset (local runs, tests).
 *
 * @param {string} name Output name.
 * @param {string} value Output value; may span multiple lines.
 * @param {{ env?: NodeJS.ProcessEnv }} [options] Environment providing
 *   `GITHUB_OUTPUT`; defaults to `process.env`.
 * @returns {void}
 */
export function setOutput(name, value, { env = process.env } = {}) {
  const file = env?.GITHUB_OUTPUT;
  if (!file) return;

  let delimiter;
  do {
    delimiter = DELIMITER_PREFIX + randomUUID();
  } while (String(value).includes(delimiter));

  appendFileSync(file, `${name}<<${delimiter}\n${String(value)}\n${delimiter}\n`);
}

/**
 * Append Markdown to `$GITHUB_STEP_SUMMARY`.
 *
 * A no-op when `GITHUB_STEP_SUMMARY` is unset (local runs, tests).
 *
 * @param {string} markdown Markdown text to append.
 * @param {{ env?: NodeJS.ProcessEnv }} [options] Environment providing
 *   `GITHUB_STEP_SUMMARY`; defaults to `process.env`.
 * @returns {void}
 */
export function appendSummary(markdown, { env = process.env } = {}) {
  const file = env?.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, markdown);
}
