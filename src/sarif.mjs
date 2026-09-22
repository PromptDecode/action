/**
 * Parsing of the SARIF 2.1.0 documents the scanner emits, plus the level
 * arithmetic (maxLevel / shouldFail) the action uses to decide pass or fail.
 *
 * Only the subset of SARIF the scanner can produce is handled, but every
 * access is defensive: a hand-written or future-version SARIF file must
 * never crash the action with a TypeError — at worst it degrades to
 * `'warning'` levels and null locations.
 */

import path from 'node:path';

import { InvalidInputError, SarifParseError } from './errors.mjs';

/** Severity ranks. Higher wins; `shouldFail` compares against these. */
export const SEVERITY_ORDER = { none: 0, note: 1, warning: 2, error: 3 };

const LEVEL_BY_RANK = Object.fromEntries(
  Object.entries(SEVERITY_ORDER).map(([level, rank]) => [rank, level]),
);

const VALID_LEVELS = new Set(Object.keys(SEVERITY_ORDER));

/**
 * Coerce a level string to one of `none|note|warning|error`.
 * Anything unknown (or not a string) degrades to `warning` — an unparseable
 * level must still be surfaced to the user, and warning is the safe middle.
 *
 * @param {unknown} level Raw level value from a result or rule.
 * @returns {'none'|'note'|'warning'|'error'}
 */
function coerceLevel(level) {
  return typeof level === 'string' && VALID_LEVELS.has(level) ? level : 'warning';
}

/**
 * Build a ruleId -> default level map for one run, covering both the classic
 * `tool.driver.rules` and the extension packs in `tool.extensions[].rules`
 * (some scanner distributions ship their rules as extensions).
 *
 * @param {any} run One SARIF run object.
 * @returns {Map<string, string>}
 */
function buildRuleLevelIndex(run) {
  const index = new Map();
  const tool = run?.tool ?? {};
  const ruleGroups = [tool.driver?.rules, ...(Array.isArray(tool.extensions) ? tool.extensions : []).map((extension) => extension?.rules)];
  for (const rules of ruleGroups) {
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      const level = rule?.defaultConfiguration?.level;
      // Only record entries that actually carry a level, so a bare rule
      // declaration in driver.rules cannot shadow a real one in an extension.
      if (typeof rule?.id === 'string' && typeof level === 'string' && !index.has(rule.id)) {
        index.set(rule.id, level);
      }
    }
  }
  return index;
}

/**
 * Turn an artifactLocation.uri into a plain, workspace-relative POSIX path.
 * Handles file:// URIs, percent-encoding, Windows separators, a leading "./"
 * and absolute paths that live under the workspace.
 *
 * @param {string} uri Raw artifactLocation.uri.
 * @param {string} workspace Absolute workspace root to relativise against.
 * @returns {string}
 */
function artifactUriToPath(uri, workspace) {
  let candidate = uri;
  if (candidate.startsWith('file://')) {
    // URL parsing copes with host parts and percent-encoding in one go.
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      // Malformed file URI: fall back to a manual scheme strip.
      candidate = candidate.slice('file://'.length);
      try {
        candidate = decodeURIComponent(candidate);
      } catch {
        /* keep raw */
      }
    }
  } else {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      /* Malformed escape sequence; keep the raw string. */
    }
  }

  candidate = candidate.replaceAll('\\', '/');
  // A file URI's pathname keeps the slash before a drive letter: /C:/x -> C:/x.
  if (/^\/[A-Za-z]:\//.test(candidate)) candidate = candidate.slice(1);
  if (candidate.startsWith('./')) candidate = candidate.slice(2);

  if (path.isAbsolute(candidate)) {
    const relative = path.relative(path.resolve(workspace), candidate);
    // Outside-the-workspace absolute paths (rel starts with "..") stay
    // absolute so the annotation still points at something findable.
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      // path.relative answers with the platform separator; the result is POSIX.
      candidate = relative.split(path.sep).join('/');
    }
  }
  return candidate;
}

/** Region values must be numbers or null; SARIF from odd tools may use strings. */
function lineNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalise one SARIF result into the flat shape the rest of the action uses.
 *
 * @param {any} result Raw SARIF result object.
 * @param {Map<string, string>} ruleLevels Default levels by ruleId for this run.
 * @param {string} workspace Absolute workspace root.
 * @returns {{ ruleId: string|null, level: string, message: string, file: string|null,
 *   startLine: number|null, startColumn: number|null, endLine: number|null, endColumn: number|null }}
 */
function normalizeResult(result, ruleLevels, workspace) {
  // Result level wins; otherwise the rule's default; otherwise warning.
  const level = coerceLevel(result.level ?? ruleLevels.get(result.ruleId) ?? 'warning');

  const message = result.message?.text ?? result.message?.markdown ?? '';

  const physical = result.locations?.[0]?.physicalLocation;
  const uri = physical?.artifactLocation?.uri;
  const region = physical?.region;
  const hasFile = typeof uri === 'string' && uri.length > 0;

  return {
    ruleId: typeof result.ruleId === 'string' ? result.ruleId : null,
    level,
    message: typeof message === 'string' ? message : String(message ?? ''),
    file: hasFile ? artifactUriToPath(uri, workspace) : null,
    startLine: hasFile ? lineNumber(region?.startLine) : null,
    startColumn: hasFile ? lineNumber(region?.startColumn) : null,
    endLine: hasFile ? lineNumber(region?.endLine) : null,
    endColumn: hasFile ? lineNumber(region?.endColumn) : null,
  };
}

/**
 * Parse a SARIF document (JSON string or already-parsed object) into
 * `{ toolName, results }`.
 *
 * @param {string|object} input SARIF 2.1.0 document as a JSON string or object.
 * @param {{ workspace?: string }} [options] Root used to relativise absolute paths;
 *   defaults to the current working directory.
 * @returns {{ toolName: string, results: Array<object> }}
 * @throws {SarifParseError} On invalid JSON or a missing/non-array `runs`.
 */
export function parseSarif(input, { workspace = process.cwd() } = {}) {
  let document = input;
  if (typeof input === 'string') {
    try {
      document = JSON.parse(input);
    } catch (error) {
      throw new SarifParseError(`invalid JSON (${error.message})`);
    }
  }
  if (!document || typeof document !== 'object' || !Array.isArray(document.runs)) {
    throw new SarifParseError('document is missing a "runs" array');
  }

  const resolvedWorkspace = path.resolve(workspace);
  const results = [];
  let toolName;

  for (const run of document.runs) {
    if (!run || typeof run !== 'object') continue;
    if (toolName === undefined && typeof run.tool?.driver?.name === 'string') {
      toolName = run.tool.driver.name;
    }
    const ruleLevels = buildRuleLevelIndex(run);
    for (const result of Array.isArray(run.results) ? run.results : []) {
      if (!result || typeof result !== 'object') continue;
      results.push(normalizeResult(result, ruleLevels, resolvedWorkspace));
    }
  }

  return { toolName: toolName ?? 'promptdecode', results };
}

/**
 * Highest severity present in a list of parsed results.
 *
 * @param {Array<object>} results Parsed results (from `parseSarif`).
 * @returns {'none'|'note'|'warning'|'error'} `'none'` for an empty list.
 */
export function maxLevel(results) {
  let rank = SEVERITY_ORDER.none;
  for (const result of Array.isArray(results) ? results : []) {
    const candidate = SEVERITY_ORDER[result?.level];
    if (typeof candidate === 'number' && candidate > rank) rank = candidate;
  }
  return LEVEL_BY_RANK[rank];
}

/**
 * Whether the run should fail given a fail-on threshold.
 *
 * @param {Array<object>} results Parsed results (from `parseSarif`).
 * @param {'none'|'note'|'warning'|'error'} failOn Severity threshold.
 * @returns {boolean} True when any result is at or above the threshold.
 *   `'none'` never fails.
 * @throws {InvalidInputError} When `failOn` is not one of the four levels.
 */
export function shouldFail(results, failOn) {
  if (typeof failOn !== 'string' || !(failOn in SEVERITY_ORDER)) {
    throw new InvalidInputError(
      `Invalid failOn value ${JSON.stringify(failOn ?? null)}. ` +
        'Valid values are: none, note, warning, error.',
    );
  }
  if (failOn === 'none') return false;
  const threshold = SEVERITY_ORDER[failOn];
  return (Array.isArray(results) ? results : []).some(
    (result) => (SEVERITY_ORDER[result?.level] ?? 0) >= threshold,
  );
}
