/**
 * Markdown rendering for `$GITHUB_STEP_SUMMARY`.
 *
 * The summary is the durable record of a scan: the workflow-command
 * annotations disappear from the diff once the commit is no longer the head
 * of the pull request, but the summary stays on the run. It lists every
 * finding regardless of the annotation cap, and explains the fork fallback
 * when annotations were used instead of Code Scanning.
 */

/** Cell text longer than this is truncated so one huge message cannot bloat the page. */
const MAX_CELL_LENGTH = 200;

/** Stringify anything defensively; null/undefined become ''. */
function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Make a string safe for a GitHub Markdown table cell: newlines become
 * spaces, pipes are escaped as `\|` so finding text cannot break the table,
 * and over-long messages are truncated (before escaping, so the escape
 * itself is never cut in half).
 *
 * @param {unknown} value Raw cell content.
 * @returns {string}
 */
function tableCell(value) {
  let out = text(value).replaceAll('\r', ' ').replaceAll('\n', ' ');
  if (out.length > MAX_CELL_LENGTH) out = `${out.slice(0, MAX_CELL_LENGTH - 1)}…`;
  return out.replaceAll('|', '\\|');
}

/**
 * Render the step summary.
 *
 * @param {object} options
 * @param {string} [options.toolName] Scanner name, as reported by the SARIF tool driver.
 * @param {Array<object>} [options.results] Parsed results from `parseSarif`.
 * @param {'sarif'|'workflow-commands'} [options.mode] How findings were reported.
 * @param {Record<string, number>} [options.omitted] Per-command-kind counts of
 *   annotations dropped at GitHub's per-step cap (from `renderAnnotations`).
 * @param {string} [options.failOn] The fail-on threshold that was applied.
 * @param {boolean} [options.failed] Whether the action decided to fail the run.
 * @returns {string} Markdown (always ends with a newline). Never throws on
 *   odd input — missing fields degrade to defaults.
 */
export function renderSummary({ toolName, results, mode, omitted, failOn, failed } = {}) {
  const findings = Array.isArray(results) ? results : [];
  const name = text(toolName) || 'promptdecode';
  const threshold = text(failOn) || 'warning';

  const counts = { error: 0, warning: 0, note: 0, none: 0 };
  for (const finding of findings) {
    const level = finding?.level;
    if (typeof level === 'string' && level in counts) counts[level] += 1;
  }

  const total = findings.length;
  const breakdown = ['error', 'warning', 'note']
    .filter((level) => counts[level] > 0)
    .map((level) => `${counts[level]} ${level}`)
    .join(', ');

  const lines = [];
  lines.push(`## ${name} scan results`, '');

  if (total === 0) {
    lines.push(`**No findings.** ${name} reported nothing to show.`, '');
  } else {
    lines.push(`**${total} finding${total === 1 ? '' : 's'}** — ${breakdown}.`, '');
  }

  lines.push(
    failed
      ? `**Verdict: failed.** At least one finding is at or above the fail-on threshold (${threshold}).`
      : `**Verdict: passed.** No finding is at or above the fail-on threshold (${threshold}).`,
    '',
  );

  if (total > 0) {
    lines.push('| Location | Level | Rule | Message |', '| --- | --- | --- | --- |');
    for (const finding of findings) {
      const file = text(finding?.file);
      const line = finding?.startLine;
      const location = file === '' ? '(no location)' : line === null || line === undefined ? file : `${file}:${line}`;
      lines.push(
        `| ${tableCell(location)} | ${tableCell(finding?.level)} | ${tableCell(finding?.ruleId)} | ${tableCell(finding?.message)} |`,
      );
    }
    lines.push('');
  }

  if (mode === 'workflow-commands') {
    lines.push(
      '> [!NOTE]',
      '> SARIF upload was unavailable, so these findings could not be attached to the ' +
        'Code Scanning check. This is expected on a pull request from a fork, which cannot be ' +
        'granted `security-events: write`. The findings were emitted as workflow annotation ' +
        'commands (`::error` / `::warning` / `::notice`) instead so they still annotate the diff.',
    );

    const omittedCounts = omitted && typeof omitted === 'object' ? omitted : {};
    const omittedTotal = Object.values(omittedCounts).reduce((sum, count) => sum + (Number(count) || 0), 0);
    if (omittedTotal > 0) {
      const detail = Object.entries(omittedCounts)
        .filter(([, count]) => Number(count) > 0)
        .map(([command, count]) => `${count} ${command}`)
        .join(', ');
      lines.push(
        `> GitHub renders at most 10 annotations of each kind per step, so ${omittedTotal} ` +
          `annotation${omittedTotal === 1 ? ' was' : 's were'} dropped (${detail}). ` +
          'Every finding is listed in the table above.',
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
