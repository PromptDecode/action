import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { ChecksumParseError, ChecksumMissingError, ChecksumMismatchError } from './errors.mjs';

// sha256sum emits "<64 hex>  <name>" in text mode and "<64 hex> *<name>" in
// binary mode; exactly two characters sit between digest and name.
const LINE_PATTERN = /^([0-9a-fA-F]{64})(?:  |\s\*)(.+)$/;

/**
 * Parse `sha256sum` output into a name → lowercase hex digest map.
 *
 * Accepts both GNU formats (text "  " and binary " *"), strips a leading "./"
 * from names, and ignores blank lines and "#" comments. Anything else is a
 * parse error: a manifest we cannot fully understand cannot be trusted.
 *
 * @param {string} text Full contents of a checksums.txt.
 * @returns {Map<string, string>} Asset name → 64-char lowercase hex digest.
 * @throws {ChecksumParseError} On a malformed line or a duplicate name.
 */
export function parseChecksums(text) {
  /** @type {Map<string, string>} */
  const checksums = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;
    const match = LINE_PATTERN.exec(line);
    if (match === null) {
      throw new ChecksumParseError(line, i + 1);
    }
    const digest = match[1].toLowerCase();
    const name = match[2].replace(/^\.\//, '');
    if (checksums.has(name)) {
      throw new ChecksumParseError(line, i + 1);
    }
    checksums.set(name, digest);
  }
  return checksums;
}

/**
 * Look up the expected digest for an asset — the fail-closed core of the action.
 *
 * A manifest that does not list our asset means nobody attested to what we
 * downloaded. We must fail the run rather than skip verification, so this
 * throws instead of ever returning null or undefined.
 *
 * @param {Map<string, string>} checksums Map from `parseChecksums`.
 * @param {string} name Asset filename to look up.
 * @returns {string} 64-char lowercase hex digest.
 * @throws {ChecksumMissingError} When the manifest does not list the asset.
 */
export function expectedFor(checksums, name) {
  const expected = checksums.get(name);
  if (expected === undefined) {
    throw new ChecksumMissingError(name);
  }
  return expected;
}

/**
 * Compute the sha256 of a file by streaming it, so a large binary never
 * has to fit in memory.
 *
 * @param {string} path File to hash.
 * @returns {Promise<string>} 64-char lowercase hex digest.
 */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Verify a file's digest against the manifest's recorded value.
 *
 * @param {string} path File to verify.
 * @param {string} expectedHex Digest recorded in the manifest; compared case-insensitively.
 * @returns {Promise<void>} Resolves when the digests match.
 * @throws {ChecksumMismatchError} Carrying { path, expected, actual } on a mismatch.
 */
export async function verifyFile(path, expectedHex) {
  const actual = await sha256File(path);
  if (actual !== expectedHex.toLowerCase()) {
    throw new ChecksumMismatchError({ path, expected: expectedHex, actual });
  }
}
