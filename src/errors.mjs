/**
 * Typed errors for the whole action.
 *
 * Every error is an `ActionError` carrying a machine-readable `code`
 * (SCREAMING_SNAKE) so callers can branch on `error.code` instead of parsing
 * message text. No module in this action ever calls `process.exit`; it throws
 * these and lets the entry point decide how to fail the run.
 */

/**
 * Base class for every error this action throws.
 */
export class ActionError extends Error {
  /** @type {string} Machine-readable error code, SCREAMING_SNAKE_CASE. */
  code = 'ACTION_ERROR';

  constructor(message) {
    super(message);
    // `new.target` keeps the subclass name even though the constructor runs
    // on the base class, so logs show "ChecksumMismatchError", not "Error".
    this.name = new.target.name;
  }
}

/**
 * The runner's platform or architecture is not one we ship binaries for.
 */
export class UnsupportedPlatformError extends ActionError {
  code = 'UNSUPPORTED_PLATFORM';

  /**
   * @param {string} value The unsupported platform or architecture value, e.g. "freebsd".
   * @param {string} [kind] Either "platform" or "architecture"; defaults to "platform".
   */
  constructor(value, kind = 'platform') {
    super(
      `Unsupported ${kind} "${value}". promptdecode publishes binaries only for ` +
        'linux, darwin (macOS) and windows on amd64 and arm64. ' +
        'Check the runs-on of the job running this action.',
    );
  }
}

/**
 * A workflow input or CLI flag is malformed and cannot be used safely.
 */
export class InvalidInputError extends ActionError {
  code = 'INVALID_INPUT';

  /** @param {string} message What was wrong with the input and what a valid value looks like. */
  constructor(message) {
    super(message);
  }
}

/**
 * checksums.txt could not be parsed, so its contents cannot be trusted.
 */
export class ChecksumParseError extends ActionError {
  code = 'CHECKSUM_PARSE';

  /**
   * @param {string} line The offending line.
   * @param {number} [lineNumber] 1-based position of the line in the manifest.
   */
  constructor(line, lineNumber = 0) {
    super(
      `Invalid checksum entry on line ${lineNumber}: "${line}". Expected ` +
        'sha256sum format "<64-character hex digest>  <filename>" (two spaces). ' +
        'If checksums.txt comes from a custom baseUrl, make sure it was generated with sha256sum.',
    );
  }
}

/**
 * The checksum manifest does not list the asset we downloaded.
 *
 * This is deliberately fatal: an unlisted asset means nobody has attested to
 * what we are about to execute, so the run must fail closed.
 */
export class ChecksumMissingError extends ActionError {
  code = 'CHECKSUM_MISSING';

  /**
   * @param {string} name Asset filename missing from the manifest.
   * @param {string} [manifestName] Display name of the manifest, defaults to "checksums.txt".
   */
  constructor(name, manifestName = 'checksums.txt') {
    super(
      `${manifestName} does not list "${name}". The release manifest is incomplete ` +
        'or the asset was renamed. Refusing to run an unverified binary — check that ' +
        'the release publishes checksums.txt including every platform asset, or pin an older version.',
    );
  }
}

/**
 * The downloaded file's sha256 does not match the recorded digest.
 */
export class ChecksumMismatchError extends ActionError {
  code = 'CHECKSUM_MISMATCH';

  /** @type {string} Path of the file that failed verification. */
  path;
  /** @type {string} Digest recorded in the manifest. */
  expected;
  /** @type {string} Digest we actually computed. */
  actual;

  /**
   * @param {{ path: string, expected: string, actual: string }} detail
   */
  constructor({ path, expected, actual }) {
    super(
      `Checksum mismatch for ${path}: expected sha256 ${expected.toLowerCase()}, ` +
        `got ${actual.toLowerCase()}. The download was corrupted or tampered with. ` +
        'Re-run the workflow; if it fails again, verify the release on GitHub before trusting the binary.',
    );
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The digest the user pinned (--sha256 / the checksum input) disagrees with
 * the digest the release manifest lists for the asset.
 *
 * Deliberately distinct from ChecksumMismatchError: here nothing was ever
 * downloaded or hashed, so the two sides are "the pin you supplied" versus
 * "the digest the release manifest lists", not an expected versus a computed
 * digest. Still fail-closed — nothing is downloaded while they disagree.
 */
export class ChecksumPinMismatchError extends ActionError {
  code = 'CHECKSUM_PIN_MISMATCH';

  /** @type {string} Destination path the pinned download would have had. */
  path;
  /** @type {string} Digest the user pinned. */
  pinned;
  /** @type {string} Digest the release manifest lists for the asset. */
  manifest;

  /**
   * @param {{ path: string, pinned: string, manifest: string }} detail
   */
  constructor({ path, pinned, manifest }) {
    super(
      `The sha256 you pinned does not match the release manifest for ${path}: ` +
        `pinned ${pinned.toLowerCase()}, manifest lists ${manifest.toLowerCase()}. ` +
        'Nothing was downloaded or hashed — the pin and the manifest were compared ' +
        'directly, and the pin is authoritative, so they must agree before anything ' +
        'is fetched. Re-check where the pin came from (it may name a different ' +
        'release or asset), or remove it to trust the release manifest.',
    );
    this.path = path;
    this.pinned = pinned;
    this.manifest = manifest;
  }
}

/**
 * Downloading the binary or checksum manifest failed.
 */
export class DownloadError extends ActionError {
  code = 'DOWNLOAD_FAILED';

  /** @type {string} URL that could not be downloaded. */
  url;
  /** @type {number|null} HTTP status code, when the failure was an HTTP error. */
  status;

  /**
   * @param {string} url URL that could not be downloaded.
   * @param {{ status?: number, cause?: unknown, reason?: string }} [options]
   *   `reason` replaces the default failure description ("HTTP 404" / "a
   *   network or DNS failure") for failures that are neither, e.g. a transfer
   *   interrupted after a 2xx response but before the body was fully received.
   */
  constructor(url, { status, cause, reason } = {}) {
    const why = reason ?? (typeof status === 'number' ? `HTTP ${status}` : 'a network or DNS failure');
    super(
      `Failed to download ${url}: ${why}. Check that the version input points to an ` +
        'existing release with the asset published, and that the runner can reach the ' +
        'host (github.com or your baseUrl).',
    );
    this.url = url;
    this.status = typeof status === 'number' ? status : null;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The tool's output could not be parsed as SARIF.
 *
 * The usual cause is upstream: the scanner wrote something other than valid
 * SARIF 2.1.0 (wrong version pinned, stderr captured into the report, a
 * non-SARIF format at the --sarif path). The message points there first and
 * only asks for a bug report when the file really is valid SARIF.
 */
export class SarifParseError extends ActionError {
  code = 'SARIF_PARSE';

  /**
   * @param {string} [detail] What specifically was wrong with the document.
   */
  constructor(detail = '') {
    super(
      'Could not parse promptdecode output as SARIF' +
        (detail ? `: ${detail}` : '') +
        '. This usually means the scanner wrote something other than valid ' +
        'SARIF 2.1.0: check which scanner version you pinned, and inspect the ' +
        'file at the sarif-file path (a JSON linter is enough) to see what the ' +
        'scanner actually wrote. If the file is valid SARIF 2.1.0 and this ' +
        'action still rejects it, please report it at ' +
        'https://github.com/PromptDecode/action/issues.',
    );
  }
}
