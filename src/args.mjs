import { InvalidInputError } from './errors.mjs';

/**
 * Dependency-free argv parser for the action's CLI entry points.
 *
 * Supported forms:
 *   `--flag value`   → flag gets the next token as its value
 *   `--flag=value`   → flag gets the text after "="
 *   `--flag`         → boolean true, but only for flags named in `booleans`
 *                      ("help" is always treated as a boolean)
 *   `--flag=false`   → boolean flags accept exactly "true"/"false" with "="
 *
 * Known flags are exactly what the calling entry point declares: the keys of
 * `defaults`, the names in `booleans`, and `help` (always boolean). Anything
 * else throws instead of being silently ignored. Scoping to the caller — not
 * to a global union of every flag any entry point accepts — is the typo guard:
 * a flag another entry point happens to support (say `--mode` passed to
 * bin/download.mjs) or a typo'd flag (`--verison`) would otherwise parse,
 * change nothing, and hide the problem. A value flag an entry point accepts
 * must appear in its `defaults`, even if only as an empty-string sentinel
 * validated later, as bin/download.mjs does for `--dest`.
 * Positional arguments are not accepted and throw.
 *
 * @param {string[]} argv Raw argv tokens, e.g. `process.argv.slice(2)`.
 * @param {object} [options]
 * @param {string[]} [options.booleans] Flag names that never consume a value.
 * @param {Record<string, boolean|string>} [options.defaults]
 *     Values returned when the flag is absent, and the declaration that a
 *     flag is accepted at all. Boolean flags not covered by a default come
 *     back as `false`.
 * @returns {Record<string, boolean|string>} Defaults overlaid with parsed flags.
 * @throws {InvalidInputError} On unknown flags, missing values, or positional tokens.
 *
 * @example
 * parseArgs(['--version', 'v1.2.3', '--help'], { defaults: { version: 'latest' } })
 * // → { version: 'v1.2.3', help: true }
 */
export function parseArgs(argv, { booleans = [], defaults = {} } = {}) {
  const booleanFlags = new Set([...booleans, 'help']);
  const knownFlags = new Set([...booleanFlags, ...Object.keys(defaults)]);
  /** @type {Record<string, boolean|string>} */
  const result = { ...defaults };
  for (const flag of booleanFlags) {
    if (!(flag in result)) result[flag] = false;
  }

  let i = 0;
  while (i < argv.length) {
    const token = argv[i++];
    if (!token.startsWith('--')) {
      throw new InvalidInputError(
        `Unexpected argument "${token}". This command accepts --flags only, with no positional arguments.`,
      );
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (name === '') {
      throw new InvalidInputError(`Empty flag name in "${token}". Expected --flag, --flag value or --flag=value.`);
    }
    if (!knownFlags.has(name)) {
      const supported = [...knownFlags].sort().map((flag) => `--${flag}`).join(', ');
      throw new InvalidInputError(`Unknown option --${name}. Supported options: ${supported}.`);
    }
    if (eq !== -1) {
      const value = token.slice(eq + 1);
      if (booleanFlags.has(name)) {
        if (value !== 'true' && value !== 'false') {
          throw new InvalidInputError(`--${name} is a boolean flag; use "--${name}" or "--${name}=true|false", not "--${name}=${value}".`);
        }
        result[name] = value === 'true';
      } else {
        result[name] = value;
      }
    } else if (booleanFlags.has(name)) {
      result[name] = true;
    } else if (i < argv.length) {
      result[name] = argv[i++];
    } else {
      throw new InvalidInputError(`--${name} requires a value, e.g. "--${name} <value>".`);
    }
  }
  return result;
}
