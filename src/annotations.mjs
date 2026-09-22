/**
 * GitHub workflow-command rendering: the `::error` / `::warning` / `::notice`
 * lines that annotate a pull request diff when SARIF upload is unavailable
 * (the normal case on a pull request from a fork, which cannot write
 * security events).
 *
 * Escaping follows GitHub's runner rules exactly — see
 * https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions
 *
 * Data escaping (after the `::` separator):
 *   %  -> %25   (must be first, or later escapes get double-encoded)
 *   \r -> %0D
 *   \n -> %0A
 *
 * Property escaping (in the `key=value` list before the separator) adds the
 * two pair delimiters:
 *   :  -> %3A
 *   ,  -> %2C
 */

/**
 * Escape a workflow-command message (data) section.
 *
 * @param {string} value Raw text.
 * @returns {string} Escaped text safe for the data section.
 */
export function escapeData(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

/**
 * Escape a workflow-command property value.
 *
 * @param {string} value Raw text.
 * @returns {string} Escaped text safe for a `key=value` property.
 */
export function escapeProperty(value) {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/** Workflow-command name per SARIF level; `none` is informational, so notice. */
const COMMAND_FOR_LEVEL = {
  error: 'error',
  warning: 'warning',
  note: 'notice',
  none: 'notice',
};

/**
 * Render one parsed result as a single workflow command, e.g.
 * `::warning file=src/a.ts,line=3,col=1,endLine=3,endColumn=9,title=RULE_ID::message`.
 *
 * Property order is exactly `file,line,col,endLine,endColumn,title`. A
 * property whose value is null or empty is omitted; when `file` is absent the
 * four location properties are dropped entirely (a bare `::warning::message`)
 * because line numbers without a file are meaningless to GitHub.
 *
 * @param {object} result Parsed result from `parseSarif`.
 * @returns {string} A complete `::command props::data` line.
 */
export function toWorkflowCommand(result) {
  const command = COMMAND_FOR_LEVEL[result?.level] ?? 'notice';
  const properties = [];

  const file = result?.file;
  if (file !== null && file !== undefined && file !== '') {
    properties.push(`file=${escapeProperty(file)}`);
    const locationProperties = [
      ['line', result?.startLine],
      ['col', result?.startColumn],
      ['endLine', result?.endLine],
      ['endColumn', result?.endColumn],
    ];
    for (const [name, value] of locationProperties) {
      if (value === null || value === undefined || value === '') continue;
      properties.push(`${name}=${escapeProperty(String(value))}`);
    }
  }

  const title = result?.ruleId;
  if (title !== null && title !== undefined && title !== '') {
    properties.push(`title=${escapeProperty(title)}`);
  }

  const data = escapeData(result?.message ?? '');
  return properties.length > 0 ? `::${command} ${properties.join(',')}::${data}` : `::${command}::${data}`;
}

/**
 * Render workflow commands for a list of results, capping each command kind.
 *
 * GitHub shows at most 10 annotations of each kind (error / warning / notice)
 * per step; emitting more wastes effort because the extras are silently never
 * rendered. Lines beyond the cap are therefore dropped and counted in
 * `omitted` so the step summary can tell the user to check the table instead.
 *
 * @param {Array<object>} results Parsed results from `parseSarif`.
 * @param {{ maxPerLevel?: number }} [options] Cap per command kind; default 10.
 * @returns {{ lines: string[], omitted: Record<string, number> }} Emitted
 *   workflow commands in input order, plus a per-command-kind map of dropped
 *   counts (only kinds with at least one dropped line appear).
 */
export function renderAnnotations(results, { maxPerLevel = 10 } = {}) {
  const lines = [];
  const emitted = new Map();
  /** @type {Record<string, number>} */
  const omitted = {};

  for (const result of Array.isArray(results) ? results : []) {
    const command = COMMAND_FOR_LEVEL[result?.level] ?? 'notice';
    const emittedCount = emitted.get(command) ?? 0;
    if (emittedCount >= maxPerLevel) {
      omitted[command] = (omitted[command] ?? 0) + 1;
      continue;
    }
    emitted.set(command, emittedCount + 1);
    lines.push(toWorkflowCommand(result));
  }

  return { lines, omitted };
}
