/**
 * HTTP fetch primitives and the fail-closed download-and-verify pipeline.
 *
 * Everything here is dependency-free: Node's global `fetch` (undici) for HTTP,
 * `node:stream` for streaming a response body to disk without holding the
 * binary in memory. `fetchImpl` is injectable in principle, but the download
 * tests exercise the real code path against a local `node:http` server, so the
 * retry/status logic you see in tests is the logic that runs in production.
 */

import { createWriteStream } from 'node:fs';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseChecksums, expectedFor, verifyFile } from './checksums.mjs';
import { ChecksumMismatchError, ChecksumPinMismatchError, DownloadError } from './errors.mjs';

/** 5xx server errors and 429 (rate limit) are transient; everything else is not. */
function isRetryableStatus(status) {
  return status >= 500 || status === 429;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch `url`, retrying transient failures.
 *
 * Retry semantics: `retries` is the number of retries AFTER the initial
 * attempt, so the URL is requested at most `retries + 1` times. Network
 * errors (DNS, refused, reset — `fetch` throws), HTTP 5xx/429, and failures
 * while reading the body of an otherwise-successful response (a transfer
 * interrupted mid-body) are retried; every other non-2xx status fails
 * immediately, because retrying a 404 cannot make an asset appear. When all
 * attempts are exhausted the last `DownloadError` is thrown, carrying
 * `status` when the failure was HTTP.
 *
 * @param {string} url URL to fetch.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch; defaults to global `fetch`.
 * @param {number} [options.retries] Retries after the initial attempt (default 3).
 * @param {number} [options.retryDelayMs] Sleep between attempts (default 0; tests stay fast).
 * @param {(response: Response) => Promise<T>} [options.consume] When given, a 2xx
 *   response is handed to `consume` inside the retry loop, and a throw while
 *   reading the body (interrupted transfer) is wrapped as a `DownloadError`
 *   without a `status` and retried like any other transient failure.
 * @returns {Promise<Response|T>} The `ok` (2xx) response, or `consume`'s return value.
 * @template T
 * @throws {DownloadError} On non-2xx (with `status`), network failure, or an
 *     interrupted body (no `status`), after retries.
 */
async function fetchOk(url, { fetchImpl = fetch, retries = 3, retryDelayMs = 0, consume = null } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) await sleep(retryDelayMs);
    let response;
    try {
      response = await fetchImpl(url);
    } catch (cause) {
      // Network/DNS/refused: worth another attempt.
      lastError = new DownloadError(url, { cause });
      continue;
    }
    if (response.ok) {
      if (consume === null) return response;
      try {
        return await consume(response);
      } catch (cause) {
        // The body died after a 2xx — a socket reset mid-transfer, say.
        // There was no bad response, so no `status`; the failure is as
        // transient as a refused connection, so: another attempt.
        lastError = new DownloadError(url, {
          cause,
          reason: 'the transfer was interrupted before the body was fully received',
        });
        continue;
      }
    }
    const error = new DownloadError(url, { status: response.status });
    // Drain the body so the socket can be reused or closed cleanly.
    try { await response.arrayBuffer(); } catch { /* already lost */ }
    if (!isRetryableStatus(response.status)) {
      throw error; // A 404 will never become a 200 by asking again.
    }
    lastError = error;
  }
  throw lastError;
}

/**
 * Fetch a URL as UTF-8 text — used for the checksum manifest.
 *
 * @param {string} url URL to fetch.
 * @param {object} [options] See `fetchOk` for `fetchImpl`/`retries`/`retryDelayMs`.
 * @returns {Promise<string>} Response body.
 * @throws {DownloadError} On non-2xx (carrying `status`) or network failure, after retries.
 */
export async function fetchText(url, { fetchImpl = fetch, retries = 3, retryDelayMs = 0 } = {}) {
  const response = await fetchOk(url, { fetchImpl, retries, retryDelayMs });
  return response.text();
}

/**
 * Stream a URL's response body to `destPath`, creating parent directories.
 *
 * The body is piped straight to disk (`stream/promises.pipeline`), so the
 * scanner binary never has to fit in memory. A failure while streaming — a
 * socket reset mid-body, say — surfaces as a rejected promise rather than a
 * truncated file that pretends to be complete: the partial file is removed
 * and the failure is wrapped as a `DownloadError` (no `status`, since the
 * response itself was 2xx) and retried like any other transient failure.
 *
 * @param {string} url URL to download.
 * @param {string} destPath File path to write; missing parent directories are created.
 * @param {object} [options] See `fetchOk` for `fetchImpl`/`retries`/`retryDelayMs`.
 * @returns {Promise<void>} Resolves when the file is fully written.
 * @throws {DownloadError} On non-2xx (carrying `status`), network failure, or an
 *     interrupted transfer (no `status`), after retries. A partial file is never
 *     left at `destPath`.
 */
export async function fetchToFile(url, destPath, { fetchImpl = fetch, retries = 3, retryDelayMs = 0 } = {}) {
  await fetchOk(url, {
    fetchImpl,
    retries,
    retryDelayMs,
    consume: async (response) => {
      await mkdir(dirname(destPath), { recursive: true });
      try {
        await pipeline(Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (response.body)), createWriteStream(destPath));
      } catch (cause) {
        // Never leave a partial behind: what is on disk is a truncated
        // fragment of the response, not a file that could pass verification.
        await unlink(destPath).catch(() => { /* nothing was written (or already gone) */ });
        throw cause; // fetchOk wraps it as a DownloadError and retries.
      }
    },
  });
}

/**
 * Download a release asset and verify it against the release's checksum
 * manifest. Nothing unverified is ever left on disk and no code path proceeds
 * without a verified digest.
 *
 * What this protects against, and what it does not:
 * - It DOES detect corruption in transit, truncation, and an asset that was
 *   swapped or edited relative to the publisher's own checksums.txt — any of
 *   which fails verification, unlinks the file, and fails the run.
 * - It does NOT by itself authenticate the publisher. Whoever controls the
 *   release also controls checksums.txt, so a compromised release could ship
 *   a malicious binary together with a matching malicious manifest and pass
 *   this check. That gap is what the pinnable `expectedSha256` is for: a
 *   digest obtained out of band (from the release notes you actually read, a
 *   signature, a previous verified run) is authoritative, and
 *   `downloadVerified` refuses to download anything when the pin and the
 *   manifest disagree.
 *
 * @param {object} options
 * @param {string} options.binaryUrl URL of the binary asset.
 * @param {string} options.checksumsUrl URL of the checksums.txt manifest.
 * @param {string} options.assetName Asset filename to look up in the manifest.
 * @param {string} options.destPath Full path the binary is written to.
 * @param {string|null} [options.expectedSha256] User-pinned digest; authoritative when set.
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch; defaults to global `fetch`.
 * @param {number} [options.retries] Retries after the initial attempt (default 3).
 * @param {number} [options.retryDelayMs] Sleep between retries (default 0).
 * @returns {Promise<{ path: string, sha256: string }>} The verified file path and its digest.
 * @throws {DownloadError} When the manifest or the binary cannot be fetched (a missing
 *     manifest is a hard failure, never a reason to proceed unverified).
 * @throws {ChecksumParseError} When the manifest cannot be parsed.
 * @throws {ChecksumMissingError} When the manifest does not list the asset.
 * @throws {ChecksumPinMismatchError} When a supplied pin disagrees with the manifest
 *     (refused before the binary is requested at all).
 * @throws {ChecksumMismatchError} When the downloaded bytes do not match the expected
 *     digest (the file is unlinked first).
 */
export async function downloadVerified({
  binaryUrl,
  checksumsUrl,
  assetName,
  destPath,
  expectedSha256 = null,
  fetchImpl = fetch,
  retries = 3,
  retryDelayMs = 0,
}) {
  // 1-2. The manifest comes first and is mandatory: no manifest, no download.
  const manifest = await fetchText(checksumsUrl, { fetchImpl, retries, retryDelayMs });
  const expected = expectedFor(parseChecksums(manifest), assetName);

  // 3. A user-supplied pin is authoritative — but it must agree with the
  //    publisher's manifest, and we refuse before requesting the binary at
  //    all. Nothing has been hashed here, so this is not an expected/actual
  //    checksum mismatch; it is a pin-versus-manifest disagreement, and it
  //    reports itself as one.
  if (expectedSha256 !== null && expectedSha256.toLowerCase() !== expected) {
    throw new ChecksumPinMismatchError({
      path: destPath,
      pinned: expectedSha256,
      manifest: expected,
    });
  }

  // 4. Download, then verify. Any failure from the first byte of the download
  //    onwards — an interrupted transfer, a digest mismatch — unlinks whatever
  //    was written before the error propagates, so an unverified binary is
  //    never left on disk. (`fetchToFile` removes its own partials too; this
  //    is the backstop that makes the invariant hold for every path here.)
  try {
    await fetchToFile(binaryUrl, destPath, { fetchImpl, retries, retryDelayMs });
    await verifyFile(destPath, expected);
  } catch (error) {
    await unlink(destPath).catch(() => { /* nothing extra to fail the run over */ });
    throw error;
  }

  // 5. Only a verified file becomes executable. Windows has no chmod; the
  //    `.exe` is executable by convention.
  if (process.platform !== 'win32') {
    await chmod(destPath, 0o755);
  }
  return { path: destPath, sha256: expected };
}
